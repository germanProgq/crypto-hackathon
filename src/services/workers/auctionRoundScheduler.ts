// Auction round scheduling worker with distributed locking.
import type { FastifyInstance } from "fastify";
import type { ObjectId, WithId } from "mongodb";
import type { ServiceDependencies } from "../../shared/service.js";
import { acquireRedisLock, releaseRedisLock } from "../../shared/storage/redisLock.js";
import type { RedisClient } from "../../shared/storage/redis.js";
import {
  buildAuctionSnapshotKey,
  buildRoundLockKey,
  buildRoundStateKey
} from "../auction-engine/auctionKeys.js";
import {
  buildAuctionSnapshotFields,
  buildRoundStateFields,
  roundStateTtlSeconds,
  snapshotTtlSeconds,
  type AuctionSnapshotCache,
  type RoundStateCache
} from "../auction-engine/auctionCache.js";
import { createAuctionRepository } from "../auction-engine/auctionStore.js";
import { deriveAuctionStatus, evaluateRoundTransition } from "../auction-engine/roundStateMachine.js";
import type {
  AuctionDocument,
  AuctionRoundConfig,
  AuctionRoundStateDocument
} from "../../shared/storage/mongoSchemas.js";

const minSchedulerDelayMs = 25;
const maxSchedulerDelayMs = 10000;
const idleSchedulerDelayMs = 2000;
const roundLockTtlMs = 10000;
const dueBatchSize = 200;
const backfillBatchSize = 200;

export async function registerWorkerTasks(
  app: FastifyInstance,
  deps: ServiceDependencies
): Promise<void> {
  const repository = createAuctionRepository(deps.mongo);
  let tickInFlight = false;
  let timeout: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (tickInFlight) {
      scheduleNext(minSchedulerDelayMs);
      return;
    }

    tickInFlight = true;
    try {
      const nextDelay = await runSchedulerTick(deps, repository);
      scheduleNext(nextDelay);
    } catch (error) {
      deps.logger.error({ err: error }, "Round scheduler tick failed");
      scheduleNext(idleSchedulerDelayMs);
    } finally {
      tickInFlight = false;
    }
  };

  const scheduleNext = (delayMs: number) => {
    if (timeout) {
      clearTimeout(timeout);
    }
    const clamped = Math.max(minSchedulerDelayMs, Math.min(maxSchedulerDelayMs, delayMs));
    timeout = setTimeout(() => {
      void tick();
    }, clamped);
  };

  scheduleNext(0);

  app.addHook("onClose", async () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
  });
}

async function runSchedulerTick(
  deps: ServiceDependencies,
  repository: ReturnType<typeof createAuctionRepository>
): Promise<number> {
  const now = new Date();
  await repository.backfillMissingNextTransitionAt(now, backfillBatchSize);

  const dueStates = await repository.listDueRoundStates(now, dueBatchSize);
  const auctionsToUpdate = new Map<string, { id: ObjectId; updatedStates: Array<AuctionRoundStateDocument> }>();

  for (const state of dueStates) {
    const transition = evaluateRoundTransition(state, now);
    if (!transition || transition.status === state.status) {
      await repository.refreshNextTransitionAt(state, now);
      continue;
    }

    const auctionIdText = state.auctionId.toHexString();
    const lockKey = buildRoundLockKey(auctionIdText, state.roundIndex);
    const lock = await acquireRedisLock(deps.redis, lockKey, roundLockTtlMs);
    if (!lock) {
      continue;
    }

    try {
      const updated = await repository.applyRoundTransition(state, transition, now);
      if (updated) {
        const existing = auctionsToUpdate.get(auctionIdText);
        if (existing) {
          existing.updatedStates.push(updated);
        } else {
          auctionsToUpdate.set(auctionIdText, {
            id: state.auctionId,
            updatedStates: [updated]
          });
        }
      }
    } finally {
      await releaseRedisLock(deps.redis, lock);
    }
  }

  for (const entry of auctionsToUpdate.values()) {
    const auction = await repository.getAuctionById(entry.id);
    if (!auction) {
      continue;
    }
    let roundStates = await repository.listRoundStates(auction._id);
    if (roundStates.length !== auction.rounds.length) {
      roundStates = await repository.ensureRoundStates(auction);
    }
    const nextStatus = deriveAuctionStatus(roundStates);
    if (nextStatus !== auction.status) {
      await repository.updateAuctionStatus(auction._id, auction.status, nextStatus, now);
    }

    await updateAuctionCaches(
      deps.redis,
      auction,
      roundStates,
      entry.updatedStates,
      now
    );
  }

  const nextTransitionAt = await repository.getNextTransitionAt();
  if (!nextTransitionAt) {
    return idleSchedulerDelayMs;
  }
  return Math.max(minSchedulerDelayMs, Math.min(maxSchedulerDelayMs, nextTransitionAt.getTime() - now.getTime()));
}

async function updateAuctionCaches(
  redis: RedisClient,
  auction: WithId<AuctionDocument>,
  roundStates: AuctionRoundStateDocument[],
  updatedStates: AuctionRoundStateDocument[],
  now: Date
): Promise<void> {
  if (updatedStates.length === 0) {
    return;
  }

  const roundConfigMap = new Map<number, AuctionRoundConfig>(
    auction.rounds.map((round) => [round.index, round])
  );
  const pipeline = redis.multi();
  let hasOps = false;

  for (const state of updatedStates) {
    const roundConfig = roundConfigMap.get(state.roundIndex);
    if (!roundConfig) {
      continue;
    }
    const roundCache: RoundStateCache = {
      status: state.status,
      roundIndex: state.roundIndex,
      scheduledStartAt: state.scheduledStartAt,
      scheduledEndAt: state.scheduledEndAt,
      effectiveEndAt: state.effectiveEndAt,
      extensionCount: state.extensionCount,
      lastBidAt: state.lastBidAt ?? null,
      startedAt: state.startedAt ?? null,
      closedAt: state.closedAt ?? null,
      allocationSize: roundConfig.allocationSize
    };
    const roundStateKey = buildRoundStateKey(auction._id.toHexString(), state.roundIndex);
    pipeline.hset(roundStateKey, buildRoundStateFields(roundCache, now));
    pipeline.expire(roundStateKey, roundStateTtlSeconds);
    hasOps = true;
  }

  const ordered = [...roundStates].sort((left, right) => left.roundIndex - right.roundIndex);
  const current =
    ordered.find((state) => state.status === "live") ??
    ordered.find((state) => state.status === "scheduled") ??
    ordered[ordered.length - 1] ??
    null;

  if (current) {
    const snapshot: AuctionSnapshotCache = {
      auctionId: auction._id.toHexString(),
      status: auction.status,
      title: auction.title,
      currency: auction.currency,
      currentRoundIndex: current.roundIndex,
      roundStatus: current.status,
      roundEffectiveEndAt: current.effectiveEndAt,
      roundLastBidAt: current.lastBidAt ?? null,
      updatedAt: now,
      lastBidAmount: null
    };
    const snapshotKey = buildAuctionSnapshotKey(auction._id.toHexString());
    pipeline.hset(snapshotKey, buildAuctionSnapshotFields(snapshot));
    pipeline.expire(snapshotKey, snapshotTtlSeconds);
    hasOps = true;
  }

  if (hasOps) {
    await pipeline.exec();
  }
}
