// Purpose: process queued bot notifications and deliver them via Telegram.
import type { FastifyInstance } from "fastify";
import { type WithId, ObjectId } from "mongodb";
import type { ServiceDependencies } from "../../shared/service.js";
import { resolveLocale, t } from "../../shared/i18n/index.js";
import {
  mongoCollections,
  type NotificationQueueDocument
} from "../../shared/storage/mongoSchemas.js";
import { acquireRedisLock, releaseRedisLock } from "../../shared/storage/redisLock.js";

const pollIntervalMs = 1500;
const lockTtlMs = 15000;
const batchSize = 50;
const maxAttempts = 5;
const requestTimeoutMs = 8000;
const retryDelaysMs = [5000, 15000, 60000, 300000, 900000];

type RoundResultPayload = {
  auctionId: string;
  roundIndex: number;
  currency: string;
  result: "winner" | "non_winner";
  amount: number;
  bidId: string;
  rank?: number | null;
  deliveryRef?: string | null;
  locale?: string;
};

export async function registerNotificationConsumer(
  app: FastifyInstance,
  deps: ServiceDependencies
): Promise<void> {
  ensureTelegramConfig(deps);
  const consumer = createNotificationConsumer(deps);
  let tickInFlight = false;

  const tick = async () => {
    if (tickInFlight) {
      return;
    }

    tickInFlight = true;
    try {
      await consumer.processPending();
    } catch (error) {
      deps.logger.error({ err: error }, "Notification consumer tick failed");
    } finally {
      tickInFlight = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, pollIntervalMs);

  void tick();

  app.addHook("onClose", async () => {
    clearInterval(timer);
  });
}

function createNotificationConsumer(deps: ServiceDependencies) {
  const notifications = deps.mongo.db.collection<NotificationQueueDocument>(
    mongoCollections.notificationQueue
  );

  async function processPending(): Promise<number> {
    const now = new Date();
    const batch = await notifications
      .find({
        status: { $in: ["pending", "failed"] },
        nextAttemptAt: { $lte: now },
        attempts: { $lt: maxAttempts }
      })
      .sort({ nextAttemptAt: 1, createdAt: 1 })
      .limit(batchSize)
      .toArray();

    let processed = 0;

    for (const notification of batch) {
      const lockKey = buildNotificationLockKey(notification._id);
      const lock = await acquireRedisLock(deps.redis, lockKey, lockTtlMs);
      if (!lock) {
        continue;
      }

      try {
        await deliverNotification(deps, notification);
        await markSent(notifications, notification._id);
        processed += 1;
      } catch (error) {
        await markFailed(notifications, notification._id, notification.attempts, error);
      } finally {
        await releaseRedisLock(deps.redis, lock);
      }
    }

    return processed;
  }

  return { processPending };
}

async function deliverNotification(
  deps: ServiceDependencies,
  notification: WithId<NotificationQueueDocument>
): Promise<void> {
  if (notification.type !== "round_result") {
    throw new Error(`Unsupported notification type: ${notification.type}.`);
  }

  const payload = parseRoundResultPayload(notification.payload);
  const locale = resolveLocale(
    payload.locale,
    deps.config.i18n.defaultLocale,
    deps.config.i18n.supportedLocales
  );
  const message = buildRoundResultMessage(locale, payload);
  await sendTelegramMessage(deps.config, notification.userId, message);
}

async function sendTelegramMessage(
  config: ServiceDependencies["config"],
  chatId: string,
  message: string
): Promise<void> {
  const token = config.telegram.botToken;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required to send notifications.");
  }

  if (!chatId || chatId.trim().length === 0) {
    throw new Error("Notification chat id is missing.");
  }

  const baseUrl = config.telegram.apiBaseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/bot${token}/sendMessage`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true
      }),
      signal: controller.signal
    });

    const payload = (await response.json().catch(() => null)) as TelegramApiResponse | null;
    if (!response.ok || !payload || payload.ok !== true) {
      const detail =
        payload?.description ||
        payload?.error_code ||
        `${response.status} ${response.statusText}`.trim();
      throw new Error(`Telegram delivery failed: ${detail}.`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function markSent(
  notifications: ReturnType<typeof createNotificationCollection>,
  id: ObjectId
): Promise<void> {
  const now = new Date();
  await notifications.updateOne(
    { _id: id },
    {
      $set: { status: "sent", updatedAt: now, nextAttemptAt: now },
      $unset: { lastError: "" },
      $inc: { attempts: 1 }
    }
  );
}

async function markFailed(
  notifications: ReturnType<typeof createNotificationCollection>,
  id: ObjectId,
  attempts: number,
  error: unknown
): Promise<void> {
  const now = new Date();
  const nextAttempt = Math.min(attempts, retryDelaysMs.length - 1);
  const delayMs = retryDelaysMs[nextAttempt] ?? retryDelaysMs[retryDelaysMs.length - 1] ?? 60000;
  const nextAttemptAt = new Date(now.getTime() + delayMs);
  await notifications.updateOne(
    { _id: id },
    {
      $set: {
        status: "failed",
        nextAttemptAt,
        lastError: getErrorMessage(error),
        updatedAt: now
      },
      $inc: { attempts: 1 }
    }
  );
}

function buildRoundResultMessage(locale: string, payload: RoundResultPayload): string {
  const round = payload.roundIndex + 1;
  const amount = formatAmount(payload.amount, locale);

  if (payload.result === "winner") {
    const rank = payload.rank ?? 0;
    let message = t("bot.roundResult.winner", locale, {
      auctionId: payload.auctionId,
      round,
      rank,
      amount,
      currency: payload.currency
    });
    if (payload.deliveryRef) {
      const delivery = t("bot.roundResult.delivery", locale, {
        deliveryRef: payload.deliveryRef
      });
      message = `${message}\n${delivery}`;
    }
    return message;
  }

  return t("bot.roundResult.nonWinner", locale, {
    auctionId: payload.auctionId,
    round,
    amount,
    currency: payload.currency
  });
}

function formatAmount(amount: number, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 8
  });
  return formatter.format(amount);
}

function parseRoundResultPayload(payload: Record<string, unknown>): RoundResultPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("Notification payload missing.");
  }
  const auctionId = readString(payload, "auctionId");
  const roundIndex = readNumber(payload, "roundIndex");
  const currency = readString(payload, "currency");
  const result = readString(payload, "result");
  const amount = readNumber(payload, "amount");
  const bidId = readString(payload, "bidId");
  const localeValue = readOptionalString(payload, "locale");

  if (result !== "winner" && result !== "non_winner") {
    throw new Error(`Invalid round result type: ${result}.`);
  }

  const rankValue = readOptionalNumber(payload, "rank");
  const deliveryRef = readOptionalString(payload, "deliveryRef");

  if (result === "winner" && (rankValue === null || rankValue <= 0)) {
    throw new Error("Winner notification missing rank.");
  }

  if (!Number.isFinite(roundIndex) || roundIndex < 0) {
    throw new Error("Invalid round index.");
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Invalid notification amount.");
  }

  return {
    auctionId,
    roundIndex,
    currency,
    result,
    amount,
    bidId,
    rank: rankValue,
    deliveryRef,
    locale: localeValue ?? undefined
  };
}

function readString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Notification payload missing ${key}.`);
  }
  return value;
}

function readOptionalString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Notification payload invalid ${key}.`);
  }
  return value;
}

function readNumber(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Notification payload invalid ${key}.`);
  }
  return value;
}

function readOptionalNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Notification payload invalid ${key}.`);
  }
  return value;
}

function buildNotificationLockKey(notificationId: ObjectId): string {
  return `notification:${notificationId.toHexString()}:lock`;
}

function ensureTelegramConfig(deps: ServiceDependencies): void {
  if (!deps.config.telegram.botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required for bot service.");
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown error";
}

type TelegramApiResponse = {
  ok: boolean;
  description?: string;
  error_code?: number;
} & Record<string, unknown>;

function createNotificationCollection(deps: ServiceDependencies) {
  return deps.mongo.db.collection<NotificationQueueDocument>(
    mongoCollections.notificationQueue
  );
}
