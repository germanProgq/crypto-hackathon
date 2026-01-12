// Crypto gateway background tasks for deposits and withdrawals.
import type { FastifyInstance } from "fastify";
import type { ServiceDependencies } from "../../shared/service.js";
import { acquireRedisLock, releaseRedisLock } from "../../shared/storage/redisLock.js";
import { createCryptoGatewayService } from "./cryptoGatewayService.js";

const depositLockTtlMs = 15000;
const withdrawalBroadcastLockTtlMs = 20000;
const withdrawalConfirmLockTtlMs = 20000;

export async function registerCryptoGatewayTasks(
  app: FastifyInstance,
  deps: ServiceDependencies
): Promise<void> {
  const service = createCryptoGatewayService(deps);
  let depositInFlight = false;
  let broadcastInFlight = false;
  let confirmInFlight = false;

  const runDepositTick = async () => {
    if (depositInFlight) {
      return;
    }
    depositInFlight = true;
    try {
      const lock = await acquireRedisLock(deps.redis, "crypto:deposits:lock", depositLockTtlMs);
      if (!lock) {
        return;
      }
      try {
        await service.processDeposits();
      } finally {
        await releaseRedisLock(deps.redis, lock);
      }
    } catch (error) {
      deps.logger.error({ err: error }, "Deposit watcher tick failed");
    } finally {
      depositInFlight = false;
    }
  };

  const runBroadcastTick = async () => {
    if (broadcastInFlight) {
      return;
    }
    broadcastInFlight = true;
    try {
      const lock = await acquireRedisLock(
        deps.redis,
        "crypto:withdrawals:broadcast:lock",
        withdrawalBroadcastLockTtlMs
      );
      if (!lock) {
        return;
      }
      try {
        await service.processAuthorizedWithdrawals();
      } finally {
        await releaseRedisLock(deps.redis, lock);
      }
    } catch (error) {
      deps.logger.error({ err: error }, "Withdrawal broadcast tick failed");
    } finally {
      broadcastInFlight = false;
    }
  };

  const runConfirmTick = async () => {
    if (confirmInFlight) {
      return;
    }
    confirmInFlight = true;
    try {
      const lock = await acquireRedisLock(
        deps.redis,
        "crypto:withdrawals:confirm:lock",
        withdrawalConfirmLockTtlMs
      );
      if (!lock) {
        return;
      }
      try {
        await service.processBroadcastedWithdrawals();
      } finally {
        await releaseRedisLock(deps.redis, lock);
      }
    } catch (error) {
      deps.logger.error({ err: error }, "Withdrawal confirm tick failed");
    } finally {
      confirmInFlight = false;
    }
  };

  const depositTimer = setInterval(
    () => void runDepositTick(),
    deps.config.crypto.deposit.pollIntervalMs
  );
  const broadcastTimer = setInterval(
    () => void runBroadcastTick(),
    deps.config.crypto.withdrawal.broadcastIntervalMs
  );
  const confirmTimer = setInterval(
    () => void runConfirmTick(),
    deps.config.crypto.withdrawal.pollIntervalMs
  );

  void runDepositTick();
  void runBroadcastTick();
  void runConfirmTick();

  app.addHook("onClose", async () => {
    clearInterval(depositTimer);
    clearInterval(broadcastTimer);
    clearInterval(confirmTimer);
  });
}
