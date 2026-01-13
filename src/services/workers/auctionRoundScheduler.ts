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
  invalidateActiveAuctionListCache,
  primeAuctionSnapshotCache,
  primeRoundStateCache,
  roundStateTtlSeconds,
  snapshotTtlSeconds,
  type AuctionSnapshotCache,
  type RoundStateCache
} from "../auction-engine/auctionCache.js";
import { createAuctionRepository } from "../auction-engine/auctionStore.js";
import { deriveAuctionStatus, evaluateRoundTransition } from "../auction-engine/roundStateMachine.js";
import { publishRealtimeEvent, toRealtimeSnapshot } from "../../shared/realtime/events.js";
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
    const statusChanged = nextStatus !== auction.status;
    let statusUpdated = false;
    if (statusChanged) {
      statusUpdated = await repository.updateAuctionStatus(
        auction._id,
        auction.status,
        nextStatus,
        now
      );
    }
    if (statusChanged) {
      try {
        await invalidateActiveAuctionListCache(deps.redis);
      } catch (error) {
        deps.logger.warn({ err: error }, "Failed to invalidate auction list cache");
      }
    }

    const cacheAuction = statusUpdated ? { ...auction, status: nextStatus } : auction;
    const snapshot = await updateAuctionCaches(
      deps.redis,
      repository,
      cacheAuction,
      roundStates,
      entry.updatedStates,
      now
    );
    if (statusChanged) {
      try {
        await publishRealtimeEvent(deps.redis, {
          type: "auction.list.updated",
          auctionId: auction._id.toHexString(),
          reason: "status_changed"
        });
      } catch (error) {
        deps.logger.warn({ err: error }, "Failed to publish auction list update");
      }
    }
    if (snapshot) {
      try {
        await publishRealtimeEvent(deps.redis, {
          type: "auction.snapshot.updated",
          auctionId: snapshot.auctionId,
          snapshot: toRealtimeSnapshot({ ...snapshot, serverTime: now })
        });
      } catch (error) {
        deps.logger.warn({ err: error }, "Failed to publish auction snapshot update");
      }
    }
  }

  const nextTransitionAt = await repository.getNextTransitionAt();
  if (!nextTransitionAt) {
    return idleSchedulerDelayMs;
  }
  return Math.max(minSchedulerDelayMs, Math.min(maxSchedulerDelayMs, nextTransitionAt.getTime() - now.getTime()));
}

async function updateAuctionCaches(
  redis: RedisClient,
  repository: ReturnType<typeof createAuctionRepository>,
  auction: WithId<AuctionDocument>,
  roundStates: AuctionRoundStateDocument[],
  updatedStates: AuctionRoundStateDocument[],
  now: Date
): Promise<AuctionSnapshotCache | null> {
  if (updatedStates.length === 0) {
    return null;
  }

  const roundConfigMap = new Map<number, AuctionRoundConfig>(
    auction.rounds.map((round) => [round.index, round])
  );
  const pipeline = redis.multi();
  const auctionIdText = auction._id.toHexString();
  const roundStatesToPrime: RoundStateCache[] = [];
  let snapshotToPrime: AuctionSnapshotCache | null = null;
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
    roundStatesToPrime.push(roundCache);
    const roundStateKey = buildRoundStateKey(auctionIdText, state.roundIndex);
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

  const snapshotRoundIndex = current?.roundIndex ?? null;
  const snapshotRoundStatus = current?.status ?? null;
  const snapshotRoundEffectiveEndAt = current?.effectiveEndAt ?? null;
  const snapshotRoundLastBidAt = current?.lastBidAt ?? null;

  if (current) {
    const snapshot: AuctionSnapshotCache = {
      auctionId: auctionIdText,
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
    snapshotToPrime = snapshot;
    const snapshotKey = buildAuctionSnapshotKey(auctionIdText);
    pipeline.hset(snapshotKey, buildAuctionSnapshotFields(snapshot));
    pipeline.expire(snapshotKey, snapshotTtlSeconds);
    hasOps = true;
  }

  await repository.updateAuctionSnapshot(
    auction._id,
    {
      currentRoundIndex: snapshotRoundIndex,
      roundStatus: snapshotRoundStatus,
      roundEffectiveEndAt: snapshotRoundEffectiveEndAt,
      roundLastBidAt: snapshotRoundLastBidAt,
      lastBidAmount: null
    },
    now
  );

  if (hasOps) {
    await pipeline.exec();
    for (const state of roundStatesToPrime) {
      primeRoundStateCache(auctionIdText, state);
    }
    if (snapshotToPrime) {
      primeAuctionSnapshotCache(snapshotToPrime);
    }
  }
  return snapshotToPrime;
}
