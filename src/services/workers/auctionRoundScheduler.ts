// Auction round scheduling worker with distributed locking.
import type { FastifyInstance } from "fastify";
import type { ServiceDependencies } from "../../shared/service.js";
import { acquireRedisLock, releaseRedisLock } from "../../shared/storage/redisLock.js";
import { createAuctionRepository } from "../auction-engine/auctionStore.js";
import { deriveAuctionStatus, evaluateRoundTransition } from "../auction-engine/roundStateMachine.js";

const schedulerIntervalMs = 1000;
const roundLockTtlMs = 10000;

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
  const auctions = await repository.listActiveAuctions();

  for (const auction of auctions) {
    const roundStates = await repository.ensureRoundStates(auction);
    const updatedStates = [...roundStates];

    for (let index = 0; index < updatedStates.length; index += 1) {
      const state = updatedStates[index];
      if (!state) {
        continue;
      }

      const transition = evaluateRoundTransition(state, now);
      if (!transition || transition.status === state.status) {
        continue;
      }

      const lockKey = buildRoundLockKey(auction._id.toHexString(), state.roundIndex);
      const lock = await acquireRedisLock(deps.redis, lockKey, roundLockTtlMs);
      if (!lock) {
        continue;
      }

      try {
        const updated = await repository.applyRoundTransition(state, transition, now);
        if (updated) {
          updatedStates[index] = updated;
        }
      } finally {
        await releaseRedisLock(deps.redis, lock);
      }
    }

    const nextStatus = deriveAuctionStatus(updatedStates);
    if (nextStatus !== auction.status) {
      await repository.updateAuctionStatus(auction._id, auction.status, nextStatus, now);
    }
  }
}

function buildRoundLockKey(auctionId: string, roundIndex: number): string {
  return `auction:${auctionId}:round:${roundIndex}:lock`;
}
