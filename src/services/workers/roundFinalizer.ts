// Purpose: run round finalization worker ticks with distributed locking.
import type { FastifyInstance } from "fastify";
import type { ServiceDependencies } from "../../shared/service.js";
import { acquireRedisLock, releaseRedisLock } from "../../shared/storage/redisLock.js";
import {
  mongoCollections,
  type AuctionRoundStateDocument
} from "../../shared/storage/mongoSchemas.js";
import { createRoundFinalizationService } from "../auction-engine/roundFinalizationService.js";

const finalizerIntervalMs = 200;
const finalizerLockTtlMs = 20000;
const finalizerBatchSize = 50;

export async function registerRoundFinalizer(
  app: FastifyInstance,
  deps: ServiceDependencies
): Promise<void> {
  const finalizationService = createRoundFinalizationService(deps);
  let tickInFlight = false;

  const tick = async () => {
    if (tickInFlight) {
      return;
    }

    tickInFlight = true;
    try {
      await runFinalizerTick(deps, finalizationService);
    } catch (error) {
      deps.logger.error({ err: error }, "Round finalizer tick failed");
    } finally {
      tickInFlight = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, finalizerIntervalMs);

  void tick();

  app.addHook("onClose", async () => {
    clearInterval(timer);
  });
}

async function runFinalizerTick(
  deps: ServiceDependencies,
  service: ReturnType<typeof createRoundFinalizationService>
): Promise<void> {
  const roundStates = await deps.mongo.db
    .collection<AuctionRoundStateDocument>(mongoCollections.auctionRoundStates)
    .find({ status: "closed" })
    .sort({ closedAt: 1, effectiveEndAt: 1 })
    .limit(finalizerBatchSize)
    .toArray();

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
}

function buildFinalizerLockKey(auctionId: string, roundIndex: number): string {
  return `auction:${auctionId}:round:${roundIndex}:finalize`;
}
