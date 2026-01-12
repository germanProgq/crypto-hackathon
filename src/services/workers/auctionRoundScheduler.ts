// Auction round scheduling worker with distributed locking.
import type { FastifyInstance } from "fastify";
import type { ServiceDependencies } from "../../shared/service.js";
import { acquireRedisLock, releaseRedisLock } from "../../shared/storage/redisLock.js";
import { buildRoundLockKey } from "../auction-engine/auctionKeys.js";
import { createAuctionRepository } from "../auction-engine/auctionStore.js";
import { deriveAuctionStatus, evaluateRoundTransition } from "../auction-engine/roundStateMachine.js";

const schedulerIntervalMs = 200;
const roundLockTtlMs = 10000;
const dueBatchSize = 200;
const backfillBatchSize = 200;

export async function registerWorkerTasks(
  app: FastifyInstance,
  deps: ServiceDependencies
): Promise<void> {
  const repository = createAuctionRepository(deps.mongo);
  let tickInFlight = false;

  const tick = async () => {
    if (tickInFlight) {
      return;
    }

    tickInFlight = true;
    try {
      await runSchedulerTick(deps, repository);
    } catch (error) {
      deps.logger.error({ err: error }, "Round scheduler tick failed");
    } finally {
      tickInFlight = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, schedulerIntervalMs);

  void tick();

  app.addHook("onClose", async () => {
    clearInterval(timer);
  });
}

async function runSchedulerTick(
  deps: ServiceDependencies,
  repository: ReturnType<typeof createAuctionRepository>
): Promise<void> {
  const now = new Date();
  await repository.backfillMissingNextTransitionAt(now, backfillBatchSize);

  const dueStates = await repository.listDueRoundStates(now, dueBatchSize);
  if (dueStates.length === 0) {
    return;
  }

  const auctionsToUpdate = new Map<string, typeof dueStates[number]["auctionId"]>();

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
        auctionsToUpdate.set(auctionIdText, state.auctionId);
      }
    } finally {
      await releaseRedisLock(deps.redis, lock);
    }
  }

  for (const id of auctionsToUpdate.values()) {
    const auction = await repository.getAuctionById(id);
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
  }
}
