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
import { computeExpiresAt, resolveRetentionMs } from "../../shared/storage/retention.js";

const lockTtlMs = 15000;
const batchSize = 50;
const maxAttempts = 5;
const requestTimeoutMs = 8000;
const retryDelaysMs = [5000, 15000, 60000, 300000, 900000];
const minSchedulerDelayMs = 50;
const maxSchedulerDelayMs = 5000;
const idleSchedulerDelayMs = 5000;

type RoundResultPayload = {
  auctionId: string;
  roundIndex: number;
  currency: string;
  result: "winner" | "non_winner";
  amount: number;
  bidId: string;
  rank?: number | null;
  deliveryRef?: string | null;
  deliveryType?: string | null;
  deliveryPayload?: Record<string, unknown> | null;
  replayUrl?: string | null;
  locale?: string;
};

export async function registerNotificationConsumer(
  app: FastifyInstance,
  deps: ServiceDependencies
): Promise<void> {
  ensureTelegramConfig(deps);
  const consumer = createNotificationConsumer(deps);
  const notifications = createNotificationCollection(deps);
  let tickInFlight = false;
  let timeout: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (tickInFlight) {
      scheduleNext(minSchedulerDelayMs);
      return;
    }

    tickInFlight = true;
    try {
      await consumer.processPending();
      scheduleNext(await getNextNotificationDelay(notifications));
    } catch (error) {
      deps.logger.error({ err: error }, "Notification consumer tick failed");
      scheduleNext(idleSchedulerDelayMs);
    } finally {
      tickInFlight = false;
    }
  };

  const scheduleNext = (delayMs: number) => {
    if (timeout) {
      clearTimeout(timeout);
    }
    const clamped = clampDelay(delayMs, minSchedulerDelayMs, maxSchedulerDelayMs);
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

function clampDelay(delayMs: number, minDelayMs: number, maxDelayMs: number): number {
  const clamped = Math.max(minDelayMs, delayMs);
  return Math.min(maxDelayMs, clamped);
}

async function getNextNotificationDelay(
  notifications: ReturnType<typeof createNotificationCollection>
): Promise<number> {
  const now = new Date();
  const next = await notifications
    .find({ status: { $in: ["pending", "failed"] }, attempts: { $lt: maxAttempts } })
    .sort({ nextAttemptAt: 1 })
    .project({ nextAttemptAt: 1 })
    .limit(1)
    .next();

  if (!next?.nextAttemptAt) {
    return idleSchedulerDelayMs;
  }

  if (next.nextAttemptAt <= now) {
    return minSchedulerDelayMs;
  }

  return clampDelay(
    next.nextAttemptAt.getTime() - now.getTime(),
    minSchedulerDelayMs,
    maxSchedulerDelayMs
  );
}

function createNotificationConsumer(deps: ServiceDependencies) {
  const notifications = deps.mongo.db.collection<NotificationQueueDocument>(
    mongoCollections.notificationQueue
  );
  const retentionMs = resolveRetentionMs(deps.config.dataRetention.notificationsDays);

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
        await markSent(notifications, notification._id, retentionMs);
        processed += 1;
      } catch (error) {
        await markFailed(
          notifications,
          notification._id,
          notification.attempts,
          retentionMs,
          error
        );
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
  const locale = resolveLocale(
    (notification.payload.locale as string | undefined) ?? undefined,
    deps.config.i18n.defaultLocale,
    deps.config.i18n.supportedLocales
  );

  let message: string;
  let replyMarkup: Record<string, unknown> | undefined;

  switch (notification.type) {
    case "round_result": {
      const payload = parseRoundResultPayload(notification.payload);
      message = buildRoundResultMessage(locale, payload);
      if (payload.replayUrl) {
        replyMarkup = {
          inline_keyboard: [
            [
              {
                text: t("bot.roundResult.replay", locale),
                url: payload.replayUrl
              }
            ]
          ]
        };
      }
      break;
    }
    case "bid_confirmed":
      message = buildBidConfirmedMessage(locale, parseBidConfirmedPayload(notification.payload));
      break;
    case "withdrawal_broadcasted":
      message = buildWithdrawalBroadcastedMessage(
        locale,
        parseWithdrawalPayload(notification.payload)
      );
      break;
    case "withdrawal_confirmed":
      message = buildWithdrawalConfirmedMessage(
        locale,
        parseWithdrawalPayload(notification.payload)
      );
      break;
    case "withdrawal_failed":
      message = buildWithdrawalFailedMessage(locale, parseWithdrawalPayload(notification.payload));
      break;
    case "auction_starting":
      message = buildAuctionStartingMessage(locale, parseAuctionPayload(notification.payload));
      break;
    case "round_starting":
      message = buildRoundStartingMessage(locale, parseRoundPayload(notification.payload));
      break;
    case "outbid_alert": {
      const payload = parseOutbidPayload(notification.payload);
      const built = buildOutbidMessage(locale, payload);
      message = built.message;
      replyMarkup = built.replyMarkup ?? undefined;
      break;
    }
    default:
      throw new Error(`Unsupported notification type: ${notification.type}.`);
  }

  await sendTelegramMessage(
    deps.config,
    notification.userId,
    message,
    replyMarkup ? { reply_markup: replyMarkup } : undefined
  );
}

async function sendTelegramMessage(
  config: ServiceDependencies["config"],
  chatId: string,
  message: string,
  options?: { reply_markup?: unknown }
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
        disable_web_page_preview: true,
        ...options
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
  id: ObjectId,
  retentionMs: number
): Promise<void> {
  const now = new Date();
  const expiresAt = computeExpiresAt(now, retentionMs);
  const setFields: Record<string, unknown> = {
    status: "sent",
    updatedAt: now,
    nextAttemptAt: now
  };
  if (expiresAt) {
    setFields.expiresAt = expiresAt;
  }
  await notifications.updateOne(
    { _id: id },
    {
      $set: setFields,
      $unset: { lastError: "" },
      $inc: { attempts: 1 }
    }
  );
}

async function markFailed(
  notifications: ReturnType<typeof createNotificationCollection>,
  id: ObjectId,
  attempts: number,
  retentionMs: number,
  error: unknown
): Promise<void> {
  const now = new Date();
  const nextAttempt = Math.min(attempts, retryDelaysMs.length - 1);
  const delayMs = retryDelaysMs[nextAttempt] ?? retryDelaysMs[retryDelaysMs.length - 1] ?? 60000;
  const nextAttemptAt = new Date(now.getTime() + delayMs);
  const expiresAt = computeExpiresAt(now, retentionMs);
  const setFields: Record<string, unknown> = {
    status: "failed",
    nextAttemptAt,
    lastError: getErrorMessage(error),
    updatedAt: now
  };
  if (expiresAt) {
    setFields.expiresAt = expiresAt;
  }
  await notifications.updateOne(
    { _id: id },
    {
      $set: setFields,
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
    const deliveryLine = buildDeliveryLine(locale, payload);
    if (deliveryLine) {
      message = `${message}\n${deliveryLine}`;
    }
    if (payload.replayUrl) {
      const replay = t("bot.roundResult.replayLink", locale, {
        url: payload.replayUrl
      });
      message = `${message}\n${replay}`;
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

function buildDeliveryLine(locale: string, payload: RoundResultPayload): string | null {
  if (!payload.deliveryRef && !payload.deliveryType) {
    return null;
  }
  const type = payload.deliveryType ?? "access_code";
  const deliveryPayload = payload.deliveryPayload ?? {};
  if (type === "telegram_role") {
    const token =
      typeof deliveryPayload.token === "string" ? deliveryPayload.token : payload.deliveryRef;
    const role =
      typeof deliveryPayload.role === "string" ? deliveryPayload.role : "VIP";
    return t("bot.roundResult.delivery.role", locale, { role, token: token ?? "" });
  }
  if (type === "nft_mint") {
    const mintId =
      typeof deliveryPayload.mintId === "string" ? deliveryPayload.mintId : payload.deliveryRef;
    return t("bot.roundResult.delivery.nft", locale, { mintId: mintId ?? "" });
  }
  const code =
    typeof deliveryPayload.code === "string" ? deliveryPayload.code : payload.deliveryRef;
  return t("bot.roundResult.delivery.code", locale, { code: code ?? "" });
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
  const deliveryType = readOptionalString(payload, "deliveryType");
  const deliveryPayload = readOptionalObject(payload, "deliveryPayload");
  const replayUrl = readOptionalString(payload, "replayUrl");

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
    deliveryType,
    deliveryPayload,
    replayUrl,
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

function readOptionalObject(
  payload: Record<string, unknown>,
  key: string
): Record<string, unknown> | null {
  const value = payload[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Notification payload invalid ${key}.`);
  }
  return value as Record<string, unknown>;
}

type BidConfirmedPayload = {
  auctionId: string;
  amount: number;
  currency: string;
};

type WithdrawalPayload = {
  amount: number;
  currency: string;
  txHash?: string;
  error?: string;
};

type AuctionPayload = {
  name: string;
};

type RoundPayload = {
  auctionId: string;
  roundIndex: number;
};

type OutbidPayload = {
  auctionId: string;
  roundIndex: number;
  auctionTitle?: string;
  currency: string;
  previousAmount: number;
  currentAmount: number;
  rebidAmount: number;
  currentLeader?: string;
  bidId?: string;
  replayUrl?: string;
};

function buildBidConfirmedMessage(locale: string, payload: BidConfirmedPayload): string {
  const amount = formatAmount(payload.amount, locale);
  return t("bot.notification.bidConfirmed", locale, {
    auctionId: payload.auctionId,
    amount,
    currency: payload.currency
  });
}

function buildWithdrawalBroadcastedMessage(locale: string, payload: WithdrawalPayload): string {
  const amount = formatAmount(payload.amount, locale);
  return t("bot.notification.withdrawalBroadcasted", locale, {
    amount,
    currency: payload.currency,
    txHash: payload.txHash ?? "pending"
  });
}

function buildWithdrawalConfirmedMessage(locale: string, payload: WithdrawalPayload): string {
  const amount = formatAmount(payload.amount, locale);
  return t("bot.notification.withdrawalConfirmed", locale, {
    amount,
    currency: payload.currency
  });
}

function buildWithdrawalFailedMessage(locale: string, payload: WithdrawalPayload): string {
  const amount = formatAmount(payload.amount, locale);
  return t("bot.notification.withdrawalFailed", locale, {
    amount,
    currency: payload.currency,
    error: payload.error ?? "Unknown error"
  });
}

function buildAuctionStartingMessage(locale: string, payload: AuctionPayload): string {
  return t("bot.notification.auctionStarting", locale, {
    name: payload.name
  });
}

function buildRoundStartingMessage(locale: string, payload: RoundPayload): string {
  const round = payload.roundIndex + 1;
  return t("bot.notification.roundStarting", locale, {
    auctionId: payload.auctionId,
    round
  });
}

function buildOutbidMessage(
  locale: string,
  payload: OutbidPayload
): { message: string; replyMarkup?: Record<string, unknown> } {
  const amount = formatAmount(payload.currentAmount, locale);
  const rebidAmount = formatAmount(payload.rebidAmount, locale);
  const title = payload.auctionTitle ?? payload.auctionId;
  const message = t("bot.outbid.alert", locale, {
    auction: title,
    amount,
    currency: payload.currency,
    rebidAmount
  });
  const buttons: Array<Array<Record<string, string>>> = [
    [
      {
        text: t("bot.outbid.rebid", locale, { amount: rebidAmount, currency: payload.currency }),
        callback_data: `rebid:${payload.auctionId}:${payload.rebidAmount}`
      }
    ]
  ];
  if (payload.replayUrl) {
    buttons.push([{ text: t("bot.roundResult.replay", locale), url: payload.replayUrl }]);
  }
  const replyMarkup = { inline_keyboard: buttons };
  return { message, replyMarkup };
}

function parseBidConfirmedPayload(payload: Record<string, unknown>): BidConfirmedPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("Notification payload missing.");
  }
  return {
    auctionId: readString(payload, "auctionId"),
    amount: readNumber(payload, "amount"),
    currency: readString(payload, "currency")
  };
}

function parseWithdrawalPayload(payload: Record<string, unknown>): WithdrawalPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("Notification payload missing.");
  }
  return {
    amount: readNumber(payload, "amount"),
    currency: readString(payload, "currency"),
    txHash: readOptionalString(payload, "txHash") ?? undefined,
    error: readOptionalString(payload, "error") ?? undefined
  };
}

function parseAuctionPayload(payload: Record<string, unknown>): AuctionPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("Notification payload missing.");
  }
  return {
    name: readString(payload, "name")
  };
}

function parseRoundPayload(payload: Record<string, unknown>): RoundPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("Notification payload missing.");
  }
  return {
    auctionId: readString(payload, "auctionId"),
    roundIndex: readNumber(payload, "roundIndex")
  };
}

function parseOutbidPayload(payload: Record<string, unknown>): OutbidPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("Notification payload missing.");
  }
  return {
    auctionId: readString(payload, "auctionId"),
    roundIndex: readNumber(payload, "roundIndex"),
    auctionTitle: readOptionalString(payload, "auctionTitle") ?? undefined,
    currency: readString(payload, "currency"),
    previousAmount: readNumber(payload, "previousAmount"),
    currentAmount: readNumber(payload, "currentAmount"),
    rebidAmount: readNumber(payload, "rebidAmount"),
    currentLeader: readOptionalString(payload, "currentLeader") ?? undefined,
    bidId: readOptionalString(payload, "bidId") ?? undefined,
    replayUrl: readOptionalString(payload, "replayUrl") ?? undefined
  };
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
