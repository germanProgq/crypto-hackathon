// Purpose: run round finalization worker ticks with distributed locking.
import type { FastifyInstance } from "fastify";
import type { ServiceDependencies } from "../../shared/service.js";
import { acquireRedisLock, releaseRedisLock } from "../../shared/storage/redisLock.js";
import {
  mongoCollections,
  type AuctionRoundStateDocument
} from "../../shared/storage/mongoSchemas.js";
import { createRoundFinalizationService } from "../auction-engine/roundFinalizationService.js";

const minFinalizerDelayMs = 50;
const maxFinalizerDelayMs = 2000;
const idleFinalizerDelayMs = 1000;
const finalizerLockTtlMs = 20000;
const finalizerBatchSize = 50;

export async function registerRoundFinalizer(
  app: FastifyInstance,
  deps: ServiceDependencies
): Promise<void> {
  const finalizationService = createRoundFinalizationService(deps);
  let tickInFlight = false;
  let timeout: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (tickInFlight) {
      scheduleNext(minFinalizerDelayMs);
      return;
    }

    tickInFlight = true;
    try {
      const nextDelay = await runFinalizerTick(deps, finalizationService);
      scheduleNext(nextDelay);
    } catch (error) {
      deps.logger.error({ err: error }, "Round finalizer tick failed");
      scheduleNext(idleFinalizerDelayMs);
    } finally {
      tickInFlight = false;
    }
  };

  const scheduleNext = (delayMs: number) => {
    if (timeout) {
      clearTimeout(timeout);
    }
    const clamped = Math.max(minFinalizerDelayMs, Math.min(maxFinalizerDelayMs, delayMs));
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

async function runFinalizerTick(
  deps: ServiceDependencies,
  service: ReturnType<typeof createRoundFinalizationService>
): Promise<number> {
  const roundStates = await deps.mongo.db
    .collection<AuctionRoundStateDocument>(mongoCollections.auctionRoundStates)
    .find({ status: "closed", settlementCompletedAt: { $exists: false } })
    .sort({ closedAt: 1, effectiveEndAt: 1 })
    .limit(finalizerBatchSize)
    .toArray();

  if (roundStates.length === 0) {
    return idleFinalizerDelayMs;
  }

  for (const state of roundStates) {
    const lockKey = buildFinalizerLockKey(state.auctionId.toHexString(), state.roundIndex);
    const lock = await acquireRedisLock(deps.redis, lockKey, finalizerLockTtlMs);
    if (!lock) {
      continue;
    }

    try {
      await service.finalizeRound(state.auctionId, state.roundIndex);
    } finally {
      await releaseRedisLock(deps.redis, lock);
    }
  }

  return roundStates.length >= finalizerBatchSize ? minFinalizerDelayMs : idleFinalizerDelayMs;
}

function buildFinalizerLockKey(auctionId: string, roundIndex: number): string {
  return `auction:${auctionId}:round:${roundIndex}:finalize`;
}
