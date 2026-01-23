// Webhook notification dispatcher with retry logic and signature verification
import { createHmac, randomBytes, randomUUID } from "crypto";
import type { Logger } from "pino";
import type { Redis } from "ioredis";
import { ObjectId, type Db, type WithId } from "mongodb";
import { mongoCollections } from "../../shared/storage/mongoSchemas.js";

// SSRF protection - block private/internal IP ranges
const BLOCKED_IP_RANGES = [
  /^127\./,                    // Loopback
  /^10\./,                     // Private Class A
  /^172\.(1[6-9]|2\d|3[01])\./, // Private Class B
  /^192\.168\./,               // Private Class C
  /^169\.254\./,               // Link-local
  /^0\./,                      // Current network
  /^::1$/,                     // IPv6 loopback
  /^fc00:/i,                   // IPv6 unique local
  /^fe80:/i,                   // IPv6 link-local
  /^ff00:/i,                   // IPv6 multicast
  /^localhost$/i,
  /^.*\.local$/i,
  /^.*\.internal$/i,
];

const BLOCKED_HOSTNAMES = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "metadata.google.internal",
  "169.254.169.254", // Cloud metadata
];

function isPrivateOrBlockedUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname.toLowerCase();
    
    // Block non-https in production (allow http for testing)
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return true;
    }
    
    // Check blocked hostnames
    if (BLOCKED_HOSTNAMES.includes(hostname)) {
      return true;
    }
    
    // Check blocked IP patterns
    for (const pattern of BLOCKED_IP_RANGES) {
      if (pattern.test(hostname)) {
        return true;
      }
    }
    
    return false;
  } catch {
    return true; // Invalid URL
  }
}

// Hash webhook secret for storage (one-way hash for verification)
function hashWebhookSecret(secret: string): string {
  return createHmac("sha256", "webhook-secret-salt").update(secret).digest("hex");
}

// Generate a secure random secret for webhooks
function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

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
  _id?: ObjectId;
  userId: string;
  url: string;
  secretHash: string; // Stored as hash, not plaintext
  events: WebhookEventType[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastDeliveryAt?: Date;
  failureCount: number;
}

export interface WebhookDelivery {
  _id?: ObjectId;
  webhookId: ObjectId; // Use ObjectId, not string
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

// Response type that includes the plaintext secret (only returned on creation)
export interface WebhookConfigWithSecret extends Omit<WebhookConfig, "secretHash"> {
  secret: string; // Plaintext secret - only returned once on creation
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
     * Register a new webhook endpoint with URL validation and secret hashing
     */
    async registerWebhook(config: { userId: string; url: string; events: WebhookEventType[]; active: boolean }): Promise<WebhookConfigWithSecret> {
      // SSRF protection - validate URL
      if (isPrivateOrBlockedUrl(config.url)) {
        throw new Error("Webhook URL must be a public HTTPS endpoint. Private/internal URLs are not allowed.");
      }

      const now = new Date();
      const plaintextSecret = generateWebhookSecret();
      const secretHash = hashWebhookSecret(plaintextSecret);
      
      const webhook: WebhookConfig = {
        userId: config.userId,
        url: config.url,
        secretHash,
        events: config.events,
        active: config.active,
        failureCount: 0,
        createdAt: now,
        updatedAt: now
      };

      const result = await webhooks.insertOne(webhook);
      logger.info({ webhookId: result.insertedId, userId: config.userId }, "Webhook registered");
      
      // Return with plaintext secret (only time it's available)
      return { 
        ...webhook, 
        _id: result.insertedId,
        secret: plaintextSecret // User must save this - it won't be retrievable again
      };
    },

    /**
     * Update webhook configuration
     */
    async updateWebhook(webhookId: string, updates: Partial<Pick<WebhookConfig, "url" | "events" | "active">>): Promise<void> {
      // Validate URL if being updated
      if (updates.url && isPrivateOrBlockedUrl(updates.url)) {
        throw new Error("Webhook URL must be a public HTTPS endpoint. Private/internal URLs are not allowed.");
      }

      const objectId = ObjectId.isValid(webhookId) ? new ObjectId(webhookId) : null;
      if (!objectId) {
        throw new Error("Invalid webhook ID format");
      }

      await webhooks.updateOne(
        { _id: objectId },
        { $set: { ...updates, updatedAt: new Date() } }
      );
    },

    /**
     * Regenerate webhook secret (returns new plaintext secret)
     */
    async regenerateSecret(webhookId: string): Promise<string> {
      const objectId = ObjectId.isValid(webhookId) ? new ObjectId(webhookId) : null;
      if (!objectId) {
        throw new Error("Invalid webhook ID format");
      }

      const plaintextSecret = generateWebhookSecret();
      const secretHash = hashWebhookSecret(plaintextSecret);

      await webhooks.updateOne(
        { _id: objectId },
        { $set: { secretHash, updatedAt: new Date() } }
      );

      return plaintextSecret;
    },

    /**
     * Delete webhook
     */
    async deleteWebhook(webhookId: string): Promise<void> {
      const objectId = ObjectId.isValid(webhookId) ? new ObjectId(webhookId) : null;
      if (!objectId) {
        throw new Error("Invalid webhook ID format");
      }

      await webhooks.deleteOne({ _id: objectId });
      logger.info({ webhookId }, "Webhook deleted");
    },

    /**
     * List webhooks for a user (secrets are not returned)
     */
    async listWebhooks(userId: string): Promise<Array<Omit<WithId<WebhookConfig>, "secretHash">>> {
      const results = await webhooks.find({ userId }).toArray();
      // Don't return secret hashes
      return results.map(({ secretHash, ...rest }) => rest);
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
        webhookId: webhook._id!, // Now correctly using ObjectId
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
        deliveryId: d._id?.toHexString(),
        webhookId: d.webhookId.toHexString(),
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
      const objectId = ObjectId.isValid(webhookId) ? new ObjectId(webhookId) : null;
      if (!objectId) {
        return [];
      }
      
      return deliveries
        .find({ webhookId: objectId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();
    }
  };

  async function processDelivery(delivery: WebhookDelivery): Promise<void> {
    // webhookId is now ObjectId
    const webhook = await webhooks.findOne({ _id: delivery.webhookId });
    
    if (!webhook || !webhook.active) {
      await deliveries.updateOne(
        { _id: delivery._id },
        { $set: { status: "failed", error: "Webhook not found or inactive" } }
      );
      return;
    }

    // SSRF check before making request
    if (isPrivateOrBlockedUrl(webhook.url)) {
      await deliveries.updateOne(
        { _id: delivery._id },
        { $set: { status: "failed", error: "Webhook URL blocked (private/internal address)" } }
      );
      logger.warn({ webhookId: webhook._id, url: webhook.url }, "Blocked webhook delivery to private URL");
      return;
    }

    const attempt = delivery.attempts + 1;
    const timestamp = Date.now().toString();
    // Use secretHash for signing (the hash itself is used as the signing key)
    const signature = signPayload(delivery.payload, webhook.secretHash, timestamp);

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
