// Webhook notification dispatcher with retry logic and signature verification
import { createHmac, randomUUID } from "crypto";
import type { Logger } from "pino";
import type { Redis } from "ioredis";
import type { Db } from "mongodb";
import { mongoCollections } from "../../shared/storage/mongoSchemas.js";

export type WebhookEventType =
  | "bid_placed"
  | "bid_outbid"
  | "round_started"
  | "round_ended"
  | "round_finalized"
  | "auction_created"
  | "auction_started"
  | "auction_ended"
  | "deposit_confirmed"
  | "withdrawal_completed"
  | "withdrawal_failed";

export interface WebhookConfig {
  _id?: string;
  userId: string;
  url: string;
  secret: string;
  events: WebhookEventType[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastDeliveryAt?: Date;
  failureCount: number;
}

export interface WebhookDelivery {
  _id?: string;
  webhookId: string;
  eventType: WebhookEventType;
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "failed" | "retrying";
  attempts: number;
  maxAttempts: number;
  lastAttemptAt?: Date;
  nextAttemptAt?: Date;
  responseStatus?: number;
  responseBody?: string;
  error?: string;
  createdAt: Date;
  deliveredAt?: Date;
}

interface WebhookDispatcherDeps {
  db: Db;
  redis: Redis;
  logger: Logger;
}

const MAX_RETRY_ATTEMPTS = 5;
const RETRY_DELAYS = [1000, 5000, 30000, 120000, 600000]; // 1s, 5s, 30s, 2m, 10m

export function createWebhookDispatcher(deps: WebhookDispatcherDeps) {
  const { db, redis, logger } = deps;
  const webhooks = db.collection<WebhookConfig>("webhook_configs");
  const deliveries = db.collection<WebhookDelivery>("webhook_deliveries");

  // Ensure indexes
  webhooks.createIndex({ userId: 1 }).catch(() => {});
  webhooks.createIndex({ events: 1, active: 1 }).catch(() => {});
  deliveries.createIndex({ status: 1, nextAttemptAt: 1 }).catch(() => {});
  deliveries.createIndex({ webhookId: 1, createdAt: -1 }).catch(() => {});

  return {
    /**
     * Register a new webhook endpoint
     */
    async registerWebhook(config: Omit<WebhookConfig, "_id" | "createdAt" | "updatedAt" | "failureCount">): Promise<WebhookConfig> {
      const now = new Date();
      const webhook: WebhookConfig = {
        ...config,
        failureCount: 0,
        createdAt: now,
        updatedAt: now
      };

      const result = await webhooks.insertOne(webhook);
      logger.info({ webhookId: result.insertedId, userId: config.userId }, "Webhook registered");
      
      return { ...webhook, _id: String(result.insertedId) };
    },

    /**
     * Update webhook configuration
     */
    async updateWebhook(webhookId: string, updates: Partial<Pick<WebhookConfig, "url" | "secret" | "events" | "active">>): Promise<void> {
      await webhooks.updateOne(
        { _id: webhookId as any },
        { $set: { ...updates, updatedAt: new Date() } }
      );
    },

    /**
     * Delete webhook
     */
    async deleteWebhook(webhookId: string): Promise<void> {
      await webhooks.deleteOne({ _id: webhookId as any });
      logger.info({ webhookId }, "Webhook deleted");
    },

    /**
     * List webhooks for a user
     */
    async listWebhooks(userId: string): Promise<WebhookConfig[]> {
      return webhooks.find({ userId }).toArray();
    },

    /**
     * Dispatch an event to all subscribed webhooks
     */
    async dispatch(eventType: WebhookEventType, payload: Record<string, unknown>): Promise<void> {
      const subscribers = await webhooks
        .find({ events: eventType, active: true })
        .toArray();

      if (subscribers.length === 0) {
        return;
      }

      logger.debug({ eventType, subscriberCount: subscribers.length }, "Dispatching webhook event");

      const deliveryDocs: WebhookDelivery[] = subscribers.map(webhook => ({
        webhookId: webhook._id!.toString(),
        eventType,
        payload,
        status: "pending",
        attempts: 0,
        maxAttempts: MAX_RETRY_ATTEMPTS,
        createdAt: new Date()
      }));

      await deliveries.insertMany(deliveryDocs);

      // Queue for immediate processing
      const queueKey = "webhook:delivery:queue";
      await redis.lpush(queueKey, ...deliveryDocs.map(d => JSON.stringify({
        deliveryId: d._id,
        webhookId: d.webhookId,
        eventType
      })));
    },

    /**
     * Process pending webhook deliveries
     */
    async processPendingDeliveries(): Promise<number> {
      const now = new Date();
      const pendingDeliveries = await deliveries
        .find({
          status: { $in: ["pending", "retrying"] },
          $or: [
            { nextAttemptAt: { $exists: false } },
            { nextAttemptAt: { $lte: now } }
          ]
        })
        .limit(100)
        .toArray();

      let processed = 0;

      for (const delivery of pendingDeliveries) {
        try {
          await processDelivery(delivery);
          processed++;
        } catch (err) {
          logger.error({ err, deliveryId: delivery._id }, "Failed to process webhook delivery");
        }
      }

      return processed;
    },

    /**
     * Get delivery history for a webhook
     */
    async getDeliveryHistory(webhookId: string, limit = 50): Promise<WebhookDelivery[]> {
      return deliveries
        .find({ webhookId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();
    }
  };

  async function processDelivery(delivery: WebhookDelivery): Promise<void> {
    const webhook = await webhooks.findOne({ _id: delivery.webhookId as any });
    
    if (!webhook || !webhook.active) {
      await deliveries.updateOne(
        { _id: delivery._id },
        { $set: { status: "failed", error: "Webhook not found or inactive" } }
      );
      return;
    }

    const attempt = delivery.attempts + 1;
    const timestamp = Date.now().toString();
    const signature = signPayload(delivery.payload, webhook.secret, timestamp);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": signature,
          "X-Webhook-Timestamp": timestamp,
          "X-Webhook-Event": delivery.eventType,
          "X-Webhook-Id": delivery._id?.toString() ?? randomUUID(),
          "User-Agent": "CryptoAuction-Webhook/1.0"
        },
        body: JSON.stringify(delivery.payload),
        signal: controller.signal
      });

      clearTimeout(timeout);

      const responseBody = await response.text().catch(() => "");

      if (response.ok) {
        // Success
        await deliveries.updateOne(
          { _id: delivery._id },
          {
            $set: {
              status: "delivered",
              attempts: attempt,
              lastAttemptAt: new Date(),
              deliveredAt: new Date(),
              responseStatus: response.status,
              responseBody: responseBody.slice(0, 1000)
            }
          }
        );

        await webhooks.updateOne(
          { _id: webhook._id },
          { $set: { lastDeliveryAt: new Date(), failureCount: 0 } }
        );

        logger.info({ deliveryId: delivery._id, webhookId: webhook._id }, "Webhook delivered successfully");
      } else {
        // HTTP error - schedule retry
        await handleFailure(delivery, webhook, attempt, `HTTP ${response.status}: ${responseBody.slice(0, 200)}`);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await handleFailure(delivery, webhook, attempt, errorMessage);
    }
  }

  async function handleFailure(
    delivery: WebhookDelivery,
    webhook: WebhookConfig,
    attempt: number,
    error: string
  ): Promise<void> {
    if (attempt >= MAX_RETRY_ATTEMPTS) {
      // Max retries reached
      await deliveries.updateOne(
        { _id: delivery._id },
        {
          $set: {
            status: "failed",
            attempts: attempt,
            lastAttemptAt: new Date(),
            error
          }
        }
      );

      await webhooks.updateOne(
        { _id: webhook._id },
        { $inc: { failureCount: 1 } }
      );

      // Auto-disable after 10 consecutive failures
      if (webhook.failureCount >= 9) {
        await webhooks.updateOne(
          { _id: webhook._id },
          { $set: { active: false } }
        );
        logger.warn({ webhookId: webhook._id }, "Webhook auto-disabled due to repeated failures");
      }

      logger.error({ deliveryId: delivery._id, error }, "Webhook delivery failed permanently");
    } else {
      // Schedule retry
      const retryDelay = RETRY_DELAYS[attempt - 1] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1] ?? 600000;
      const nextAttemptAt = new Date(Date.now() + retryDelay);

      await deliveries.updateOne(
        { _id: delivery._id },
        {
          $set: {
            status: "retrying",
            attempts: attempt,
            lastAttemptAt: new Date(),
            nextAttemptAt,
            error
          }
        }
      );

      logger.warn({ deliveryId: delivery._id, attempt, nextAttemptAt }, "Webhook delivery failed, retrying");
    }
  }
}

function signPayload(payload: Record<string, unknown>, secret: string, timestamp: string): string {
  const data = `${timestamp}.${JSON.stringify(payload)}`;
  return createHmac("sha256", secret).update(data).digest("hex");
}

/**
 * Verify webhook signature (for webhook receivers)
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  timestamp: string,
  secret: string,
  toleranceSeconds = 300
): boolean {
  // Check timestamp freshness
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(Date.now() - ts) > toleranceSeconds * 1000) {
    return false;
  }

  const expectedSignature = createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");

  // Constant-time comparison
  if (signature.length !== expectedSignature.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
  }

  return result === 0;
}
