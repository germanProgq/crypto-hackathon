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
import { createAuctionRepository } from "./auctionStore.js";
import { buildRankingMember, parseRankingMember } from "./bidRanking.js";

const bidLockTtlMs = 8000;
const rateLimitWindowSeconds = 1;
const snapshotTtlSeconds = 5;
const roundStateTtlSeconds = 5;
const topSetTtlSeconds = 10;
const bidIdempotencyTtlSeconds = 600;
const idempotencyWaitMs = 750;
const idempotencyPollMs = 50;
const bidLockWaitMs = 1500;
const bidLockPollMs = 25;

const rateLimitScript = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return current
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

      await updateRedisCaches(deps.redis, result);
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

async function updateRedisCaches(redis: RedisClient, result: BidTransactionResult): Promise<void> {
  const rankingKey = buildRankingKey(result.auction._id.toHexString());
  const roundStateKey = buildRoundStateKey(
    result.auction._id.toHexString(),
    result.roundState.roundIndex
  );
  const auctionSnapshotKey = buildAuctionSnapshotKey(result.auction._id.toHexString());
  const topKey = buildTopKey(result.auction._id.toHexString());
  const idempotencyKey = buildBidIdempotencyKey(result.bid.idempotencyKey);

  const rankingMember = buildRankingMember(result.bid._id, result.bid.createdAt);
  const previousMember = result.previousBid
    ? buildRankingMember(result.previousBid._id, result.previousBid.createdAt)
    : null;

  const now = new Date().toISOString();
  const lastBidAt = result.roundState.lastBidAt
    ? result.roundState.lastBidAt.toISOString()
    : result.bid.createdAt.toISOString();
  const bidIsLatest =
    !result.roundState.lastBidAt ||
    result.roundState.lastBidAt.getTime() === result.bid.createdAt.getTime();

  const pipeline = redis.multi();
  if (result.updateRanking) {
    pipeline.zadd(rankingKey, result.bid.amount, rankingMember);
    if (previousMember) {
      pipeline.zrem(rankingKey, previousMember);
    }
  }
  pipeline.hset(roundStateKey, {
    status: result.roundState.status,
    roundIndex: result.roundState.roundIndex.toString(),
    scheduledStartAt: result.roundState.scheduledStartAt.toISOString(),
    scheduledEndAt: result.roundState.scheduledEndAt.toISOString(),
    effectiveEndAt: result.roundState.effectiveEndAt.toISOString(),
    extensionCount: result.roundState.extensionCount.toString(),
    lastBidAt,
    updatedAt: now,
    allocationSize: result.roundConfig.allocationSize.toString()
  });
  pipeline.expire(roundStateKey, roundStateTtlSeconds);
  pipeline.hset(auctionSnapshotKey, {
    auctionId: result.auction._id.toHexString(),
    status: result.auction.status,
    title: result.auction.title,
    currency: result.auction.currency,
    currentRoundIndex: result.roundState.roundIndex.toString(),
    roundStatus: result.roundState.status,
    roundEffectiveEndAt: result.roundState.effectiveEndAt.toISOString(),
    roundLastBidAt: lastBidAt,
    updatedAt: now
  });
  if (bidIsLatest) {
    pipeline.hset(auctionSnapshotKey, { lastBidAmount: result.bid.amount.toString() });
  }
  pipeline.expire(auctionSnapshotKey, snapshotTtlSeconds);
  pipeline.set(idempotencyKey, result.bid._id.toHexString(), "EX", bidIdempotencyTtlSeconds);
  await pipeline.exec();

  const topCount = Math.max(1, result.roundConfig.allocationSize);
  const topMembers = await redis.zrevrange(rankingKey, 0, topCount - 1);
  const topBidIds = topMembers
    .map((member) => parseRankingMember(member).bidId)
    .filter((bidId) => bidId.length > 0);
  const topPipeline = redis.multi();
  topPipeline.del(topKey);
  if (topBidIds.length > 0) {
    topPipeline.sadd(topKey, ...topBidIds);
  }
  topPipeline.expire(topKey, topSetTtlSeconds);
  await topPipeline.exec();
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
  const value = await redis.eval(rateLimitScript, 1, key, rateLimitWindowSeconds.toString());
  const current = Number(value);
  if (!Number.isFinite(current)) {
    throw new BidError("rate_limited", "Rate limit unavailable.", 429);
  }
  if (current > limit) {
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
