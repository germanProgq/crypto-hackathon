// Purpose: round finalization integration tests.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Redis } from "ioredis";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/shared/config.js";
import { createLogger } from "../src/shared/logger.js";
import {
  connectMongo,
  ensureMongoCollections,
  ensureMongoIndexes,
  type MongoDependencies
} from "../src/shared/storage/mongo.js";
import {
  mongoCollections,
  type AuctionDocument,
  type AuctionRoundConfig,
  type BidDocument,
  type LedgerEntryDocument,
  type NotificationQueueDocument,
  type RoundResultDocument
} from "../src/shared/storage/mongoSchemas.js";
import { createRedisClient, type RedisClient } from "../src/shared/storage/redis.js";
import { createAuctionRepository } from "../src/services/auction-engine/auctionStore.js";
import { createBidService } from "../src/services/auction-engine/bidService.js";
import { buildRankingMember } from "../src/services/auction-engine/bidRanking.js";
import { createRoundFinalizationService } from "../src/services/auction-engine/roundFinalizationService.js";
import { evaluateRoundTransition } from "../src/services/auction-engine/roundStateMachine.js";
import { createLedgerRepository } from "../src/services/ledger/ledgerStore.js";

const execFileAsync = promisify(execFile);
const redisDockerImage = "redis:7.2-alpine";
const dockerTimeoutMs = 60000;
const localHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

describe("round finalization", () => {
  const testDbName = `crypto_hack_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const redisPrefix = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const config = loadConfig({
    serviceName: "round-finalization-test",
    defaultPort: 4301,
    env: {
      MONGO_DB: testDbName,
      MONGO_URI: "mongodb://127.0.0.1:27018/?directConnection=true&replicaSet=rs0",
      REDIS_URL: "redis://127.0.0.1:6379",
      REDIS_PREFIX: redisPrefix,
      RATE_LIMIT_USER_PER_SECOND: "50",
      RATE_LIMIT_AUCTION_USER_PER_SECOND: "50",
      RATE_LIMIT_IP_PER_SECOND: "200",
      LOG_LEVEL: "error"
    }
  });
  const logger = createLogger(config);
  let mongo: MongoDependencies;
  let redis: RedisClient;
  let redisRaw: Redis;

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
  }, 60000);

  beforeEach(async () => {
    await mongo.db.collection(mongoCollections.auctions).deleteMany({});
    await mongo.db.collection(mongoCollections.auctionRoundStates).deleteMany({});
    await mongo.db.collection(mongoCollections.bids).deleteMany({});
    await mongo.db.collection(mongoCollections.ledgerEntries).deleteMany({});
    await mongo.db.collection(mongoCollections.ledgerAccounts).deleteMany({});
    await mongo.db.collection(mongoCollections.roundResults).deleteMany({});
    await mongo.db.collection(mongoCollections.deliveryRecords).deleteMany({});
    await mongo.db.collection(mongoCollections.notificationQueue).deleteMany({});
    await clearRedisPrefix(redisRaw, redisPrefix);
  });

  afterAll(async () => {
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

  it("finalizes closed rounds with settlement and idempotent retries", async () => {
    const { auctionId, roundIndex } = await seedClosedRound(mongo, redis, config, logger);
    const finalizer = createRoundFinalizationService({ config, logger, mongo, redis });

    await finalizer.finalizeRound(auctionId, roundIndex);

    const roundResults = await mongo.db
      .collection<RoundResultDocument>(mongoCollections.roundResults)
      .findOne({ auctionId, roundIndex });
    expect(roundResults).toBeTruthy();
    expect(roundResults?.winners).toHaveLength(2);
    expect(roundResults?.settlementCompletedAt).toBeInstanceOf(Date);
    expect(roundResults?.winners.map((winner) => winner.userId)).toEqual([
      "user-2",
      "user-1"
    ]);

    const deliveries = await mongo.db
      .collection(mongoCollections.deliveryRecords)
      .find({ auctionId, roundIndex })
      .toArray();
    expect(deliveries).toHaveLength(2);

    const notifications = await mongo.db
      .collection<NotificationQueueDocument>(mongoCollections.notificationQueue)
      .find({ auctionId, roundIndex })
      .toArray();
    expect(notifications).toHaveLength(3);
    for (const notification of notifications) {
      expect(notification.status).toBe("pending");
      expect(notification.type).toBe("round_result");
    }

    const ledgerEntries = mongo.db.collection<LedgerEntryDocument>(
      mongoCollections.ledgerEntries
    );
    const capturedCount = await ledgerEntries.countDocuments({ entryType: "hold_captured" });
    const releasedCount = await ledgerEntries.countDocuments({ entryType: "hold_released" });
    expect(capturedCount).toBe(3);
    expect(releasedCount).toBe(1);

    const ledger = createLedgerRepository(mongo);
    const user1 = await ledger.getBalance("user-1", "USDT");
    const user2 = await ledger.getBalance("user-2", "USDT");
    const user3 = await ledger.getBalance("user-3", "USDT");
    expect(user1.spent).toBeCloseTo(150, 6);
    expect(user2.spent).toBeCloseTo(200, 6);
    expect(user3.spent).toBeCloseTo(0, 6);

    await finalizer.finalizeRound(auctionId, roundIndex);

    const capturedAgain = await ledgerEntries.countDocuments({ entryType: "hold_captured" });
    const releasedAgain = await ledgerEntries.countDocuments({ entryType: "hold_released" });
    expect(capturedAgain).toBe(capturedCount);
    expect(releasedAgain).toBe(releasedCount);

    const deliveryAgain = await mongo.db
      .collection(mongoCollections.deliveryRecords)
      .countDocuments({ auctionId, roundIndex });
    const notificationsAgain = await mongo.db
      .collection(mongoCollections.notificationQueue)
      .countDocuments({ auctionId, roundIndex });
    expect(deliveryAgain).toBe(2);
    expect(notificationsAgain).toBe(3);
  }, 30000);

  it("carries over active bids until the final round", async () => {
    const now = new Date();
    const round0Start = new Date(now.getTime() - 60_000);
    const round0End = new Date(now.getTime() + 60_000);
    const round1Start = new Date(now.getTime() + 120_000);
    const round1End = new Date(now.getTime() + 240_000);
    const rounds: AuctionRoundConfig[] = [
      {
        index: 0,
        allocationSize: 1,
        startAt: round0Start,
        endAt: round0End,
        antiSniping: {
          triggerWindowSeconds: 5,
          extensionSeconds: 10,
          maxExtensions: 1
        }
      },
      {
        index: 1,
        allocationSize: 1,
        startAt: round1Start,
        endAt: round1End,
        antiSniping: {
          triggerWindowSeconds: 5,
          extensionSeconds: 10,
          maxExtensions: 1
        }
      }
    ];

    const auction: AuctionDocument = {
      title: "Carry-over test",
      description: "Active bids persist",
      status: "live",
      currency: "USDT",
      pricingMode: "first-price",
      minBid: 0,
      minIncrement: 0,
      startsAt: round0Start,
      endsAt: round1End,
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
    const round0State = roundStates.find((state) => state.roundIndex === 0);
    const round1State = roundStates.find((state) => state.roundIndex === 1);
    if (!round0State || !round1State) {
      throw new Error("Round states missing.");
    }

    const liveTransition = evaluateRoundTransition(round0State, now);
    if (!liveTransition) {
      throw new Error("Round 0 live transition missing.");
    }
    const liveState = await repository.applyRoundTransition(round0State, liveTransition, now);
    if (!liveState) {
      throw new Error("Round 0 live transition failed.");
    }

    const ledger = createLedgerRepository(mongo);
    await Promise.all([
      ledger.createEntry({
        userId: "user-a",
        entryType: "deposit_confirmed",
        amount: 500,
        currency: "USDT",
        idempotencyKey: `deposit-user-a-${Date.now()}`
      }),
      ledger.createEntry({
        userId: "user-b",
        entryType: "deposit_confirmed",
        amount: 500,
        currency: "USDT",
        idempotencyKey: `deposit-user-b-${Date.now()}`
      }),
      ledger.createEntry({
        userId: "user-c",
        entryType: "deposit_confirmed",
        amount: 500,
        currency: "USDT",
        idempotencyKey: `deposit-user-c-${Date.now()}`
      })
    ]);

    const bidService = createBidService({ config, logger, mongo, redis });
    await bidService.placeBid({
      auctionId: inserted.insertedId,
      userId: "user-a",
      amount: 120,
      idempotencyKey: `bid-user-a-${Date.now()}`,
      ip: "127.0.0.1"
    });
    await bidService.placeBid({
      auctionId: inserted.insertedId,
      userId: "user-b",
      amount: 100,
      idempotencyKey: `bid-user-b-${Date.now()}`,
      ip: "127.0.0.1"
    });
    await bidService.placeBid({
      auctionId: inserted.insertedId,
      userId: "user-c",
      amount: 90,
      idempotencyKey: `bid-user-c-${Date.now()}`,
      ip: "127.0.0.1"
    });

    const closeTime = new Date(round0End.getTime() + 1000);
    const closeTransition = evaluateRoundTransition(liveState, closeTime);
    if (!closeTransition) {
      throw new Error("Round 0 close transition missing.");
    }
    await repository.applyRoundTransition(liveState, closeTransition, closeTime);

    const finalizer = createRoundFinalizationService({ config, logger, mongo, redis });
    await finalizer.finalizeRound(inserted.insertedId, 0);

    const bidsCollection = mongo.db.collection<BidDocument>(mongoCollections.bids);
    const activeBids = await bidsCollection
      .find({ auctionId: inserted.insertedId, active: true })
      .toArray();
    expect(activeBids.map((bid) => bid.userId).sort()).toEqual(["user-b", "user-c"]);

    const activeBidB = activeBids.find((bid) => bid.userId === "user-b");
    if (!activeBidB) {
      throw new Error("Active bid missing for user-b.");
    }
    const rankingKey = `auction:${inserted.insertedId.toHexString()}:ranking`;
    const rankingMember = buildRankingMember(activeBidB._id, activeBidB.createdAt);
    const score = await redis.zscore(rankingKey, rankingMember);
    expect(Number(score)).toBe(activeBidB.amount);

    const ledgerEntries = mongo.db.collection<LedgerEntryDocument>(
      mongoCollections.ledgerEntries
    );
    const releasedAfterRound0 = await ledgerEntries.countDocuments({
      entryType: "hold_released"
    });
    expect(releasedAfterRound0).toBe(0);

    const round1LiveTime = new Date(round1Start.getTime() + 1000);
    const round1LiveTransition = evaluateRoundTransition(round1State, round1LiveTime);
    if (!round1LiveTransition) {
      throw new Error("Round 1 live transition missing.");
    }
    const round1LiveState = await repository.applyRoundTransition(
      round1State,
      round1LiveTransition,
      round1LiveTime
    );
    if (!round1LiveState) {
      throw new Error("Round 1 live transition failed.");
    }

    const round1CloseTime = new Date(round1End.getTime() + 1000);
    const round1CloseTransition = evaluateRoundTransition(round1LiveState, round1CloseTime);
    if (!round1CloseTransition) {
      throw new Error("Round 1 close transition missing.");
    }
    await repository.applyRoundTransition(round1LiveState, round1CloseTransition, round1CloseTime);

    await finalizer.finalizeRound(inserted.insertedId, 1);

    const releasedAfterRound1 = await ledgerEntries.countDocuments({
      entryType: "hold_released"
    });
    expect(releasedAfterRound1).toBeGreaterThan(releasedAfterRound0);

    const activeCountAfter = await bidsCollection.countDocuments({
      auctionId: inserted.insertedId,
      active: true
    });
    expect(activeCountAfter).toBe(0);
  }, 40000);
});

async function seedClosedRound(
  mongo: MongoDependencies,
  redis: RedisClient,
  config: ReturnType<typeof loadConfig>,
  logger: ReturnType<typeof createLogger>
): Promise<{ auctionId: ObjectId; roundIndex: number }> {
  const now = new Date();
  const startAt = new Date(now.getTime() - 5_000);
  const endAt = new Date(now.getTime() + 60_000);
  const rounds: AuctionRoundConfig[] = [
    {
      index: 0,
      allocationSize: 2,
      startAt,
      endAt,
      antiSniping: {
        triggerWindowSeconds: 5,
        extensionSeconds: 10,
        maxExtensions: 1
      }
    }
  ];

  const auction: AuctionDocument = {
    title: "Finalization test",
    description: "Settlement verification",
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

  const liveTransition = evaluateRoundTransition(firstState, now);
  if (!liveTransition) {
    throw new Error("Round transition missing.");
  }
  const liveState = await repository.applyRoundTransition(firstState, liveTransition, now);
  if (!liveState) {
    throw new Error("Round live transition failed.");
  }

  const ledger = createLedgerRepository(mongo);
  await Promise.all([
    ledger.createEntry({
      userId: "user-1",
      entryType: "deposit_confirmed",
      amount: 500,
      currency: "USDT",
      idempotencyKey: `deposit-user-1-${Date.now()}`
    }),
    ledger.createEntry({
      userId: "user-2",
      entryType: "deposit_confirmed",
      amount: 500,
      currency: "USDT",
      idempotencyKey: `deposit-user-2-${Date.now()}`
    }),
    ledger.createEntry({
      userId: "user-3",
      entryType: "deposit_confirmed",
      amount: 500,
      currency: "USDT",
      idempotencyKey: `deposit-user-3-${Date.now()}`
    })
  ]);

  const bidService = createBidService({ config, logger, mongo, redis });
  await bidService.placeBid({
    auctionId: inserted.insertedId,
    userId: "user-1",
    amount: 100,
    idempotencyKey: `bid-user-1-1-${Date.now()}`,
    ip: "127.0.0.1"
  });
  await bidService.placeBid({
    auctionId: inserted.insertedId,
    userId: "user-1",
    amount: 150,
    idempotencyKey: `bid-user-1-2-${Date.now()}`,
    ip: "127.0.0.1"
  });
  await bidService.placeBid({
    auctionId: inserted.insertedId,
    userId: "user-2",
    amount: 200,
    idempotencyKey: `bid-user-2-${Date.now()}`,
    ip: "127.0.0.1"
  });
  await bidService.placeBid({
    auctionId: inserted.insertedId,
    userId: "user-3",
    amount: 50,
    idempotencyKey: `bid-user-3-${Date.now()}`,
    ip: "127.0.0.1"
  });

  const closeTime = new Date(endAt.getTime() + 1000);
  const closeTransition = evaluateRoundTransition(liveState, closeTime);
  if (!closeTransition) {
    throw new Error("Round close transition missing.");
  }
  await repository.applyRoundTransition(liveState, closeTransition, closeTime);

  return { auctionId: inserted.insertedId, roundIndex: 0 };
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
