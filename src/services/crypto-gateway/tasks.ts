// Crypto gateway background tasks for deposits and withdrawals.
import type { FastifyInstance } from "fastify";
import type { ServiceDependencies } from "../../shared/service.js";
import { acquireRedisLock, releaseRedisLock } from "../../shared/storage/redisLock.js";
import {
  mongoCollections,
  type CryptoDepositDocument,
  type CryptoGatewayStateDocument,
  type CryptoWithdrawalDocument
} from "../../shared/storage/mongoSchemas.js";
import { createCryptoGatewayService } from "./cryptoGatewayService.js";

const depositLockTtlMs = 15000;
const withdrawalBroadcastLockTtlMs = 20000;
const withdrawalConfirmLockTtlMs = 20000;
const minSchedulerDelayMs = 50;
const maxSchedulerDelayMs = 15000;
const idleSchedulerDelayMs = 5000;
const pendingDepositStatuses: Array<CryptoDepositDocument["status"]> = [
  "observed",
  "confirming",
  "confirmed"
];

const clampDelay = (delayMs: number, minDelayMs: number, maxDelayMs: number): number => {
  const clamped = Math.max(minDelayMs, delayMs);
  return Math.min(maxDelayMs, clamped);
};

const pickEarliestDate = (...dates: Array<Date | null | undefined>): Date | null => {
  let earliest: Date | null = null;
  for (const date of dates) {
    if (!date) {
      continue;
    }
    if (!earliest || date.getTime() < earliest.getTime()) {
      earliest = date;
    }
  }
  return earliest;
};

export async function registerCryptoGatewayTasks(
  app: FastifyInstance,
  deps: ServiceDependencies
): Promise<void> {
  const service = createCryptoGatewayService(deps);
  const deposits = deps.mongo.db.collection<CryptoDepositDocument>(
    mongoCollections.cryptoDeposits
  );
  const withdrawals = deps.mongo.db.collection<CryptoWithdrawalDocument>(
    mongoCollections.cryptoWithdrawals
  );
  const gatewayState = deps.mongo.db.collection<CryptoGatewayStateDocument>(
    mongoCollections.cryptoGatewayState
  );

  let depositInFlight = false;
  let broadcastInFlight = false;
  let confirmInFlight = false;
  let depositTimeout: NodeJS.Timeout | null = null;
  let broadcastTimeout: NodeJS.Timeout | null = null;
  let confirmTimeout: NodeJS.Timeout | null = null;

  const scheduleDepositNext = (delayMs: number) => {
    if (depositTimeout) {
      clearTimeout(depositTimeout);
    }
    depositTimeout = setTimeout(() => {
      void runDepositTick();
    }, clampDelay(delayMs, minSchedulerDelayMs, maxSchedulerDelayMs));
  };

  const scheduleBroadcastNext = (delayMs: number) => {
    if (broadcastTimeout) {
      clearTimeout(broadcastTimeout);
    }
    broadcastTimeout = setTimeout(() => {
      void runBroadcastTick();
    }, clampDelay(delayMs, minSchedulerDelayMs, maxSchedulerDelayMs));
  };

  const scheduleConfirmNext = (delayMs: number) => {
    if (confirmTimeout) {
      clearTimeout(confirmTimeout);
    }
    confirmTimeout = setTimeout(() => {
      void runConfirmTick();
    }, clampDelay(delayMs, minSchedulerDelayMs, maxSchedulerDelayMs));
  };

  const getNextDepositDelay = async (): Promise<number> => {
    const now = new Date();
    const dueScan = await gatewayState.findOne(
      {
        key: "deposit",
        $or: [{ nextPollAt: { $lte: now } }, { nextPollAt: { $exists: false } }]
      },
      { projection: { nextPollAt: 1 } }
    );
    if (dueScan) {
      return minSchedulerDelayMs;
    }

    const dueConfirm = await deposits.findOne(
      {
        status: { $in: pendingDepositStatuses },
        $or: [{ nextPollAt: { $lte: now } }, { nextPollAt: { $exists: false } }]
      },
      { projection: { nextPollAt: 1 } }
    );
    if (dueConfirm) {
      return minSchedulerDelayMs;
    }

    const nextScan = await gatewayState
      .find({ key: "deposit", nextPollAt: { $exists: true } })
      .sort({ nextPollAt: 1 })
      .project({ nextPollAt: 1 })
      .limit(1)
      .next();

    const nextConfirm = await deposits
      .find({ status: { $in: pendingDepositStatuses }, nextPollAt: { $exists: true } })
      .sort({ nextPollAt: 1 })
      .project({ nextPollAt: 1 })
      .limit(1)
      .next();

    const nextAt = pickEarliestDate(nextScan?.nextPollAt, nextConfirm?.nextPollAt);
    if (!nextAt) {
      return idleSchedulerDelayMs;
    }

    return clampDelay(nextAt.getTime() - now.getTime(), minSchedulerDelayMs, maxSchedulerDelayMs);
  };

  const getNextWithdrawalDelay = async (
    status: "authorized" | "broadcasted"
  ): Promise<number> => {
    const now = new Date();
    const due = await withdrawals.findOne(
      {
        status,
        $or: [{ nextPollAt: { $lte: now } }, { nextPollAt: { $exists: false } }]
      },
      { projection: { nextPollAt: 1 } }
    );
    if (due) {
      return minSchedulerDelayMs;
    }

    const next = await withdrawals
      .find({ status, nextPollAt: { $exists: true } })
      .sort({ nextPollAt: 1 })
      .project({ nextPollAt: 1 })
      .limit(1)
      .next();

    if (!next?.nextPollAt) {
      return idleSchedulerDelayMs;
    }

    return clampDelay(
      next.nextPollAt.getTime() - now.getTime(),
      minSchedulerDelayMs,
      maxSchedulerDelayMs
    );
  };

  const runDepositTick = async () => {
    if (depositInFlight) {
      scheduleDepositNext(minSchedulerDelayMs);
      return;
    }
    depositInFlight = true;
    try {
      const lock = await acquireRedisLock(deps.redis, "crypto:deposits:lock", depositLockTtlMs);
      if (lock) {
        try {
          await service.processDeposits({ force: false });
        } finally {
          await releaseRedisLock(deps.redis, lock);
        }
      }
      scheduleDepositNext(await getNextDepositDelay());
    } catch (error) {
      deps.logger.error({ err: error }, "Deposit watcher tick failed");
      scheduleDepositNext(idleSchedulerDelayMs);
    } finally {
      depositInFlight = false;
    }
  };

  const runBroadcastTick = async () => {
    if (broadcastInFlight) {
      scheduleBroadcastNext(minSchedulerDelayMs);
      return;
    }
    broadcastInFlight = true;
    try {
      const lock = await acquireRedisLock(
        deps.redis,
        "crypto:withdrawals:broadcast:lock",
        withdrawalBroadcastLockTtlMs
      );
      if (lock) {
        try {
          await service.processAuthorizedWithdrawals({ force: false });
        } finally {
          await releaseRedisLock(deps.redis, lock);
        }
      }
      scheduleBroadcastNext(await getNextWithdrawalDelay("authorized"));
    } catch (error) {
      deps.logger.error({ err: error }, "Withdrawal broadcast tick failed");
      scheduleBroadcastNext(idleSchedulerDelayMs);
    } finally {
      broadcastInFlight = false;
    }
  };

  const runConfirmTick = async () => {
    if (confirmInFlight) {
      scheduleConfirmNext(minSchedulerDelayMs);
      return;
    }
    confirmInFlight = true;
    try {
      const lock = await acquireRedisLock(
        deps.redis,
        "crypto:withdrawals:confirm:lock",
        withdrawalConfirmLockTtlMs
      );
      if (lock) {
        try {
          await service.processBroadcastedWithdrawals({ force: false });
        } finally {
          await releaseRedisLock(deps.redis, lock);
        }
      }
      scheduleConfirmNext(await getNextWithdrawalDelay("broadcasted"));
    } catch (error) {
      deps.logger.error({ err: error }, "Withdrawal confirm tick failed");
      scheduleConfirmNext(idleSchedulerDelayMs);
    } finally {
      confirmInFlight = false;
    }
  };

  scheduleDepositNext(0);
  scheduleBroadcastNext(0);
  scheduleConfirmNext(0);

  app.addHook("onClose", async () => {
    if (depositTimeout) {
      clearTimeout(depositTimeout);
      depositTimeout = null;
    }
    if (broadcastTimeout) {
      clearTimeout(broadcastTimeout);
      broadcastTimeout = null;
    }
    if (confirmTimeout) {
      clearTimeout(confirmTimeout);
      confirmTimeout = null;
    }
  });
}
