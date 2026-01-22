// Fast bid sync worker to persist Redis-accepted bids into MongoDB.
import type { FastifyInstance } from "fastify";
import { ObjectId, type WithId } from "mongodb";
import type { ServiceDependencies } from "../../shared/service.js";
import { runMongoTransaction } from "../../shared/storage/mongoTransaction.js";
import { acquireRedisLock, releaseRedisLock } from "../../shared/storage/redisLock.js";
import { computeExpiresAt, resolveRetentionMs } from "../../shared/storage/retention.js";
import { applyBalanceDelta } from "../../shared/ledgerBalanceCache.js";
import {
  mongoCollections,
  type AuctionDocument,
  type AuctionRoundConfig,
  type AuctionWatchlistDocument,
  type BidDocument,
  type NotificationQueueDocument
} from "../../shared/storage/mongoSchemas.js";
import { createLedgerRepository } from "../ledger/ledgerStore.js";
import { buildBidSyncQueueKey } from "../auction-engine/auctionKeys.js";
import { createAuctionRepository } from "../auction-engine/auctionStore.js";

type FastBidEvent = {
  bidId: string;
  auctionId: string;
  userId: string;
  amount: number;
  maxAmount: number;
  maxAmountProvided: number;
  createdAtMs: number;
  idempotencyKey: string;
  roundIndex: number;
  origin?: BidDocument["origin"];
  currency: string;
  delta: number;
  previousBidId?: string | null;
  previousMaxAmount?: number;
  metadata?: Record<string, unknown> | null;
  audit?: BidDocument["audit"];
};

const syncLockKey = "bids:sync:lock";
const syncLockTtlMs = 10000;
const minDelayMs = 25;
const maxDelayMs = 10000;

const popSyncBatchScript = `
local queueKey = KEYS[1]
local batchSize = tonumber(ARGV[1]) or 0
if batchSize <= 0 then
  return {}
end
local items = redis.call("LRANGE", queueKey, 0, batchSize - 1)
if #items > 0 then
  redis.call("LTRIM", queueKey, batchSize, -1)
end
return items
`;

type PopSyncBatchRedis = ServiceDependencies["redis"] & {
  popBidSyncBatch?: (queueKey: string, batchSize: string) => Promise<string[]>;
};

function ensurePopSyncBatch(redis: ServiceDependencies["redis"]): PopSyncBatchRedis {
  const client = redis as PopSyncBatchRedis;
  if (!client.popBidSyncBatch) {
    client.defineCommand("popBidSyncBatch", { numberOfKeys: 1, lua: popSyncBatchScript });
  }
  return client;
}

export async function registerBidSyncWorker(
  app: FastifyInstance,
  deps: ServiceDependencies
): Promise<void> {
  const auctionRepository = createAuctionRepository(deps.mongo);
  const ledger = createLedgerRepository(deps.mongo, {
    retentionDays: deps.config.dataRetention.ledgerDays,
    redis: deps.redis,
    logger: deps.logger
  });
  const bids = deps.mongo.db.collection<BidDocument>(mongoCollections.bids);
  const watchlist = deps.mongo.db.collection<AuctionWatchlistDocument>(
    mongoCollections.auctionWatchlist
  );
  const notificationQueue = deps.mongo.db.collection<NotificationQueueDocument>(
    mongoCollections.notificationQueue
  );
  const auctions = deps.mongo.db.collection<AuctionDocument>(mongoCollections.auctions);
  const bidRetentionMs = resolveRetentionMs(deps.config.dataRetention.bidsDays);
  const notificationRetentionMs = resolveRetentionMs(deps.config.dataRetention.notificationsDays);
  const syncQueueKey = buildBidSyncQueueKey();
  const syncIntervalMs = Math.max(minDelayMs, deps.config.bids.fastSyncIntervalMs);
  const batchSize = Math.max(1, deps.config.bids.fastSyncBatchSize);
  let running = true;
  let timeout: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (!running) {
      return;
    }

    const client = ensurePopSyncBatch(deps.redis);
    let lock: Awaited<ReturnType<typeof acquireRedisLock>> | null = null;
    try {
      lock = await acquireRedisLock(deps.redis, syncLockKey, syncLockTtlMs);
    } catch (error) {
      deps.logger.warn({ err: error }, "Bid sync lock unavailable");
    }

    if (!lock) {
      scheduleNext(syncIntervalMs);
      return;
    }

    try {
      const batch = await client.popBidSyncBatch(syncQueueKey, batchSize.toString());
      if (!batch || batch.length === 0) {
        scheduleNext(syncIntervalMs);
        return;
      }

      for (const raw of batch) {
        const event = parseFastBidEvent(raw);
        if (!event) {
          deps.logger.warn("Skipped invalid fast bid payload");
          continue;
        }
        try {
          await applyFastBidEvent(event, {
            auctionRepository,
            ledger,
            auctions,
            bids,
            watchlist,
            notificationQueue,
            bidRetentionMs,
            notificationRetentionMs,
            deps
          });
        } catch (error) {
          deps.logger.error(
            { err: error, bidId: event.bidId, auctionId: event.auctionId },
            "Failed to sync fast bid"
          );
        }
      }
    } finally {
      if (lock) {
        await releaseRedisLock(deps.redis, lock);
      }
      scheduleNext(syncIntervalMs);
    }
  };

  const scheduleNext = (delayMs: number) => {
    if (timeout) {
      clearTimeout(timeout);
    }
    const clamped = Math.min(maxDelayMs, Math.max(minDelayMs, delayMs));
    timeout = setTimeout(() => {
      void tick();
    }, clamped);
  };

  scheduleNext(0);

  app.addHook("onClose", async () => {
    running = false;
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
  });
}

async function applyFastBidEvent(
  event: FastBidEvent,
  context: {
    auctionRepository: ReturnType<typeof createAuctionRepository>;
    ledger: ReturnType<typeof createLedgerRepository>;
    auctions: ReturnType<ServiceDependencies["mongo"]["db"]["collection"]>;
    bids: ReturnType<ServiceDependencies["mongo"]["db"]["collection"]>;
    watchlist: ReturnType<ServiceDependencies["mongo"]["db"]["collection"]>;
    notificationQueue: ReturnType<ServiceDependencies["mongo"]["db"]["collection"]>;
    bidRetentionMs: number;
    notificationRetentionMs: number;
    deps: ServiceDependencies;
  }
): Promise<void> {
  const bidId = new ObjectId(event.bidId);
  const auctionId = new ObjectId(event.auctionId);
  const createdAt = new Date(event.createdAtMs);

  let holdEntryCreatedAt: Date | null = null;
  await runMongoTransaction(context.deps.mongo, async (session) => {
    const auction = (await context.auctions.findOne({ _id: auctionId }, { session })) as
      | WithId<AuctionDocument>
      | null;
    if (!auction) {
      throw new Error(`Auction not found for bid ${event.bidId}.`);
    }

    const roundConfig = findRoundConfig(auction.rounds, event.roundIndex);
    let previousTop: Pick<BidDocument, "_id" | "userId" | "amount" | "createdAt"> | null = null;
    try {
      previousTop = await context.bids
        .find({ auctionId, active: true }, { session })
        .sort({ amount: -1, createdAt: 1, _id: 1 })
        .project<Pick<BidDocument, "_id" | "userId" | "amount" | "createdAt">>({
          _id: 1,
          userId: 1,
          amount: 1,
          createdAt: 1
        })
        .limit(1)
        .next();
    } catch {
      previousTop = null;
    }

    const existing = await context.bids.findOne(
      { idempotencyKey: event.idempotencyKey },
      { session }
    );
    if (existing) {
      if (!matchesIdempotentBid(existing, event)) {
        throw new Error(`Idempotency mismatch for bid ${event.bidId}.`);
      }
      return;
    }

    if (event.previousBidId) {
      const previousId = new ObjectId(event.previousBidId);
      const inactiveUpdate: Record<string, unknown> = {
        active: false,
        inactiveAt: createdAt
      };
      const expiresAt = computeExpiresAt(createdAt, context.bidRetentionMs);
      if (expiresAt) {
        inactiveUpdate.expiresAt = expiresAt;
      }
      await context.bids.updateOne(
        { _id: previousId, active: true },
        { $set: inactiveUpdate },
        { session }
      );
    }

    const bidDoc: BidDocument & { _id: ObjectId } = {
      _id: bidId,
      auctionId,
      userId: event.userId,
      amount: event.amount,
      createdAt,
      idempotencyKey: event.idempotencyKey,
      active: true,
      roundIndex: event.roundIndex,
      origin: event.origin ?? "manual"
    };

    if (event.maxAmountProvided === 1) {
      bidDoc.maxAmount = event.maxAmount;
    }

    const expiresAt = computeExpiresAt(createdAt, context.bidRetentionMs);
    if (expiresAt) {
      bidDoc.expiresAt = expiresAt;
    }
    if (event.audit) {
      bidDoc.audit = event.audit;
    }

    await context.bids.insertOne(bidDoc, { session });
    await context.watchlist.updateOne(
      { userId: event.userId, auctionId },
      {
        $setOnInsert: { userId: event.userId, auctionId, createdAt },
        $set: { updatedAt: createdAt, notifyOutbid: true }
      },
      { upsert: true, session }
    );

    if (event.delta > 0) {
      const holdInput = {
        userId: event.userId,
        amount: event.delta,
        currency: event.currency,
        holdId: buildHoldId(bidId),
        idempotencyKey: buildHoldIdempotencyKey(event.idempotencyKey),
        metadata: buildHoldMetadata(
          event.metadata ?? undefined,
          auctionId.toHexString(),
          event.roundIndex,
          bidId.toHexString(),
          event.amount,
          event.maxAmount,
          event.origin
        ),
        audit: event.audit
      };

      const result = await context.ledger.createHoldInSession(holdInput, session);
      holdEntryCreatedAt = result.entry.createdAt ?? createdAt;
    }

    const roundUpdate = await context.auctionRepository.applyBidAntiSniping(
      auction,
      event.roundIndex,
      createdAt,
      session
    );

    const bidIsLatest =
      !roundUpdate.state.lastBidAt ||
      roundUpdate.state.lastBidAt.getTime() <= createdAt.getTime();

    const shouldUpdateSnapshot =
      auction.currentRoundIndex === undefined || auction.currentRoundIndex === event.roundIndex;
    if (shouldUpdateSnapshot) {
      await context.auctionRepository.updateAuctionSnapshot(
        auctionId,
        {
          currentRoundIndex: event.roundIndex,
          roundStatus: roundUpdate.state.status,
          roundEffectiveEndAt: roundUpdate.state.effectiveEndAt,
          roundLastBidAt: roundUpdate.state.lastBidAt ?? createdAt,
          lastBidAmount: bidIsLatest ? event.amount : null
        },
        createdAt,
        session
      );
    }

    if (previousTop) {
      const currentTop = await context.bids
        .find({ auctionId, active: true }, { session })
        .sort({ amount: -1, createdAt: 1, _id: 1 })
        .project<Pick<BidDocument, "_id" | "userId" | "amount" | "createdAt">>({
          _id: 1,
          userId: 1,
          amount: 1,
          createdAt: 1
        })
        .limit(1)
        .next();
      if (currentTop && currentTop.userId !== previousTop.userId) {
        await queueOutbidNotification(
          context,
          auction,
          roundConfig,
          previousTop,
          currentTop,
          createdAt
        );
      }
    }
  });

  if (event.delta > 0 && holdEntryCreatedAt) {
    await applyBalanceDelta(
      context.deps.redis,
      {
        userId: event.userId,
        currency: event.currency,
        amount: event.delta,
        entryType: "hold_created",
        idempotencyKey: buildHoldIdempotencyKey(event.idempotencyKey),
        updatedAt: holdEntryCreatedAt
      }
    );
  }
}

async function queueOutbidNotification(
  context: {
    notificationQueue: ReturnType<ServiceDependencies["mongo"]["db"]["collection"]>;
    notificationRetentionMs: number;
    deps: ServiceDependencies;
  },
  auction: AuctionDocument,
  roundConfig: AuctionRoundConfig,
  previousTop: Pick<BidDocument, "_id" | "userId" | "amount" | "createdAt">,
  currentTop: Pick<BidDocument, "_id" | "userId" | "amount" | "createdAt">,
  now: Date
): Promise<void> {
  const auctionIdText = auction._id.toHexString();
  const roundIndex = roundConfig.index;
  const minIncrement = normalizeNonNegative(auction.minIncrement);
  const rebidAmount = normalizeBidAmount(currentTop.amount + Math.max(0, minIncrement));
  const payload: Record<string, unknown> = {
    auctionId: auctionIdText,
    roundIndex,
    auctionTitle: auction.title,
    currency: auction.currency,
    previousAmount: previousTop.amount,
    currentAmount: currentTop.amount,
    rebidAmount,
    currentLeader: currentTop.userId,
    bidId: currentTop._id.toHexString()
  };
  const replayUrl = buildReplayUrl(context.deps.config.web.publicUrl, auctionIdText, roundIndex);
  if (replayUrl) {
    payload.replayUrl = replayUrl;
  }

  const idempotencyKey = buildOutbidIdempotencyKey(
    auctionIdText,
    roundIndex,
    previousTop.userId,
    currentTop._id.toHexString()
  );
  const expiresAt = computeExpiresAt(now, context.notificationRetentionMs);
  const update: Record<string, unknown> = {
    type: "outbid_alert",
    userId: previousTop.userId,
    auctionId: auction._id,
    roundIndex,
    status: "pending",
    payload,
    idempotencyKey,
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now
  };
  if (expiresAt) {
    update.expiresAt = expiresAt;
  }

  await context.notificationQueue.updateOne(
    { idempotencyKey },
    { $setOnInsert: update },
    { upsert: true }
  );
}

function parseFastBidEvent(raw: string): FastBidEvent | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as FastBidEvent;
    if (!parsed.bidId || !parsed.auctionId || !parsed.userId) {
      return null;
    }
    if (!Number.isFinite(parsed.amount) || parsed.amount <= 0) {
      return null;
    }
    if (!Number.isFinite(parsed.maxAmount) || parsed.maxAmount <= 0) {
      return null;
    }
    if (!Number.isFinite(parsed.createdAtMs)) {
      return null;
    }
    if (!Number.isFinite(parsed.roundIndex)) {
      return null;
    }
    if (!Number.isFinite(parsed.delta) || parsed.delta < 0) {
      return null;
    }
    if (parsed.maxAmountProvided !== 0 && parsed.maxAmountProvided !== 1) {
      return null;
    }
    if (!parsed.idempotencyKey || !parsed.currency) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function matchesIdempotentBid(existing: BidDocument, event: FastBidEvent): boolean {
  if (existing.userId !== event.userId) {
    return false;
  }
  if (existing.amount !== event.amount) {
    return false;
  }
  if (!existing.auctionId.equals(new ObjectId(event.auctionId))) {
    return false;
  }
  const existingMax = existing.maxAmount ?? null;
  if (event.maxAmountProvided === 1) {
    return existingMax === event.maxAmount;
  }
  return existingMax === null;
}

function buildHoldMetadata(
  metadata: Record<string, unknown> | undefined,
  auctionId: string,
  roundIndex: number,
  bidId: string,
  bidAmount: number,
  maxAmount: number,
  origin: BidDocument["origin"] | undefined
): Record<string, unknown> {
  const merged = metadata ? { ...metadata } : {};
  const entries: Array<[string, unknown]> = [
    ["auctionId", auctionId],
    ["roundIndex", roundIndex],
    ["bidId", bidId],
    ["bidAmount", bidAmount],
    ["maxAmount", maxAmount],
    ["bidOrigin", origin ?? "manual"]
  ];

  for (const [key, value] of entries) {
    if (key in merged && merged[key] !== value) {
      throw new Error(`${key} metadata mismatch.`);
    }
    merged[key] = value;
  }

  return merged;
}

function buildHoldId(bidId: ObjectId): string {
  return `bid:${bidId.toHexString()}`;
}

function buildHoldIdempotencyKey(idempotencyKey: string): string {
  return `hold:${idempotencyKey}`;
}

function buildOutbidIdempotencyKey(
  auctionId: string,
  roundIndex: number,
  userId: string,
  bidId: string
): string {
  return `outbid:${auctionId}:${roundIndex}:${userId}:${bidId}`;
}

function buildReplayUrl(
  baseUrl: string | undefined,
  auctionId: string,
  roundIndex: number
): string | null {
  if (!baseUrl) {
    return null;
  }
  const normalized = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${normalized}/?replay=${auctionId}:${roundIndex}`;
}

function normalizeBidAmount(value: number): number {
  const scaled = Math.round(value * 1e8);
  return scaled / 1e8;
}

function normalizeNonNegative(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value < 0 ? 0 : value;
}

function findRoundConfig(rounds: AuctionRoundConfig[], roundIndex: number): AuctionRoundConfig {
  const round = rounds.find((entry) => entry.index === roundIndex);
  if (!round) {
    throw new Error(`Round config missing for index ${roundIndex}.`);
  }
  return round;
}
