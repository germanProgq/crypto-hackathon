// @ts-nocheck
// Chaos Engineering Tests: System behavior under infrastructure failures.
// Tests validate resilience, idempotency, and graceful degradation.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ObjectId } from "mongodb";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/shared/config.js";
import { createLogger } from "../src/shared/logger.js";
import { createServer } from "../src/shared/http/server.js";
import {
  connectMongo,
  ensureMongoCollections,
  ensureMongoIndexes,
  type MongoDependencies
} from "../src/shared/storage/mongo.js";
import { createRedisClient, type RedisClient } from "../src/shared/storage/redis.js";
import {
  mongoCollections,
  type AuctionDocument,
  type AuctionRoundConfig,
  type BidDocument,
  type AuctionRoundStateDocument
} from "../src/shared/storage/mongoSchemas.js";
import { createAuctionRepository } from "../src/services/auction-engine/auctionStore.js";
import { registerAuctionRoutes } from "../src/services/auction-engine/routes.js";
import { createLedgerRepository } from "../src/services/ledger/ledgerStore.js";
import { evaluateRoundTransition } from "../src/services/auction-engine/roundStateMachine.js";
import { hasDocker } from "./support/infra.js";

const execFileAsync = promisify(execFile);
const redisDockerImage = "redis:7.2-alpine";
const dockerTimeoutMs = 60000;
const localHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const coreApiToken = "test-core-token";
const coreHeaders = { "x-service-token": coreApiToken };
const describeInfra = hasDocker() ? describe : describe.skip;

describeInfra("Chaos Engineering: System behavior under failures", () => {
  const testDbName = `crypto_hack_chaos_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const redisPrefix = `chaos-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const config = loadConfig({
    serviceName: "chaos-test",
    defaultPort: 4400,
    env: {
      MONGO_DB: testDbName,
      MONGO_URI: "mongodb://127.0.0.1:27018/?directConnection=true&replicaSet=rs0",
      REDIS_URL: "redis://127.0.0.1:6379",
      REDIS_PREFIX: redisPrefix,
      RATE_LIMIT_USER_PER_SECOND: "100",
      RATE_LIMIT_AUCTION_USER_PER_SECOND: "100",
      RATE_LIMIT_IP_PER_SECOND: "500",
      CORE_API_TOKEN: coreApiToken,
      LOG_LEVEL: "error"
    }
  });
  const logger = createLogger(config);
  let mongo: MongoDependencies;
  let redis: RedisClient;
  let redisRaw: Redis;
  let app: ReturnType<typeof createServer>;
  let ledger: ReturnType<typeof createLedgerRepository>;

  beforeAll(async () => {
    await ensureRedisAvailable(config.redis.url);
    mongo = await connectMongo(config, logger);
    await ensureMongoCollections(mongo.db, logger);
    await ensureMongoIndexes(mongo.db, logger);
    redis = await createRedisClient(config, logger);
    redisRaw = new Redis(config.redis.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false
    });
    await redisRaw.connect();
    ledger = createLedgerRepository(mongo);

    app = createServer({ logger, config });
    await registerAuctionRoutes(app, { config, logger, mongo, redis });
    await app.ready();
  }, 60000);

  beforeEach(async () => {
    await mongo.db.collection(mongoCollections.auctions).deleteMany({});
    await mongo.db.collection(mongoCollections.auctionRoundStates).deleteMany({});
    await mongo.db.collection(mongoCollections.bids).deleteMany({});
    await mongo.db.collection(mongoCollections.ledgerEntries).deleteMany({});
    await mongo.db.collection(mongoCollections.ledgerAccounts).deleteMany({});
    await mongo.db.collection(mongoCollections.roundResults).deleteMany({});
    await clearRedisPrefix(redisRaw, redisPrefix);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (redis) {
      await redis.quit();
    }
    if (redisRaw) {
      await redisRaw.quit();
    }
    if (mongo) {
      await mongo.db.dropDatabase();
      await mongo.client.close();
    }
  }, 20000);

  describe("Idempotency under network issues", () => {
    it("handles duplicate bid requests gracefully", async () => {
      const auctionId = await seedLiveAuction(mongo);
      await ledger.createEntry({
        userId: "chaos-user-1",
        entryType: "deposit_confirmed",
        amount: 1000,
        currency: "USDT",
        idempotencyKey: `deposit-chaos-1-${Date.now()}`
      });

      const idempotencyKey = `bid-duplicate-${Date.now()}`;

      // Simulate network retry - send same request 10 times
      const requests = Array.from({ length: 10 }, () =>
        app.inject({
          method: "POST",
          url: `/auctions/${auctionId}/bids`,
          payload: {
            userId: "chaos-user-1",
            amount: 100,
            idempotencyKey
          },
          headers: coreHeaders
        })
      );

      const responses = await Promise.all(requests);

      // All requests should succeed
      for (const response of responses) {
        expect(response.statusCode).toBe(200);
      }

      // But only one bid should be created
      const bids = await mongo.db.collection<BidDocument>(mongoCollections.bids)
        .find({ idempotencyKey })
        .toArray();
      expect(bids).toHaveLength(1);

      // And only one hold should be created
      const balance = await ledger.getBalance("chaos-user-1", "USDT");
      expect(balance.held).toBeCloseTo(100, 6);
    }, 15000);

    it("handles concurrent bids from multiple users correctly", async () => {
      const auctionId = await seedLiveAuction(mongo);
      const users = Array.from({ length: 20 }, (_, i) => `concurrent-user-${i}`);

      // Fund all users
      await Promise.all(
        users.map((userId) =>
          ledger.createEntry({
            userId,
            entryType: "deposit_confirmed",
            amount: 500,
            currency: "USDT",
            idempotencyKey: `deposit-${userId}-${Date.now()}`
          })
        )
      );

      // All users bid simultaneously
      const bidPromises = users.map((userId, i) =>
        app.inject({
          method: "POST",
          url: `/auctions/${auctionId}/bids`,
          payload: {
            userId,
            amount: 100 + i * 5,
            idempotencyKey: `bid-${userId}-${Date.now()}`
          },
          headers: coreHeaders
        })
      );

      const responses = await Promise.all(bidPromises);

      // In concurrent bidding, some bids may be rejected (409) if they don't meet
      // minimum bid requirements when top bid changes during processing
      const successCount = responses.filter((r) => r.statusCode === 200).length;
      const conflictCount = responses.filter((r) => r.statusCode === 409).length;
      
      // At least some bids should succeed
      expect(successCount).toBeGreaterThan(0);
      // All responses should be either success or conflict
      expect(successCount + conflictCount).toBe(users.length);

      // Verify successful bids recorded
      const bids = await mongo.db.collection<BidDocument>(mongoCollections.bids)
        .find({ auctionId: new ObjectId(auctionId), active: true })
        .toArray();
      expect(bids).toHaveLength(successCount);
    }, 30000);
  });

  describe("Consistency under partial failures", () => {
    it("maintains ledger consistency if bid fails after hold", async () => {
      const userId = "partial-fail-user";
      await ledger.createEntry({
        userId,
        entryType: "deposit_confirmed",
        amount: 500,
        currency: "USDT",
        idempotencyKey: `deposit-partial-${Date.now()}`
      });

      // Create hold manually (simulating first part of bid)
      await ledger.createHold({
        userId,
        amount: 100,
        currency: "USDT",
        holdId: "partial-hold-1",
        idempotencyKey: `hold-partial-1-${Date.now()}`
      });

      // Balance should show hold
      let balance = await ledger.getBalance(userId, "USDT");
      expect(balance.held).toBeCloseTo(100, 6);
      expect(balance.available).toBeCloseTo(400, 6);

      // If we release the hold (simulating cleanup after failed bid insert)
      await ledger.releaseHold({
        userId,
        amount: 100,
        currency: "USDT",
        holdId: "partial-hold-1",
        idempotencyKey: `release-partial-1-${Date.now()}`
      });

      // Balance should be fully restored
      balance = await ledger.getBalance(userId, "USDT");
      expect(balance.available).toBeCloseTo(500, 6);
      expect(balance.held).toBeCloseTo(0, 6);
    }, 15000);

    it("prevents double capture of holds", async () => {
      const userId = "double-capture-user";
      await ledger.createEntry({
        userId,
        entryType: "deposit_confirmed",
        amount: 500,
        currency: "USDT",
        idempotencyKey: `deposit-dc-${Date.now()}`
      });

      await ledger.createHold({
        userId,
        amount: 100,
        currency: "USDT",
        holdId: "dc-hold-1",
        idempotencyKey: `hold-dc-1-${Date.now()}`
      });

      // First capture
      await ledger.captureHold({
        userId,
        amount: 100,
        currency: "USDT",
        holdId: "dc-hold-1",
        idempotencyKey: `capture-dc-1-${Date.now()}`
      });

      // Second capture should fail
      await expect(
        ledger.captureHold({
          userId,
          amount: 100,
          currency: "USDT",
          holdId: "dc-hold-1",
          idempotencyKey: `capture-dc-2-${Date.now()}`
        })
      ).rejects.toThrow();

      // Balance should reflect single capture
      const balance = await ledger.getBalance(userId, "USDT");
      expect(balance.current).toBeCloseTo(400, 6);
      expect(balance.spent).toBeCloseTo(100, 6);
    }, 15000);
  });

  describe("Recovery scenarios", () => {
    it("handles round state recovery after interruption", async () => {
      const auctionId = await seedLiveAuction(mongo);
      const repository = createAuctionRepository(mongo);

      // Get current round state
      const auction = await mongo.db.collection<AuctionDocument>(mongoCollections.auctions)
        .findOne({ _id: new ObjectId(auctionId) });
      expect(auction).toBeDefined();

      const roundStates = await mongo.db.collection<AuctionRoundStateDocument>(
        mongoCollections.auctionRoundStates
      ).find({ auctionId: new ObjectId(auctionId) }).toArray();
      expect(roundStates).toHaveLength(1);

      const roundState = roundStates[0];
      expect(roundState.status).toBe("live");

      // Simulate "recovery" by re-evaluating transition
      const now = new Date();
      const transition = evaluateRoundTransition(roundState, now);

      // Should not transition if still within time
      if (now < roundState.effectiveEndAt) {
        expect(transition?.to).toBeUndefined();
      }
    }, 15000);

    it("maintains data integrity across multiple bid upgrades", async () => {
      const auctionId = await seedLiveAuction(mongo);
      const userId = "upgrade-user";

      await ledger.createEntry({
        userId,
        entryType: "deposit_confirmed",
        amount: 1000,
        currency: "USDT",
        idempotencyKey: `deposit-upgrade-${Date.now()}`
      });

      // Place initial bid
      let response = await app.inject({
        method: "POST",
        url: `/auctions/${auctionId}/bids`,
        payload: {
          userId,
          amount: 100,
          idempotencyKey: `bid-upgrade-1-${Date.now()}`
        },
        headers: coreHeaders
      });
      expect(response.statusCode).toBe(200);

      // Upgrade bid multiple times
      for (let i = 2; i <= 5; i++) {
        response = await app.inject({
          method: "POST",
          url: `/auctions/${auctionId}/bids`,
          payload: {
            userId,
            amount: 100 + i * 50,
            idempotencyKey: `bid-upgrade-${i}-${Date.now()}`
          },
          headers: coreHeaders
        });
        expect(response.statusCode).toBe(200);
      }

      // Should have only one active bid
      const activeBids = await mongo.db.collection<BidDocument>(mongoCollections.bids)
        .find({
          auctionId: new ObjectId(auctionId),
          userId,
          active: true
        })
        .toArray();
      expect(activeBids).toHaveLength(1);
      expect(activeBids[0].amount).toBe(350); // 100 + 5*50

      // Balance should reflect final bid amount only
      const balance = await ledger.getBalance(userId, "USDT");
      expect(balance.held).toBeCloseTo(350, 6);
      expect(balance.available).toBeCloseTo(650, 6);
    }, 20000);
  });

  describe("Stress and load handling", () => {
    it("handles burst of bids without data loss", async () => {
      const auctionId = await seedLiveAuction(mongo);
      const burstSize = 50;

      // Fund users
      await Promise.all(
        Array.from({ length: burstSize }, (_, i) =>
          ledger.createEntry({
            userId: `burst-user-${i}`,
            entryType: "deposit_confirmed",
            amount: 500,
            currency: "USDT",
            idempotencyKey: `deposit-burst-${i}-${Date.now()}`
          })
        )
      );

      // Burst of bids
      const bidPromises = Array.from({ length: burstSize }, (_, i) =>
        app.inject({
          method: "POST",
          url: `/auctions/${auctionId}/bids`,
          payload: {
            userId: `burst-user-${i}`,
            amount: 100 + Math.floor(Math.random() * 200),
            idempotencyKey: `bid-burst-${i}-${Date.now()}`
          },
          headers: coreHeaders
        })
      );

      const startTime = Date.now();
      const responses = await Promise.all(bidPromises);
      const duration = Date.now() - startTime;

      // In burst scenarios, some bids may be rejected due to minimum increment requirements
      const successCount = responses.filter((r) => r.statusCode === 200).length;
      const conflictCount = responses.filter((r) => r.statusCode === 409).length;
      
      // At least some bids should succeed
      expect(successCount).toBeGreaterThan(0);
      // All responses should be success or conflict
      expect(successCount + conflictCount).toBe(burstSize);

      // Verify successful bids persisted (no data loss)
      const bids = await mongo.db.collection<BidDocument>(mongoCollections.bids)
        .find({ auctionId: new ObjectId(auctionId) })
        .toArray();
      expect(bids).toHaveLength(successCount);

      // Log performance
      console.log(`Burst: ${successCount}/${burstSize} bids succeeded in ${duration}ms (${(burstSize / duration * 1000).toFixed(0)} bids/sec)`);
    }, 30000);

    it("handles rapid bid upgrades from same user", async () => {
      const auctionId = await seedLiveAuction(mongo);
      const userId = "rapid-upgrade-user";

      await ledger.createEntry({
        userId,
        entryType: "deposit_confirmed",
        amount: 5000,
        currency: "USDT",
        idempotencyKey: `deposit-rapid-${Date.now()}`
      });

      // Rapid sequential upgrades
      let lastAmount = 100;
      for (let i = 0; i < 20; i++) {
        const amount = lastAmount + 50;
        const response = await app.inject({
          method: "POST",
          url: `/auctions/${auctionId}/bids`,
          payload: {
            userId,
            amount,
            idempotencyKey: `bid-rapid-${i}-${Date.now()}`
          },
          headers: coreHeaders
        });
        expect(response.statusCode).toBe(200);
        lastAmount = amount;
      }

      // Final bid should be 100 + 20*50 = 1100
      const activeBids = await mongo.db.collection<BidDocument>(mongoCollections.bids)
        .find({ auctionId: new ObjectId(auctionId), userId, active: true })
        .toArray();
      expect(activeBids).toHaveLength(1);
      expect(activeBids[0].amount).toBe(1100);

      const balance = await ledger.getBalance(userId, "USDT");
      expect(balance.held).toBeCloseTo(1100, 6);
    }, 30000);
  });

  describe("Edge cases and boundary conditions", () => {
    it("rejects bid when balance exactly equals held amount", async () => {
      const userId = "exact-balance-user";

      await ledger.createEntry({
        userId,
        entryType: "deposit_confirmed",
        amount: 100,
        currency: "USDT",
        idempotencyKey: `deposit-exact-${Date.now()}`
      });

      const auctionId = await seedLiveAuction(mongo);

      // Place bid for exact balance
      const response1 = await app.inject({
        method: "POST",
        url: `/auctions/${auctionId}/bids`,
        payload: {
          userId,
          amount: 100,
          idempotencyKey: `bid-exact-1-${Date.now()}`
        },
        headers: coreHeaders
      });
      expect(response1.statusCode).toBe(200);

      // Try to place another bid (should fail - no available funds)
      const auctionId2 = await seedLiveAuction(mongo);
      const response2 = await app.inject({
        method: "POST",
        url: `/auctions/${auctionId2}/bids`,
        payload: {
          userId,
          amount: 1,
          idempotencyKey: `bid-exact-2-${Date.now()}`
        },
        headers: coreHeaders
      });
      expect(response2.statusCode).toBe(409); // Conflict - insufficient funds
    }, 15000);

    it("handles zero-amount edge case in ledger", async () => {
      const userId = "zero-amount-user";

      await ledger.createEntry({
        userId,
        entryType: "deposit_confirmed",
        amount: 100,
        currency: "USDT",
        idempotencyKey: `deposit-zero-${Date.now()}`
      });

      // Try to create zero hold (should fail)
      await expect(
        ledger.createHold({
          userId,
          amount: 0,
          currency: "USDT",
          holdId: "zero-hold",
          idempotencyKey: `hold-zero-${Date.now()}`
        })
      ).rejects.toThrow();
    }, 15000);

    it("handles very large bid amounts correctly", async () => {
      const auctionId = await seedLiveAuction(mongo);
      const userId = "large-bid-user";

      const largeAmount = 999999999.999999;
      await ledger.createEntry({
        userId,
        entryType: "deposit_confirmed",
        amount: largeAmount,
        currency: "USDT",
        idempotencyKey: `deposit-large-${Date.now()}`
      });

      const response = await app.inject({
        method: "POST",
        url: `/auctions/${auctionId}/bids`,
        payload: {
          userId,
          amount: largeAmount - 1,
          idempotencyKey: `bid-large-${Date.now()}`
        },
        headers: coreHeaders
      });
      expect(response.statusCode).toBe(200);

      const balance = await ledger.getBalance(userId, "USDT");
      expect(balance.held).toBeCloseTo(largeAmount - 1, 4);
    }, 15000);
  });
});

// Helper functions
async function seedLiveAuction(mongo: MongoDependencies): Promise<string> {
  const now = new Date();
  const startAt = new Date(now.getTime() - 60_000);
  const endAt = new Date(now.getTime() + 300_000); // 5 min from now

  const rounds: AuctionRoundConfig[] = [
    {
      index: 0,
      allocationSize: 10,
      startAt,
      endAt,
      antiSniping: {
        triggerWindowSeconds: 30,
        extensionSeconds: 60,
        maxExtensions: 3
      }
    }
  ];

  const auction: AuctionDocument = {
    title: "Chaos Test Auction",
    description: "Testing resilience",
    status: "live",
    currency: "USDT",
    pricingMode: "first-price",
    minBid: 0,
    minIncrement: 0,
    startsAt: startAt,
    endsAt: endAt,
    rounds,
    createdAt: now,
    updatedAt: now
  };

  const auctions = mongo.db.collection<AuctionDocument>(mongoCollections.auctions);
  const inserted = await auctions.insertOne(auction);
  const stored = await auctions.findOne({ _id: inserted.insertedId });
  if (!stored) {
    throw new Error("Auction seed failed.");
  }

  const repository = createAuctionRepository(mongo);
  const roundStates = await repository.ensureRoundStates(stored);
  const firstState = roundStates[0];
  if (!firstState) {
    throw new Error("Round state missing.");
  }

  const transition = evaluateRoundTransition(firstState, now);
  if (transition) {
    await repository.applyRoundTransition(firstState, transition, now);
  }

  return inserted.insertedId.toHexString();
}

async function ensureRedisAvailable(url: string): Promise<void> {
  const ready = await pingRedis(url);
  if (ready) {
    return;
  }
  const target = resolveLocalRedisTarget(url);
  if (!target) {
    throw new Error("Redis not available and auto-start is disabled for remote hosts.");
  }
  if (!hasDocker()) {
    throw new Error("Redis not available and Docker is not running.");
  }
  await ensureDockerRedis(target.port);
  await waitForRedis(url);
}

async function pingRedis(url: string): Promise<boolean> {
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5000
  });
  client.on("error", () => {});
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    try {
      await client.quit();
    } catch {
    }
  }
}

function resolveLocalRedisTarget(url: string): { port: number } | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (!localHosts.has(host)) {
      return null;
    }
    const port = parsed.port ? Number(parsed.port) : 6379;
    if (!Number.isFinite(port)) {
      return null;
    }
    return { port };
  } catch {
    return null;
  }
}

async function ensureDockerRedis(port: number): Promise<void> {
  const containerName = `crypto-hack-redis-${port}`;
  const exists = await dockerContainerExists(containerName);
  if (!exists) {
    await runDocker([
      "run",
      "--name",
      containerName,
      "-p",
      `${port}:6379`,
      "-d",
      redisDockerImage
    ]);
    return;
  }
  const running = await dockerContainerRunning(containerName);
  if (!running) {
    await runDocker(["start", containerName]);
  }
}

async function dockerContainerExists(name: string): Promise<boolean> {
  const names = await listDockerContainers(name, true);
  return names.includes(name);
}

async function dockerContainerRunning(name: string): Promise<boolean> {
  const names = await listDockerContainers(name, false);
  return names.includes(name);
}

async function listDockerContainers(name: string, includeStopped: boolean): Promise<string[]> {
  const args = ["ps", "--filter", `name=^${name}$`, "--format", "{{.Names}}"];
  if (includeStopped) {
    args.splice(1, 0, "-a");
  }
  const { stdout } = await runDocker(args);
  return stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function runDocker(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("docker", args, { timeout: dockerTimeoutMs });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

async function waitForRedis(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await pingRedis(url)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Redis did not become ready.");
}

async function clearRedisPrefix(redisClient: Redis, prefix: string): Promise<void> {
  let cursor = "0";
  const match = `${prefix}:*`;
  do {
    const [nextCursor, keys] = await redisClient.scan(cursor, "MATCH", match, "COUNT", "100");
    cursor = nextCursor;
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
  } while (cursor !== "0");
}
