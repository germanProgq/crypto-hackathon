// Bid placement workflow with locking, ledger holds, and Redis caching.
import { ObjectId, type WithId } from "mongodb";
import type { ServiceDependencies } from "../../shared/service.js";
import { runMongoTransaction } from "../../shared/storage/mongoTransaction.js";
import { acquireRedisLock, releaseRedisLock } from "../../shared/storage/redisLock.js";
import type { RedisClient } from "../../shared/storage/redis.js";
import {
  mongoCollections,
  type AuctionDocument,
  type AuctionRoundConfig,
  type AuctionRoundStateDocument,
  type BidDocument
} from "../../shared/storage/mongoSchemas.js";
import {
  createLedgerRepository,
  type LedgerBalance,
  type HoldOperationInput
} from "../ledger/ledgerStore.js";
import {
  buildAuctionSnapshotKey,
  buildAuctionUserRateLimitKey,
  buildBidIdempotencyKey,
  buildIpRateLimitKey,
  buildRankingKey,
  buildRoundStateKey,
  buildTopKey,
  buildUserRateLimitKey
} from "./auctionKeys.js";
import {
  buildAuctionSnapshotFields,
  buildRoundStateFields,
  primeAuctionSnapshotCache,
  primeRoundStateCache,
  roundStateTtlSeconds,
  snapshotTtlSeconds,
  type AuctionSnapshotCache,
  type RoundStateCache
} from "./auctionCache.js";
import { createAuctionRepository } from "./auctionStore.js";
import { buildRankingMember } from "./bidRanking.js";
import { publishRealtimeEvent, toRealtimeSnapshot } from "../../shared/realtime/events.js";

const bidLockTtlMs = 8000;
const topSetTtlSeconds = 10;
const bidIdempotencyTtlSeconds = 600;
const idempotencyWaitMs = 750;
const idempotencyPollMs = 50;
const bidLockWaitMs = 1500;
const bidLockPollMs = 25;

const rateLimitScript = `
local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
if not capacity or not refillRate or capacity <= 0 or refillRate <= 0 then
  return 0
end

local time = redis.call("TIME")
local nowMs = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local bucket = redis.call("HMGET", KEYS[1], "tokens", "ts")
local tokens = tonumber(bucket[1])
local lastMs = tonumber(bucket[2])

if not tokens then
  tokens = capacity
end

if not lastMs then
  lastMs = nowMs
end

if tokens > capacity then
  tokens = capacity
end

if tokens < capacity then
  local deltaMs = nowMs - lastMs
  if deltaMs > 0 then
    local refill = (deltaMs / 1000) * refillRate
    tokens = math.min(capacity, tokens + refill)
  end
end

local allowed = tokens >= 1
if allowed then
  tokens = tokens - 1
end

redis.call("HSET", KEYS[1], "tokens", tokens, "ts", nowMs)

local ttlSeconds = math.ceil((capacity / refillRate) * 2)
if ttlSeconds < 1 then
  ttlSeconds = 1
end
redis.call("EXPIRE", KEYS[1], ttlSeconds)

return allowed and 1 or 0
`;

const bidCacheUpdateScript = `
local rankingKey = KEYS[1]
local roundStateKey = KEYS[2]
local snapshotKey = KEYS[3]
local topKey = KEYS[4]
local idempotencyKey = KEYS[5]

local updateRanking = ARGV[1] == "1"
local bidAmount = ARGV[2]
local rankingMember = ARGV[3]
local previousMember = ARGV[4]
local roundStateTtl = tonumber(ARGV[5])
local snapshotTtl = tonumber(ARGV[6])
local idempotencyTtl = tonumber(ARGV[7])
local topSetTtl = tonumber(ARGV[8])
local topCount = tonumber(ARGV[9])

local index = 10
local roundFieldCount = tonumber(ARGV[index]) or 0
index = index + 1
local roundArgs = {}
for i = 1, roundFieldCount * 2 do
  roundArgs[i] = ARGV[index]
  index = index + 1
end

local snapshotFieldCount = tonumber(ARGV[index]) or 0
index = index + 1
local snapshotArgs = {}
for i = 1, snapshotFieldCount * 2 do
  snapshotArgs[i] = ARGV[index]
  index = index + 1
end

local idempotencyValue = ARGV[index]

if updateRanking then
  redis.call("ZADD", rankingKey, bidAmount, rankingMember)
  if previousMember and previousMember ~= "" then
    redis.call("ZREM", rankingKey, previousMember)
  end
end

if roundFieldCount > 0 then
  redis.call("HSET", roundStateKey, unpack(roundArgs))
  if roundStateTtl and roundStateTtl > 0 then
    redis.call("EXPIRE", roundStateKey, roundStateTtl)
  end
end

if snapshotFieldCount > 0 then
  redis.call("HSET", snapshotKey, unpack(snapshotArgs))
  if snapshotTtl and snapshotTtl > 0 then
    redis.call("EXPIRE", snapshotKey, snapshotTtl)
  end
end

if idempotencyTtl and idempotencyTtl > 0 then
  redis.call("SET", idempotencyKey, idempotencyValue, "EX", idempotencyTtl)
else
  redis.call("SET", idempotencyKey, idempotencyValue)
end

redis.call("DEL", topKey)
if topCount and topCount > 0 then
  local topMembers = redis.call("ZREVRANGE", rankingKey, 0, topCount - 1)
  local bidIds = {}
  for i = 1, #topMembers do
    local member = topMembers[i]
    local sep = string.find(member, ":")
    if sep then
      local bidId = string.sub(member, sep + 1)
      if bidId and bidId ~= "" then
        table.insert(bidIds, bidId)
      end
    end
  end

  if #bidIds > 0 then
    redis.call("SADD", topKey, unpack(bidIds))
    if topSetTtl and topSetTtl > 0 then
      redis.call("EXPIRE", topKey, topSetTtl)
    end
  end
end

return 1
`;

export type BidErrorCode =
  | "invalid_request"
  | "auction_not_found"
  | "auction_not_live"
  | "round_not_found"
  | "round_not_live"
  | "bid_too_low"
  | "round_locked"
  | "rate_limited"
  | "idempotency_conflict";

export class BidError extends Error {
  readonly code: BidErrorCode;
  readonly status: number;

  constructor(code: BidErrorCode, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface BidPlacementInput {
  auctionId: ObjectId;
  userId: string;
  amount: number;
  idempotencyKey: string;
  audit?: BidDocument["audit"];
  metadata?: Record<string, unknown>;
  ip: string;
}

export interface BidPlacementResult {
  bid: WithId<BidDocument>;
  balance: LedgerBalance;
  roundState: WithId<AuctionRoundStateDocument>;
  extended: boolean;
  idempotent: boolean;
}

type BidTransactionResult = BidPlacementResult & {
  auction: WithId<AuctionDocument>;
  roundConfig: AuctionRoundConfig;
  previousBid?: WithId<BidDocument> | null;
  updateRanking: boolean;
};

export function createBidService(deps: ServiceDependencies) {
  const auctionRepository = createAuctionRepository(deps.mongo);
  const ledger = createLedgerRepository(deps.mongo);
  const bids = deps.mongo.db.collection<BidDocument>(mongoCollections.bids);

  async function placeBid(input: BidPlacementInput): Promise<BidPlacementResult> {
    await enforceRateLimits(deps.redis, deps.config.rateLimits, input);

    const existing = await resolveIdempotentBid(input);
    if (existing) {
      return toPlacementResult(existing);
    }

    const lockKey = buildBidLockKey(input.auctionId.toHexString());
    const lock = await acquireBidLock(deps.redis, lockKey, bidLockTtlMs, bidLockWaitMs);
    if (!lock) {
      const waited = await waitForIdempotentBid(input, idempotencyWaitMs);
      if (waited) {
        return toPlacementResult(waited);
      }
      throw new BidError("round_locked", "Round is processing another bid.", 409);
    }

    try {
      const result = await runMongoTransaction(deps.mongo, async (session) => {
        const auction = await auctionRepository.getAuctionById(input.auctionId, session);
        if (!auction) {
          throw new BidError("auction_not_found", "Auction not found.", 404);
        }

        const roundState = await auctionRepository.getLiveRoundState(input.auctionId, session);
        if (!roundState) {
          throw new BidError("round_not_live", "No live round available.", 409);
        }
        const roundConfig = findRoundConfig(auction.rounds, roundState.roundIndex);

        const existingBid = await bids.findOne(
          { idempotencyKey: input.idempotencyKey },
          { session }
        );
        if (existingBid) {
          if (!matchesIdempotentBid(existingBid, input)) {
            throw new BidError(
              "idempotency_conflict",
              "Idempotency key does not match bid payload.",
              409
            );
          }

          const resolvedRoundIndex = existingBid.roundIndex ?? roundState.roundIndex;
          const resolvedRoundState =
            existingBid.roundIndex !== undefined
              ? await auctionRepository.getRoundState(
                  input.auctionId,
                  existingBid.roundIndex,
                  session
                )
              : roundState;
          if (!resolvedRoundState) {
            throw new BidError("round_not_found", "Round state not found.", 404);
          }
          const resolvedRoundConfig = findRoundConfig(auction.rounds, resolvedRoundIndex);

          const balance = await ledger.getBalanceInSession(
            input.userId,
            auction.currency,
            session
          );

          return {
            bid: existingBid,
            balance,
            roundState: resolvedRoundState,
            extended: false,
            idempotent: true,
            auction,
            roundConfig: resolvedRoundConfig,
            updateRanking: existingBid.active
          };
        }

        const now = new Date();
        assertAuctionLive(auction, now);
        assertRoundLive(roundState, now);

        const previousBid = await bids.findOne(
          {
            auctionId: input.auctionId,
            userId: input.userId,
            active: true
          },
          {
            session,
            sort: { createdAt: -1, _id: -1 }
          }
        );

        if (previousBid && input.amount <= previousBid.amount) {
          throw new BidError("bid_too_low", "Bid must exceed the current amount.", 409);
        }

        const delta = input.amount - (previousBid?.amount ?? 0);
        if (delta <= 0) {
          throw new BidError("bid_too_low", "Bid must exceed the current amount.", 409);
        }

        const bidId = new ObjectId();
        if (previousBid) {
          await bids.updateOne(
            { _id: previousBid._id, active: true },
            { $set: { active: false, inactiveAt: now } },
            { session }
          );
        }

        const bidDoc: WithId<BidDocument> = {
          _id: bidId,
          auctionId: input.auctionId,
          userId: input.userId,
          amount: input.amount,
          createdAt: now,
          idempotencyKey: input.idempotencyKey,
          active: true,
          roundIndex: roundState.roundIndex
        };

        if (input.audit) {
          bidDoc.audit = input.audit;
        }

        await bids.insertOne(bidDoc, { session });

        const holdInput: HoldOperationInput = {
          userId: input.userId,
          amount: delta,
          currency: auction.currency,
          holdId: buildHoldId(bidId),
          idempotencyKey: buildHoldIdempotencyKey(input.idempotencyKey),
          metadata: buildHoldMetadata(
            input.metadata,
            auction._id.toHexString(),
            roundState.roundIndex,
            bidId.toHexString(),
            input.amount
          ),
          audit: input.audit
        };

        const holdResult = await ledger.createHoldInSession(holdInput, session);
        const antiSniping = await auctionRepository.applyBidAntiSniping(
          auction,
          roundState.roundIndex,
          now,
          session
        );

        const lastBidAt = antiSniping.state.lastBidAt ?? now;
        const bidIsLatest =
          !antiSniping.state.lastBidAt ||
          antiSniping.state.lastBidAt.getTime() === now.getTime();
        await auctionRepository.updateAuctionSnapshot(
          auction._id,
          {
            currentRoundIndex: antiSniping.state.roundIndex,
            roundStatus: antiSniping.state.status,
            roundEffectiveEndAt: antiSniping.state.effectiveEndAt,
            roundLastBidAt: lastBidAt,
            lastBidAmount: bidIsLatest ? bidDoc.amount : null
          },
          now,
          session
        );

        return {
          bid: bidDoc,
          balance: holdResult.balance,
          roundState: antiSniping.state,
          extended: antiSniping.extended,
          idempotent: false,
          auction,
          roundConfig,
          previousBid,
          updateRanking: true
        };
      });

      const { snapshot } = await updateRedisCaches(deps.redis, result);
      try {
        await publishRealtimeEvent(deps.redis, {
          type: "auction.snapshot.updated",
          auctionId: snapshot.auctionId,
          snapshot: toRealtimeSnapshot({ ...snapshot, serverTime: new Date() })
        });
        await publishRealtimeEvent(deps.redis, {
          type: "auction.bids.updated",
          auctionId: snapshot.auctionId
        });
        await publishRealtimeEvent(deps.redis, {
          type: "bids.active.updated",
          userIds: [result.bid.userId]
        });
      } catch (error) {
        deps.logger.warn({ err: error }, "Failed to publish realtime bid updates");
      }
      return toPlacementResult(result);
    } finally {
      await releaseRedisLock(deps.redis, lock);
    }
  }

  async function resolveIdempotentBid(
    input: BidPlacementInput
  ): Promise<BidTransactionResult | null> {
    const existingBid = await bids.findOne({ idempotencyKey: input.idempotencyKey });
    if (!existingBid) {
      return null;
    }

    if (!matchesIdempotentBid(existingBid, input)) {
      throw new BidError(
        "idempotency_conflict",
        "Idempotency key does not match bid payload.",
        409
      );
    }

    const auction = await auctionRepository.getAuctionById(input.auctionId);
    if (!auction) {
      throw new BidError("auction_not_found", "Auction not found.", 404);
    }

    const roundState =
      existingBid.roundIndex !== undefined
        ? await auctionRepository.getRoundState(input.auctionId, existingBid.roundIndex)
        : await auctionRepository.getLiveRoundState(input.auctionId);
    if (!roundState) {
      throw new BidError("round_not_live", "No live round available.", 409);
    }
    const roundConfig = findRoundConfig(auction.rounds, roundState.roundIndex);

    const balance = await ledger.getBalance(input.userId, auction.currency);

    return {
      bid: existingBid,
      balance,
      roundState,
      extended: false,
      idempotent: true,
      auction,
      roundConfig,
      updateRanking: existingBid.active
    };
  }

  async function waitForIdempotentBid(
    input: BidPlacementInput,
    timeoutMs: number
  ): Promise<BidTransactionResult | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const resolved = await resolveIdempotentBid(input);
      if (resolved) {
        return resolved;
      }
      await delay(idempotencyPollMs);
    }
    return null;
  }

  return { placeBid };
}

function toPlacementResult(result: BidTransactionResult): BidPlacementResult {
  return {
    bid: result.bid,
    balance: result.balance,
    roundState: result.roundState,
    extended: result.extended,
    idempotent: result.idempotent
  };
}

async function updateRedisCaches(
  redis: RedisClient,
  result: BidTransactionResult
): Promise<{ snapshot: AuctionSnapshotCache }> {
  const auctionIdText = result.auction._id.toHexString();
  const rankingKey = buildRankingKey(auctionIdText);
  const roundStateKey = buildRoundStateKey(auctionIdText, result.roundState.roundIndex);
  const auctionSnapshotKey = buildAuctionSnapshotKey(auctionIdText);
  const topKey = buildTopKey(auctionIdText);
  const idempotencyKey = buildBidIdempotencyKey(result.bid.idempotencyKey);

  const rankingMember = buildRankingMember(result.bid._id, result.bid.createdAt);
  const previousMember = result.previousBid
    ? buildRankingMember(result.previousBid._id, result.previousBid.createdAt)
    : null;

  const updatedAt = new Date();
  const lastBidAt = result.roundState.lastBidAt ?? result.bid.createdAt;
  const bidIsLatest =
    !result.roundState.lastBidAt ||
    result.roundState.lastBidAt.getTime() === result.bid.createdAt.getTime();

  const roundStateCache: RoundStateCache = {
    status: result.roundState.status,
    roundIndex: result.roundState.roundIndex,
    scheduledStartAt: result.roundState.scheduledStartAt,
    scheduledEndAt: result.roundState.scheduledEndAt,
    effectiveEndAt: result.roundState.effectiveEndAt,
    extensionCount: result.roundState.extensionCount,
    lastBidAt,
    startedAt: result.roundState.startedAt ?? null,
    closedAt: result.roundState.closedAt ?? null,
    allocationSize: result.roundConfig.allocationSize
  };

  const snapshot: AuctionSnapshotCache = {
    auctionId: result.auction._id.toHexString(),
    status: result.auction.status,
    title: result.auction.title,
    currency: result.auction.currency,
    currentRoundIndex: result.roundState.roundIndex,
    roundStatus: result.roundState.status,
    roundEffectiveEndAt: result.roundState.effectiveEndAt,
    roundLastBidAt: lastBidAt,
    updatedAt,
    lastBidAmount: bidIsLatest ? result.bid.amount : null
  };

  const roundStateFields = buildRoundStateFields(roundStateCache, updatedAt);
  const snapshotFields = buildAuctionSnapshotFields(snapshot);
  const roundStateArgs = flattenRedisHashFields(roundStateFields);
  const snapshotArgs = flattenRedisHashFields(snapshotFields);
  const topCount = Math.max(1, result.roundConfig.allocationSize);
  const scriptArgs = [
    result.updateRanking ? "1" : "0",
    result.bid.amount.toString(),
    rankingMember,
    previousMember ?? "",
    roundStateTtlSeconds.toString(),
    snapshotTtlSeconds.toString(),
    bidIdempotencyTtlSeconds.toString(),
    topSetTtlSeconds.toString(),
    topCount.toString(),
    (roundStateArgs.length / 2).toString(),
    ...roundStateArgs,
    (snapshotArgs.length / 2).toString(),
    ...snapshotArgs,
    result.bid._id.toHexString()
  ];

  await redis.eval(
    bidCacheUpdateScript,
    5,
    rankingKey,
    roundStateKey,
    auctionSnapshotKey,
    topKey,
    idempotencyKey,
    ...scriptArgs
  );
  primeRoundStateCache(auctionIdText, roundStateCache);
  primeAuctionSnapshotCache(snapshot);
  return { snapshot };
}

async function enforceRateLimits(
  redis: RedisClient,
  limits: ServiceDependencies["config"]["rateLimits"],
  input: BidPlacementInput
): Promise<void> {
  await consumeRateLimit(redis, buildUserRateLimitKey(input.userId), limits.userPerSecond);
  await consumeRateLimit(
    redis,
    buildAuctionUserRateLimitKey(input.auctionId.toHexString(), input.userId),
    limits.auctionUserPerSecond
  );
  await consumeRateLimit(redis, buildIpRateLimitKey(input.ip), limits.ipPerSecond);
}

async function consumeRateLimit(
  redis: RedisClient,
  key: string,
  limit: number
): Promise<void> {
  const value = await redis.eval(rateLimitScript, 1, key, limit.toString(), limit.toString());
  const allowed = Number(value);
  if (!Number.isFinite(allowed)) {
    throw new BidError("rate_limited", "Rate limit unavailable.", 429);
  }
  if (allowed !== 1) {
    throw new BidError("rate_limited", "Rate limit exceeded.", 429);
  }
}

function assertAuctionLive(auction: WithId<AuctionDocument>, now: Date): void {
  if (auction.status !== "live") {
    throw new BidError("auction_not_live", "Auction is not live.", 409);
  }

  if (now.getTime() < auction.startsAt.getTime() || now.getTime() > auction.endsAt.getTime()) {
    throw new BidError("auction_not_live", "Auction is outside the active window.", 409);
  }
}

function assertRoundLive(roundState: WithId<AuctionRoundStateDocument>, now: Date): void {
  if (roundState.status !== "live") {
    throw new BidError("round_not_live", "Round is not live.", 409);
  }

  if (
    now.getTime() < roundState.scheduledStartAt.getTime() ||
    now.getTime() > roundState.effectiveEndAt.getTime()
  ) {
    throw new BidError("round_not_live", "Round is outside the active window.", 409);
  }
}

function findRoundConfig(rounds: AuctionRoundConfig[], roundIndex: number): AuctionRoundConfig {
  const round = rounds.find((entry) => entry.index === roundIndex);
  if (!round) {
    throw new BidError("round_not_found", "Round config missing.", 404);
  }
  return round;
}

function matchesIdempotentBid(bid: BidDocument, input: BidPlacementInput): boolean {
  return (
    bid.userId === input.userId &&
    bid.amount === input.amount &&
    bid.auctionId.equals(input.auctionId)
  );
}

function buildHoldMetadata(
  metadata: Record<string, unknown> | undefined,
  auctionId: string,
  roundIndex: number,
  bidId: string,
  bidAmount: number
): Record<string, unknown> {
  const merged = metadata ? { ...metadata } : {};
  const entries: Array<[string, unknown]> = [
    ["auctionId", auctionId],
    ["roundIndex", roundIndex],
    ["bidId", bidId],
    ["bidAmount", bidAmount]
  ];

  for (const [key, value] of entries) {
    if (key in merged && merged[key] !== value) {
      throw new BidError("invalid_request", `${key} metadata mismatch.`, 409);
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

function buildBidLockKey(auctionId: string): string {
  return `auction:${auctionId}:bid:lock`;
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

function flattenRedisHashFields(fields: Record<string, string>): string[] {
  const entries: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    entries.push(key, value);
  }
  return entries;
}

async function acquireBidLock(
  redis: RedisClient,
  key: string,
  ttlMs: number,
  timeoutMs: number
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const lock = await acquireRedisLock(redis, key, ttlMs);
    if (lock) {
      return lock;
    }
    await delay(bidLockPollMs);
  }
  return null;
}
