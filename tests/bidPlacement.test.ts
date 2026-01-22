// Bid placement integration tests with Redis ranking checks.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Redis } from "ioredis";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  type LedgerEntryDocument
} from "../src/shared/storage/mongoSchemas.js";
import { createAuctionRepository } from "../src/services/auction-engine/auctionStore.js";
import { registerAuctionRoutes } from "../src/services/auction-engine/routes.js";
import { buildRankingMember } from "../src/services/auction-engine/bidRanking.js";
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

describeInfra("bid placement", () => {
  const testDbName = `crypto_hack_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const redisPrefix = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const config = loadConfig({
    serviceName: "auction-test",
    defaultPort: 4201,
    env: {
      MONGO_DB: testDbName,
      MONGO_URI: "mongodb://127.0.0.1:27018/?directConnection=true&replicaSet=rs0",
      REDIS_URL: "redis://127.0.0.1:6379",
      REDIS_PREFIX: redisPrefix,
      RATE_LIMIT_USER_PER_SECOND: "25",
      RATE_LIMIT_AUCTION_USER_PER_SECOND: "25",
      RATE_LIMIT_IP_PER_SECOND: "100",
      CORE_API_TOKEN: coreApiToken,
      LOG_LEVEL: "error"
    }
  });
  const logger = createLogger(config);
  let mongo: MongoDependencies;
  let redis: RedisClient;
  let redisRaw: Redis;
  let app: ReturnType<typeof createServer>;

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

  it("handles concurrent bids with idempotent retries", async () => {
    const auctionId = await seedLiveAuction(mongo);
    const ledger = createLedgerRepository(mongo);
    const bidders = ["user-a", "user-b", "user-c", "user-d", "user-e"];
    await Promise.all(
      bidders.map((userId) =>
        ledger.createEntry({
          userId,
          entryType: "deposit_confirmed",
          amount: 1000,
          currency: "USDT",
          idempotencyKey: `deposit-${userId}-${Date.now()}`
        })
      )
    );

    const url = `/auctions/${auctionId}/bids`;
    const idempotencyKey = `bid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const retries = await Promise.all(
      Array.from({ length: 5 }).map(() =>
        app.inject({
          method: "POST",
          url,
          payload: {
            userId: "user-a",
            amount: 120,
            idempotencyKey
          },
          headers: coreHeaders
        })
      )
    );

    const retryBodies = retries.map((response) => response.json() as Record<string, unknown>);
    for (const response of retries) {
      expect(response.statusCode).toBe(200);
    }

    const bidIds = new Set(retryBodies.map((body) => (body.bid as { _id: string })._id));
    expect(bidIds.size).toBe(1);

    const bidsCollection = mongo.db.collection<BidDocument>(mongoCollections.bids);
    const bidCount = await bidsCollection.countDocuments({ idempotencyKey });
    expect(bidCount).toBe(1);

    const bidId = Array.from(bidIds)[0];
    const ledgerEntries = mongo.db.collection<LedgerEntryDocument>(mongoCollections.ledgerEntries);
    const holdEntry = await ledgerEntries.findOne({
      userId: "user-a",
      entryType: "hold_created",
      "metadata.bidId": bidId
    });
    expect(holdEntry?.amount).toBe(120);

    // Place concurrent bids from different users
    // In a competitive environment, some bids may fail if they don't meet minimum increment
    // when top bid changes during processing
    const concurrentBids = await Promise.all(
      bidders.slice(1).map((userId, index) =>
        app.inject({
          method: "POST",
          url,
          payload: {
            userId,
            amount: 200 + index * 10,
            idempotencyKey: `bid-${userId}-${Date.now()}`
          },
          headers: coreHeaders
        })
      )
    );

    // At least some concurrent bids should succeed
    const successfulBids = concurrentBids.filter((r) => r.statusCode === 200);
    expect(successfulBids.length).toBeGreaterThan(0);

    // All responses should be either 200 (success) or 409 (conflict due to bid_too_low or lock)
    for (const response of concurrentBids) {
      expect([200, 409]).toContain(response.statusCode);
    }

    // Verify that successful bids were persisted
    const totalBids = await bidsCollection.countDocuments({ auctionId: new ObjectId(auctionId) });
    expect(totalBids).toBe(1 + successfulBids.length);
  }, 20000);

  it("updates redis ranking and snapshots after a bid", async () => {
    const auctionId = await seedLiveAuction(mongo);
    const ledger = createLedgerRepository(mongo);
    await ledger.createEntry({
      userId: "user-redis",
      entryType: "deposit_confirmed",
      amount: 1000,
      currency: "USDT",
      idempotencyKey: `deposit-${Date.now()}`
    });

    const response = await app.inject({
      method: "POST",
      url: `/auctions/${auctionId}/bids`,
      payload: {
        userId: "user-redis",
        amount: 250,
        idempotencyKey: `bid-${Date.now()}`
      },
      headers: coreHeaders
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      bid: { _id: string; amount: number; createdAt: string };
    };
    const rankingKey = `auction:${auctionId}:ranking`;
    const rankingMember = buildRankingMember(body.bid._id, new Date(body.bid.createdAt));
    const score = await redis.zscore(rankingKey, rankingMember);
    expect(Number(score)).toBe(body.bid.amount);

    const roundStateKey = `auction:${auctionId}:round:0:state`;
    const roundState = await redis.hgetall(roundStateKey);
    expect(roundState.status).toBe("live");
    expect(roundState.roundIndex).toBe("0");
    expect(roundState.lastBidAt).toBeTruthy();

    const snapshotKey = `auction:${auctionId}:snapshot`;
    const snapshot = await redis.hgetall(snapshotKey);
    expect(snapshot.currentRoundIndex).toBe("0");
    expect(snapshot.lastBidAmount).toBe(body.bid.amount.toString());

    const topKey = `state:auction:${auctionId}:top`;
    const topMembers = await redis.smembers(topKey);
    expect(topMembers).toContain(body.bid._id);
  });

  it("keeps a single active bid per auction and applies bid upgrades", async () => {
    const auctionId = await seedLiveAuction(mongo);
    const ledger = createLedgerRepository(mongo);
    await ledger.createEntry({
      userId: "user-upgrade",
      entryType: "deposit_confirmed",
      amount: 1000,
      currency: "USDT",
      idempotencyKey: `deposit-upgrade-${Date.now()}`
    });

    const url = `/auctions/${auctionId}/bids`;
    const firstBid = await app.inject({
      method: "POST",
      url,
      payload: {
        userId: "user-upgrade",
        amount: 100,
        idempotencyKey: `bid-upgrade-1-${Date.now()}`
      },
      headers: coreHeaders
    });
    expect(firstBid.statusCode).toBe(200);

    const secondBid = await app.inject({
      method: "POST",
      url,
      payload: {
        userId: "user-upgrade",
        amount: 150,
        idempotencyKey: `bid-upgrade-2-${Date.now()}`
      },
      headers: coreHeaders
    });
    expect(secondBid.statusCode).toBe(200);

    const bidsCollection = mongo.db.collection<BidDocument>(mongoCollections.bids);
    const activeBids = await bidsCollection
      .find({
        auctionId: new ObjectId(auctionId),
        userId: "user-upgrade",
        active: true
      })
      .toArray();
    expect(activeBids).toHaveLength(1);
    const activeBid = activeBids[0];
    if (!activeBid) {
      throw new Error("Active bid missing after upgrade.");
    }
    expect(activeBid.amount).toBe(150);

    const inactiveBids = await bidsCollection
      .find({
        auctionId: new ObjectId(auctionId),
        userId: "user-upgrade",
        active: false
      })
      .toArray();
    expect(inactiveBids).toHaveLength(1);
    const inactiveBid = inactiveBids[0];
    if (!inactiveBid) {
      throw new Error("Inactive bid missing after upgrade.");
    }
    expect(inactiveBid.inactiveAt).toBeInstanceOf(Date);

    const ledgerEntries = mongo.db.collection<LedgerEntryDocument>(
      mongoCollections.ledgerEntries
    );
    const holds = await ledgerEntries
      .find({ userId: "user-upgrade", entryType: "hold_created" })
      .toArray();
    const totalHeld = holds.reduce((sum, entry) => sum + entry.amount, 0);
    expect(totalHeld).toBeCloseTo(150, 6);

    const rankingKey = `auction:${auctionId}:ranking`;
    const rankingMember = buildRankingMember(activeBid._id, activeBid.createdAt);
    const score = await redis.zscore(rankingKey, rankingMember);
    expect(Number(score)).toBe(activeBid.amount);

    const inactiveMember = buildRankingMember(inactiveBid._id, inactiveBid.createdAt);
    const inactiveScore = await redis.zscore(rankingKey, inactiveMember);
    expect(inactiveScore).toBeNull();
  });
});

async function seedLiveAuction(mongo: MongoDependencies): Promise<string> {
  const now = new Date();
  const startAt = new Date(now.getTime() - 60_000);
  const endAt = new Date(now.getTime() + 60_000);
  const rounds: AuctionRoundConfig[] = [
    {
      index: 0,
      allocationSize: 3,
      startAt,
      endAt,
      antiSniping: {
        triggerWindowSeconds: 10,
        extensionSeconds: 30,
        maxExtensions: 2
      }
    }
  ];

  const auction: AuctionDocument = {
    title: "Test auction",
    description: "Bid placement test",
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
  if (!transition) {
    throw new Error("Round transition missing.");
  }
  await repository.applyRoundTransition(firstState, transition, now);

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

  await ensureDockerRedis(target.port);
  await waitForRedis(url);
}

async function pingRedis(url: string): Promise<boolean> {
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 1000
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
    if (!localHosts.has(parsed.hostname)) {
      return null;
    }
    const port = parsed.port ? Number(parsed.port) : 6379;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
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
  let containerReady = exists;
  if (!exists) {
    try {
      await runDocker([
        "run",
        "-d",
        "--name",
        containerName,
        "-p",
        `${port}:6379`,
        redisDockerImage
      ]);
      containerReady = true;
    } catch (error) {
      if (isContainerNameConflictError(error)) {
        containerReady = true;
      } else {
        throw error;
      }
    }
  }

  if (containerReady) {
    const running = await dockerContainerRunning(containerName);
    if (!running) {
      await runDocker(["start", containerName]);
    }
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
  const args = ["ps"];
  if (includeStopped) {
    args.push("-a");
  }
  args.push("--filter", `name=^${name}$`, "--format", "{{.Names}}");
  const { stdout } = await runDocker(args);
  return stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function runDocker(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("docker", args, { timeout: dockerTimeoutMs });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function isContainerNameConflictError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("container name") && error.message.includes("already in use");
}

async function waitForRedis(url: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await pingRedis(url)) {
      return;
    }
    await delay(1000);
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

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}
