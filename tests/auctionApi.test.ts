// Auction API integration tests for creation, listing, and snapshots.
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
  type AuctionRoundConfig
} from "../src/shared/storage/mongoSchemas.js";
import { registerAuctionRoutes } from "../src/services/auction-engine/routes.js";
import { createAuctionRepository } from "../src/services/auction-engine/auctionStore.js";
import { buildAuctionSnapshotKey, buildRoundStateKey } from "../src/services/auction-engine/auctionKeys.js";
import { evaluateRoundTransition } from "../src/services/auction-engine/roundStateMachine.js";
import { createLedgerRepository } from "../src/services/ledger/ledgerStore.js";

const execFileAsync = promisify(execFile);
const redisDockerImage = "redis:7.2-alpine";
const dockerTimeoutMs = 60000;
const localHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const coreApiToken = "test-core-token";
const coreHeaders = { "x-service-token": coreApiToken };

describe("auction api", () => {
  const testDbName = `crypto_hack_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const redisPrefix = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const config = loadConfig({
    serviceName: "auction-test",
    defaultPort: 4202,
    env: {
      MONGO_DB: testDbName,
      MONGO_URI: "mongodb://127.0.0.1:27018/?directConnection=true&replicaSet=rs0",
      REDIS_URL: "redis://127.0.0.1:6379",
      REDIS_PREFIX: redisPrefix,
      RATE_LIMIT_USER_PER_SECOND: "50",
      RATE_LIMIT_AUCTION_USER_PER_SECOND: "50",
      RATE_LIMIT_IP_PER_SECOND: "200",
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

  it("rejects auction creation with invalid timing", async () => {
    const now = new Date();
    const payload = {
      title: "Bad timing",
      currency: "USDT",
      startsAt: now.toISOString(),
      endsAt: new Date(now.getTime() + 60_000).toISOString(),
      rounds: [
        {
          index: 0,
          allocationSize: 1,
          startAt: new Date(now.getTime() + 10_000).toISOString(),
          endAt: new Date(now.getTime() + 5_000).toISOString(),
          antiSniping: {
            triggerWindowSeconds: 10,
            extensionSeconds: 30,
            maxExtensions: 1
          }
        }
      ]
    };

    const response = await app.inject({
      method: "POST",
      url: "/auctions",
      payload,
      headers: coreHeaders
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { error?: string };
    expect(body.error).toBe("invalid_request");
  });

  it("creates auctions and returns detail", async () => {
    const now = new Date();
    const roundOneStart = new Date(now.getTime() + 60_000);
    const roundOneEnd = new Date(roundOneStart.getTime() + 60_000);
    const roundTwoEnd = new Date(roundOneEnd.getTime() + 60_000);
    const payload = {
      title: "Two round auction",
      description: "Detail check",
      currency: "USDT",
      startsAt: roundOneStart.toISOString(),
      endsAt: roundTwoEnd.toISOString(),
      rounds: [
        {
          index: 0,
          allocationSize: 3,
          startAt: roundOneStart.toISOString(),
          endAt: roundOneEnd.toISOString(),
          antiSniping: {
            triggerWindowSeconds: 10,
            extensionSeconds: 30,
            maxExtensions: 2
          }
        },
        {
          index: 1,
          allocationSize: 2,
          startAt: roundOneEnd.toISOString(),
          endAt: roundTwoEnd.toISOString(),
          antiSniping: {
            triggerWindowSeconds: 5,
            extensionSeconds: 15,
            maxExtensions: 1
          }
        }
      ]
    };

    const createResponse = await app.inject({
      method: "POST",
      url: "/auctions",
      payload,
      headers: coreHeaders
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json() as { auction: { _id: string; rounds: AuctionRoundConfig[] } };
    expect(created.auction.rounds).toHaveLength(2);

    const detailResponse = await app.inject({
      method: "GET",
      url: `/auctions/${created.auction._id}`,
      headers: coreHeaders
    });

    expect(detailResponse.statusCode).toBe(200);
    const detail = detailResponse.json() as { auction: { _id: string; rounds: AuctionRoundConfig[] } };
    expect(detail.auction._id).toBe(created.auction._id);
    expect(detail.auction.rounds).toHaveLength(2);
  });

  it("lists auctions by status with pagination", async () => {
    const now = new Date("2024-01-01T00:00:00Z");
    const upcomingOne = await createAuction(app, now, "Upcoming A");
    const upcomingTwo = await createAuction(app, new Date(now.getTime() + 60_000), "Upcoming B");
    const liveAuction = await createAuction(app, new Date(now.getTime() + 120_000), "Live");
    const closedAuction = await createAuction(app, new Date(now.getTime() + 180_000), "Closed");

    const auctions = mongo.db.collection<AuctionDocument>(mongoCollections.auctions);
    await auctions.updateOne(
      { _id: new ObjectId(liveAuction) },
      { $set: { status: "live", updatedAt: new Date() } }
    );
    await auctions.updateOne(
      { _id: new ObjectId(closedAuction) },
      { $set: { status: "closed", updatedAt: new Date() } }
    );

    const upcomingResponse = await app.inject({
      method: "GET",
      url: "/auctions?status=upcoming&limit=1",
      headers: coreHeaders
    });

    expect(upcomingResponse.statusCode).toBe(200);
    const upcomingBody = upcomingResponse.json() as {
      items: Array<{ _id: string; title: string }>;
      nextCursor: string | null;
    };
    expect(upcomingBody.items).toHaveLength(1);
    expect(upcomingBody.items[0]?.title).toBe("Upcoming A");
    expect(upcomingBody.nextCursor).toBeTruthy();

    const upcomingNext = await app.inject({
      method: "GET",
      url: `/auctions?status=upcoming&limit=1&cursor=${encodeURIComponent(
        upcomingBody.nextCursor ?? ""
      )}`,
      headers: coreHeaders
    });
    const upcomingNextBody = upcomingNext.json() as {
      items: Array<{ _id: string; title: string }>;
      nextCursor: string | null;
    };
    expect(upcomingNextBody.items).toHaveLength(1);
    expect(upcomingNextBody.items[0]?.title).toBe("Upcoming B");
    expect(upcomingNextBody.nextCursor).toBeNull();

    const activeResponse = await app.inject({
      method: "GET",
      url: "/auctions?status=active",
      headers: coreHeaders
    });
    const activeBody = activeResponse.json() as {
      items: Array<{ _id: string; title: string }>;
    };
    expect(activeBody.items.map((item) => item._id)).toContain(liveAuction);

    const closedResponse = await app.inject({
      method: "GET",
      url: "/auctions?status=closed",
      headers: coreHeaders
    });
    const closedBody = closedResponse.json() as {
      items: Array<{ _id: string; title: string }>;
    };
    expect(closedBody.items.map((item) => item._id)).toContain(closedAuction);
    expect(closedBody.items.map((item) => item._id)).not.toContain(upcomingOne);
  });

  it("returns consistent snapshots from redis and mongo", async () => {
    const now = new Date();
    const startAt = new Date(now.getTime() - 60_000);
    const endAt = new Date(now.getTime() + 60_000);
    const auctionId = await createAuction(app, startAt, "Snapshot test", endAt);

    const auctions = mongo.db.collection<AuctionDocument>(mongoCollections.auctions);
    const stored = await auctions.findOne({ _id: new ObjectId(auctionId) });
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
    await auctions.updateOne(
      { _id: new ObjectId(auctionId) },
      { $set: { status: "live", updatedAt: now } }
    );

    const ledger = createLedgerRepository(mongo);
    await ledger.createEntry({
      userId: "user-redis",
      entryType: "deposit_confirmed",
      amount: 500,
      currency: "USDT",
      idempotencyKey: `deposit-${Date.now()}`
    });

    const bidResponse = await app.inject({
      method: "POST",
      url: `/auctions/${auctionId}/bids`,
      payload: {
        userId: "user-redis",
        amount: 120,
        idempotencyKey: `bid-${Date.now()}`
      },
      headers: coreHeaders
    });
    expect(bidResponse.statusCode).toBe(200);

    const snapshotResponse = await app.inject({
      method: "GET",
      url: `/auctions/${auctionId}/snapshot`,
      headers: coreHeaders
    });
    const snapshotRedis = snapshotResponse.json() as {
      snapshot: {
        currentRoundIndex: number;
        roundStatus: string;
        roundEffectiveEndAt: string;
        roundLastBidAt: string | null;
        lastBidAmount: number | null;
      };
    };

    const roundStateResponse = await app.inject({
      method: "GET",
      url: `/auctions/${auctionId}/rounds/0/state`,
      headers: coreHeaders
    });
    const roundRedis = roundStateResponse.json() as {
      state: {
        status: string;
        extensionCount: number;
        scheduledStartAt: string;
        scheduledEndAt: string;
        effectiveEndAt: string;
        allocationSize: number;
      };
    };

    await redis.del(buildAuctionSnapshotKey(auctionId));
    await redis.del(buildRoundStateKey(auctionId, 0));

    const snapshotFallbackResponse = await app.inject({
      method: "GET",
      url: `/auctions/${auctionId}/snapshot`,
      headers: coreHeaders
    });
    const snapshotFallback = snapshotFallbackResponse.json() as {
      snapshot: {
        currentRoundIndex: number;
        roundStatus: string;
        roundEffectiveEndAt: string;
        roundLastBidAt: string | null;
        lastBidAmount: number | null;
      };
    };

    const roundFallbackResponse = await app.inject({
      method: "GET",
      url: `/auctions/${auctionId}/rounds/0/state`,
      headers: coreHeaders
    });
    const roundFallback = roundFallbackResponse.json() as {
      state: {
        status: string;
        extensionCount: number;
        scheduledStartAt: string;
        scheduledEndAt: string;
        effectiveEndAt: string;
        allocationSize: number;
      };
    };

    expect(snapshotFallback.snapshot.currentRoundIndex).toBe(snapshotRedis.snapshot.currentRoundIndex);
    expect(snapshotFallback.snapshot.roundStatus).toBe(snapshotRedis.snapshot.roundStatus);
    expect(snapshotFallback.snapshot.roundEffectiveEndAt).toBe(
      snapshotRedis.snapshot.roundEffectiveEndAt
    );
    expect(snapshotFallback.snapshot.roundLastBidAt).toBe(snapshotRedis.snapshot.roundLastBidAt);
    expect(snapshotFallback.snapshot.lastBidAmount).toBe(snapshotRedis.snapshot.lastBidAmount);

    expect(roundFallback.state.status).toBe(roundRedis.state.status);
    expect(roundFallback.state.extensionCount).toBe(roundRedis.state.extensionCount);
    expect(roundFallback.state.scheduledStartAt).toBe(roundRedis.state.scheduledStartAt);
    expect(roundFallback.state.scheduledEndAt).toBe(roundRedis.state.scheduledEndAt);
    expect(roundFallback.state.effectiveEndAt).toBe(roundRedis.state.effectiveEndAt);
    expect(roundFallback.state.allocationSize).toBe(roundRedis.state.allocationSize);
  }, 20000);
});

async function createAuction(
  app: ReturnType<typeof createServer>,
  startAt: Date,
  title: string,
  endAt?: Date
): Promise<string> {
  const start = startAt;
  const end = endAt ?? new Date(startAt.getTime() + 60_000);
  const payload = {
    title,
    description: "API test",
    currency: "USDT",
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    rounds: [
      {
        index: 0,
        allocationSize: 2,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        antiSniping: {
          triggerWindowSeconds: 10,
          extensionSeconds: 30,
          maxExtensions: 2
        }
      }
    ]
  };

  const response = await app.inject({
    method: "POST",
    url: "/auctions",
    payload,
    headers: coreHeaders
  });
  if (response.statusCode !== 201) {
    throw new Error(`Auction creation failed: ${response.statusCode}`);
  }
  const body = response.json() as { auction: { _id: string } };
  return body.auction._id;
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
