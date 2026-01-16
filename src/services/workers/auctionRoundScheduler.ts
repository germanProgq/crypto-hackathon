// Auction round scheduling worker with distributed locking.
import type { FastifyInstance } from "fastify";
import type { ObjectId } from "mongodb";
import type { ServiceDependencies } from "../../shared/service.js";
import { acquireRedisLock, releaseRedisLock } from "../../shared/storage/redisLock.js";
import { buildRoundLockKey } from "../auction-engine/auctionKeys.js";
import { invalidateActiveAuctionListCache } from "../auction-engine/auctionCache.js";
import { updateAuctionCaches } from "../auction-engine/auctionCacheUpdater.js";
import { createAuctionRepository } from "../auction-engine/auctionStore.js";
import { deriveAuctionStatus, evaluateRoundTransition } from "../auction-engine/roundStateMachine.js";
import { publishRealtimeEvent, toRealtimeSnapshot } from "../../shared/realtime/events.js";
import type { AuctionRoundStateDocument } from "../../shared/storage/mongoSchemas.js";

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
    let lock: Awaited<ReturnType<typeof acquireRedisLock>> | null = null;
    let proceedWithoutLock = false;
    try {
      lock = await acquireRedisLock(deps.redis, lockKey, roundLockTtlMs);
    } catch (error) {
      proceedWithoutLock = true;
      deps.logger.warn({ err: error, lockKey }, "Round scheduler lock unavailable");
    }
    if (!lock && !proceedWithoutLock) {
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
      if (lock) {
        await releaseRedisLock(deps.redis, lock);
      }
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
      deps.logger,
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
