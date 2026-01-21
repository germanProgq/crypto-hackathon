// Bid placement workflow with locking, ledger holds, and Redis caching.
import { randomUUID } from "node:crypto";
import { ObjectId, type WithId } from "mongodb";
import type { ServiceDependencies } from "../../shared/service.js";
import { runMongoTransaction } from "../../shared/storage/mongoTransaction.js";
import { acquireRedisLock, releaseRedisLock, type RedisLock } from "../../shared/storage/redisLock.js";
import type { RedisClient } from "../../shared/storage/redis.js";
import { computeExpiresAt, resolveRetentionMs } from "../../shared/storage/retention.js";
import {
  mongoCollections,
  type AuctionDocument,
  type AuctionRoundConfig,
  type AuctionRoundStateDocument,
  type AuctionWatchlistDocument,
  type BidDocument,
  type NotificationQueueDocument
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
import { ensureAuctionRoundProgress } from "./auctionProgress.js";
import { createAuctionRepository } from "./auctionStore.js";
import { buildRankingMember } from "./bidRanking.js";
import { createRoundFinalizationService } from "./roundFinalizationService.js";
import { applyAntiSnipingExtension } from "./roundStateMachine.js";
import { publishRealtimeEvent, toRealtimeSnapshot } from "../../shared/realtime/events.js";

const bidLockTtlMs = 8000;
const topSetTtlSeconds = 10;
const bidIdempotencyTtlSeconds = 600;
const idempotencyWaitMs = 750;
const idempotencyPollMs = 50;
const bidLockWaitMs = 1500;
const bidLockPollMs = 25;
const localRateLimitMaxEntries = 10000;
const localBidLockMaxEntries = 5000;
const persistLastBidAt = readEnvBoolean("BID_PERSIST_LAST_BID_AT", true);
const persistSnapshot = readEnvBoolean("BID_PERSIST_SNAPSHOT", true);

const rateLimitScript = `
local time = redis.call("TIME")
local nowMs = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)

local function consume(key, capacity, refillRate)
  if not capacity or not refillRate or capacity <= 0 or refillRate <= 0 then
    return 0
  end

  local bucket = redis.call("HMGET", key, "tokens", "ts")
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

  redis.call("HSET", key, "tokens", tokens, "ts", nowMs)

  local ttlSeconds = math.ceil((capacity / refillRate) * 2)
  if ttlSeconds < 1 then
    ttlSeconds = 1
  end
  redis.call("EXPIRE", key, ttlSeconds)

  return allowed and 1 or 0
end

local userAllowed = consume(KEYS[1], tonumber(ARGV[1]), tonumber(ARGV[2]))
if userAllowed ~= 1 then
  return 0
end

local auctionAllowed = consume(KEYS[2], tonumber(ARGV[3]), tonumber(ARGV[4]))
if auctionAllowed ~= 1 then
  return 0
end

local ipAllowed = consume(KEYS[3], tonumber(ARGV[5]), tonumber(ARGV[6]))
if ipAllowed ~= 1 then
  return 0
end

return 1
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
  maxAmount?: number;
  idempotencyKey: string;
  audit?: BidDocument["audit"];
  metadata?: Record<string, unknown>;
  ip: string;
  origin?: "manual" | "proxy" | "auto";
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

type TopBidSnapshot = Pick<
  WithId<BidDocument>,
  "_id" | "userId" | "amount" | "maxAmount" | "createdAt"
>;

type ProxyCandidate = TopBidSnapshot & { maxValue: number };

type LocalRateLimitState = {
  tokens: number;
  lastMs: number;
  expiresAt: number;
};

type LocalLockState = {
  key: string;
  token: string;
  expiresAt: number;
};

type BidLock = { type: "redis"; lock: RedisLock } | { type: "local"; lock: LocalLockState };

export function createBidService(deps: ServiceDependencies) {
  const auctionRepository = createAuctionRepository(deps.mongo);
  const ledger = createLedgerRepository(deps.mongo, {
    retentionDays: deps.config.dataRetention.ledgerDays
  });
  const bids = deps.mongo.db.collection<BidDocument>(mongoCollections.bids);
  const watchlist = deps.mongo.db.collection<AuctionWatchlistDocument>(
    mongoCollections.auctionWatchlist
  );
  const notificationQueue = deps.mongo.db.collection<NotificationQueueDocument>(
    mongoCollections.notificationQueue
  );
  const roundStates = deps.mongo.db.collection<AuctionRoundStateDocument>(
    mongoCollections.auctionRoundStates
  );
  const finalizationService = createRoundFinalizationService(deps);
  const bidRetentionMs = resolveRetentionMs(deps.config.dataRetention.bidsDays);
  const notificationRetentionMs = resolveRetentionMs(deps.config.dataRetention.notificationsDays);
  const localRateLimits = new Map<string, LocalRateLimitState>();
  const localBidLocks = new Map<string, LocalLockState>();
  let rateLimitFallbackLogged = false;
  let lockFallbackLogged = false;
  const finalizationThrottle = new Map<string, number>();
  const finalizationThrottleMs = 5000;

  const warnRateLimitFallback = (error: unknown) => {
    if (rateLimitFallbackLogged) {
      return;
    }
    rateLimitFallbackLogged = true;
    deps.logger.warn({ err: error }, "Redis rate limits unavailable; using local fallback");
  };

  const warnLockFallback = (error: unknown) => {
    if (lockFallbackLogged) {
      return;
    }
    lockFallbackLogged = true;
    deps.logger.warn({ err: error }, "Redis lock unavailable; using local fallback");
  };

  const kickFinalizationIfNeeded = async (auctionId: ObjectId): Promise<void> => {
    const auctionIdText = auctionId.toHexString();
    const nowMs = Date.now();
    const nextAllowed = finalizationThrottle.get(auctionIdText) ?? 0;
    if (nowMs < nextAllowed) {
      return;
    }
    finalizationThrottle.set(auctionIdText, nowMs + finalizationThrottleMs);

    try {
      const pending = await roundStates
        .find({ auctionId, status: "closed", settlementCompletedAt: { $exists: false } })
        .sort({ closedAt: 1, effectiveEndAt: 1 })
        .limit(1)
        .toArray();
      const target = pending[0];
      if (!target) {
        return;
      }
      await finalizationService.finalizeRound(auctionId, target.roundIndex);
    } catch (error) {
      deps.logger.warn(
        { err: error, auctionId: auctionIdText },
        "Failed to kick round finalization"
      );
    }
  };

  async function placeBid(input: BidPlacementInput): Promise<BidPlacementResult> {
    if (input.origin !== "auto") {
      await enforceRateLimits(
        deps.redis,
        deps.config.rateLimits,
        input,
        localRateLimits,
        warnRateLimitFallback
      );
    }

    try {
      await ensureAuctionRoundProgress(deps, auctionRepository, input.auctionId);
    } catch (error) {
      deps.logger.warn(
        { err: error, auctionId: input.auctionId.toHexString() },
        "Failed to catch up auction rounds before bid"
      );
    }
    void kickFinalizationIfNeeded(input.auctionId);

    let previousTop: TopBidSnapshot | null = null;
    try {
      previousTop = await loadTopBid(input.auctionId);
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to load previous top bid");
    }

    const existing = await resolveIdempotentBid(input);
    if (existing) {
      return toPlacementResult(existing);
    }

    const lockKey = buildBidLockKey(input.auctionId.toHexString(), input.userId);
    const lock = await acquireBidLock(
      deps.redis,
      localBidLocks,
      lockKey,
      bidLockTtlMs,
      bidLockWaitMs,
      warnLockFallback
    );
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

        const origin = input.origin ?? (input.maxAmount !== undefined ? "proxy" : "manual");
        const resolvedMaxAmount = resolveMaxAmount(input);

        if (previousBid && input.amount <= previousBid.amount) {
          throw new BidError("bid_too_low", "Bid must exceed the current amount.", 409);
        }

        if (resolvedMaxAmount < input.amount) {
          throw new BidError("invalid_request", "Max amount must be >= bid amount.", 409);
        }

        const previousEscrow = previousBid?.maxAmount ?? previousBid?.amount ?? 0;
        if (resolvedMaxAmount < previousEscrow) {
          throw new BidError("bid_too_low", "Max amount cannot decrease.", 409);
        }

        const delta = resolvedMaxAmount - previousEscrow;

        const bidId = new ObjectId();
        if (previousBid) {
          const inactiveUpdate: Record<string, unknown> = { active: false, inactiveAt: now };
          const expiresAt = computeExpiresAt(now, bidRetentionMs);
          if (expiresAt) {
            inactiveUpdate.expiresAt = expiresAt;
          }
          await bids.updateOne(
            { _id: previousBid._id, active: true },
            { $set: inactiveUpdate },
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
        if (input.maxAmount !== undefined) {
          bidDoc.maxAmount = resolvedMaxAmount;
        }
        if (origin) {
          bidDoc.origin = origin;
        }

        await bids.insertOne(bidDoc, { session });
        const watchNow = now;
        await watchlist.updateOne(
          { userId: input.userId, auctionId: input.auctionId },
          {
            $setOnInsert: { userId: input.userId, auctionId: input.auctionId, createdAt: watchNow },
            $set: { updatedAt: watchNow, notifyOutbid: true }
          },
          { upsert: true, session }
        );

        let balance: LedgerBalance;
        if (delta > 0) {
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
              input.amount,
              resolvedMaxAmount,
              origin
            ),
            audit: input.audit
          };

          const holdResult = await ledger.createHoldInSession(holdInput, session);
          balance = holdResult.balance;
        } else {
          balance = await ledger.getBalanceInSession(input.userId, auction.currency, session);
        }
        const antiSnipingPreview = applyAntiSnipingExtension(roundState, roundConfig, now);
        let resolvedState = { ...roundState, ...antiSnipingPreview.state };
        let extended = antiSnipingPreview.extended;
        if (persistLastBidAt || antiSnipingPreview.extended) {
          const persisted = await auctionRepository.applyBidAntiSniping(
            auction,
            roundState.roundIndex,
            now,
            session
          );
          resolvedState = persisted.state;
          extended = persisted.extended;
        }

        const lastBidAt = resolvedState.lastBidAt ?? now;
        const bidIsLatest =
          !resolvedState.lastBidAt || resolvedState.lastBidAt.getTime() === now.getTime();
        if (persistSnapshot || extended) {
          await auctionRepository.updateAuctionSnapshot(
            auction._id,
            {
              currentRoundIndex: resolvedState.roundIndex,
              roundStatus: resolvedState.status,
              roundEffectiveEndAt: resolvedState.effectiveEndAt,
              roundLastBidAt: lastBidAt,
              lastBidAmount: bidIsLatest ? bidDoc.amount : null
            },
            now,
            session
          );
        }

        return {
          bid: bidDoc,
          balance,
          roundState: resolvedState,
          extended,
          idempotent: false,
          auction,
          roundConfig,
          previousBid,
          updateRanking: true
        };
      });

      const { snapshot } = await updateRedisCaches(deps.redis, result, deps.logger);
      try {
        await Promise.all([
          publishRealtimeEvent(deps.redis, {
            type: "auction.snapshot.updated",
            auctionId: snapshot.auctionId,
            snapshot: toRealtimeSnapshot({ ...snapshot, serverTime: new Date() })
          }),
          publishRealtimeEvent(deps.redis, {
            type: "auction.bids.updated",
            auctionId: snapshot.auctionId
          }),
          publishRealtimeEvent(deps.redis, {
            type: "bids.active.updated",
            userIds: [result.bid.userId]
          }),
          publishRealtimeEvent(deps.redis, {
            type: "balance.updated",
            userIds: [result.bid.userId],
            currency: result.auction.currency
          })
        ]);
      } catch (error) {
        deps.logger.warn({ err: error }, "Failed to publish realtime bid updates");
      }
      let autoRaised = false;
      if (deps.config.bids.proxyAutoRaise && input.origin !== "auto") {
        autoRaised = await maybeApplyAutoRaise(result, input);
      }
      if (!autoRaised) {
        try {
          const currentTop = await loadTopBid(result.auction._id);
          await maybeQueueOutbidNotification(previousTop, currentTop, result);
        } catch (error) {
          deps.logger.warn({ err: error }, "Failed to process outbid notifications");
        }
      }
      return toPlacementResult(result);
    } finally {
      await releaseBidLock(deps.redis, localBidLocks, lock);
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

  async function maybeApplyAutoRaise(
    result: BidTransactionResult,
    input: BidPlacementInput
  ): Promise<boolean> {
    const candidates = await loadTopProxyCandidates(result.auction._id);
    const target = resolveAutoRaiseTarget(candidates, deps.config.bids.minIncrement, input.userId);
    if (!target) {
      return false;
    }
    try {
      await placeBid({
        auctionId: result.auction._id,
        userId: target.userId,
        amount: target.amount,
        maxAmount: target.maxAmount,
        idempotencyKey: buildAutoBidIdempotencyKey(
          result.auction._id.toHexString(),
          target.userId,
          result.bid._id.toHexString()
        ),
        audit: { source: "auto", actorId: "system" },
        metadata: { autoFromBidId: result.bid._id.toHexString() },
        ip: `auto:${target.userId}`,
        origin: "auto"
      });
      return true;
    } catch (error) {
      deps.logger.warn({ err: error }, "Auto-raise bid failed");
      return false;
    }
  }

  async function maybeQueueOutbidNotification(
    previousTop: TopBidSnapshot | null,
    currentTop: TopBidSnapshot | null,
    result: BidTransactionResult
  ): Promise<void> {
    if (!previousTop || !currentTop) {
      return;
    }
    if (previousTop.userId === currentTop.userId) {
      return;
    }
    const watching = await watchlist.findOne({
      userId: previousTop.userId,
      auctionId: result.auction._id,
      notifyOutbid: { $ne: false }
    });
    if (!watching) {
      return;
    }

    const now = new Date();
    const auctionId = result.auction._id.toHexString();
    const roundIndex = result.roundState.roundIndex;
    const rebidAmount = normalizeBidAmount(
      currentTop.amount + Math.max(0, deps.config.bids.minIncrement)
    );
    const payload: Record<string, unknown> = {
      auctionId,
      roundIndex,
      auctionTitle: result.auction.title,
      currency: result.auction.currency,
      previousAmount: previousTop.amount,
      currentAmount: currentTop.amount,
      rebidAmount,
      currentLeader: currentTop.userId,
      bidId: currentTop._id.toHexString()
    };
    const replayUrl = buildReplayUrl(deps.config.web.publicUrl, auctionId, roundIndex);
    if (replayUrl) {
      payload.replayUrl = replayUrl;
    }

    const idempotencyKey = buildOutbidIdempotencyKey(
      auctionId,
      roundIndex,
      previousTop.userId,
      currentTop._id.toHexString()
    );
    const expiresAt = computeExpiresAt(now, notificationRetentionMs);
    const update: Record<string, unknown> = {
      type: "outbid_alert",
      userId: previousTop.userId,
      auctionId: result.auction._id,
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

    await notificationQueue.updateOne(
      { idempotencyKey },
      { $setOnInsert: update },
      { upsert: true }
    );
  }

  async function loadTopBid(auctionId: ObjectId): Promise<TopBidSnapshot | null> {
    return bids
      .find({ auctionId, active: true })
      .sort({ amount: -1, createdAt: 1, _id: 1 })
      .project<TopBidSnapshot>({
        _id: 1,
        userId: 1,
        amount: 1,
        maxAmount: 1,
        createdAt: 1
      })
      .limit(1)
      .next();
  }

  async function loadTopProxyCandidates(
    auctionId: ObjectId
  ): Promise<ProxyCandidate[]> {
    const results = await bids
      .aggregate<ProxyCandidate>([
        { $match: { auctionId, active: true } },
        {
          $addFields: {
            maxValue: { $ifNull: ["$maxAmount", "$amount"] }
          }
        },
        { $sort: { maxValue: -1, createdAt: 1, _id: 1 } },
        { $limit: 2 },
        {
          $project: {
            _id: 1,
            userId: 1,
            amount: 1,
            maxAmount: 1,
            createdAt: 1,
            maxValue: 1
          }
        }
      ])
      .toArray();
    return results;
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
  result: BidTransactionResult,
  logger: ServiceDependencies["logger"]
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

  try {
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
  } catch (error) {
    logger.warn({ err: error }, "Failed to update bid caches in Redis");
  }
  primeRoundStateCache(auctionIdText, roundStateCache);
  primeAuctionSnapshotCache(snapshot);
  return { snapshot };
}

async function enforceRateLimits(
  redis: RedisClient,
  limits: ServiceDependencies["config"]["rateLimits"],
  input: BidPlacementInput,
  localLimits: Map<string, LocalRateLimitState>,
  onRedisFallback: (error: unknown) => void
): Promise<void> {
  let allowed: number | null = null;
  try {
    const result = await redis.eval(
      rateLimitScript,
      3,
      buildUserRateLimitKey(input.userId),
      buildAuctionUserRateLimitKey(input.auctionId.toHexString(), input.userId),
      buildIpRateLimitKey(input.ip),
      limits.userPerSecond.toString(),
      limits.userPerSecond.toString(),
      limits.auctionUserPerSecond.toString(),
      limits.auctionUserPerSecond.toString(),
      limits.ipPerSecond.toString(),
      limits.ipPerSecond.toString()
    );
    allowed = Number(result);
  } catch (error) {
    onRedisFallback(error);
  }

  if (allowed === 1) {
    return;
  }

  if (allowed === null || !Number.isFinite(allowed)) {
    const fallbackAllowed = consumeLocalRateLimits(localLimits, limits, input);
    if (!fallbackAllowed) {
      throw new BidError("rate_limited", "Rate limit exceeded.", 429);
    }
    return;
  }

  throw new BidError("rate_limited", "Rate limit exceeded.", 429);
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
    bid.auctionId.equals(input.auctionId) &&
    (bid.maxAmount ?? null) === (input.maxAmount ?? null)
  );
}

function resolveMaxAmount(input: BidPlacementInput): number {
  if (input.maxAmount === undefined) {
    return input.amount;
  }
  return input.maxAmount;
}

function resolveAutoRaiseTarget(
  candidates: ProxyCandidate[],
  minIncrement: number,
  triggerUserId: string
): { userId: string; amount: number; maxAmount: number } | null {
  if (candidates.length < 2) {
    return null;
  }
  const [top, second] = candidates;
  if (!top || !second) {
    return null;
  }
  if (top.userId === triggerUserId) {
    return null;
  }
  const topMax = top.maxValue;
  if (!Number.isFinite(topMax) || topMax <= top.amount) {
    return null;
  }
  const secondMax = second.maxValue;
  if (!Number.isFinite(secondMax)) {
    return null;
  }
  const target = Math.min(topMax, secondMax + Math.max(0, minIncrement));
  if (target <= top.amount + 1e-9) {
    return null;
  }
  return {
    userId: top.userId,
    amount: normalizeBidAmount(target),
    maxAmount: topMax
  };
}

function normalizeBidAmount(value: number): number {
  const scaled = Math.round(value * 1e8);
  return scaled / 1e8;
}

function buildOutbidIdempotencyKey(
  auctionId: string,
  roundIndex: number,
  userId: string,
  bidId: string
): string {
  return `outbid:${auctionId}:${roundIndex}:${userId}:${bidId}`;
}

function buildAutoBidIdempotencyKey(
  auctionId: string,
  userId: string,
  triggerBidId: string
): string {
  return `auto:${auctionId}:${userId}:${triggerBidId}`;
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

function buildBidLockKey(auctionId: string, userId: string): string {
  return `auction:${auctionId}:user:${userId}:bid:lock`;
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
  localLocks: Map<string, LocalLockState>,
  key: string,
  ttlMs: number,
  timeoutMs: number,
  onRedisFallback: (error: unknown) => void
): Promise<BidLock | null> {
  const start = Date.now();
  let redisUnavailable = false;
  while (Date.now() - start < timeoutMs) {
    if (!redisUnavailable) {
      try {
        const lock = await acquireRedisLock(redis, key, ttlMs);
        if (lock) {
          return { type: "redis", lock };
        }
      } catch (error) {
        redisUnavailable = true;
        onRedisFallback(error);
      }
    }
    if (redisUnavailable) {
      const localLock = acquireLocalLock(localLocks, key, ttlMs);
      if (localLock) {
        return { type: "local", lock: localLock };
      }
    }
    await delay(bidLockPollMs);
  }
  return null;
}

async function releaseBidLock(
  redis: RedisClient,
  localLocks: Map<string, LocalLockState>,
  lock: BidLock | null
): Promise<void> {
  if (!lock) {
    return;
  }
  if (lock.type === "local") {
    releaseLocalLock(localLocks, lock.lock);
    return;
  }
  try {
    await releaseRedisLock(redis, lock.lock);
  } catch {
    // Ignore Redis release errors for best-effort cleanup.
  }
}

function acquireLocalLock(
  localLocks: Map<string, LocalLockState>,
  key: string,
  ttlMs: number
): LocalLockState | null {
  const now = Date.now();
  const existing = localLocks.get(key);
  if (existing && existing.expiresAt > now) {
    return null;
  }
  const lock: LocalLockState = {
    key,
    token: randomUUID(),
    expiresAt: now + ttlMs
  };
  localLocks.delete(key);
  localLocks.set(key, lock);
  if (localLocks.size > localBidLockMaxEntries) {
    const oldestKey = localLocks.keys().next().value;
    if (oldestKey) {
      localLocks.delete(oldestKey);
    }
  }
  return lock;
}

function releaseLocalLock(
  localLocks: Map<string, LocalLockState>,
  lock: LocalLockState
): void {
  const existing = localLocks.get(lock.key);
  if (!existing) {
    return;
  }
  if (existing.token === lock.token) {
    localLocks.delete(lock.key);
  }
}

function consumeLocalRateLimits(
  localLimits: Map<string, LocalRateLimitState>,
  limits: ServiceDependencies["config"]["rateLimits"],
  input: BidPlacementInput
): boolean {
  const nowMs = Date.now();
  const userKey = buildUserRateLimitKey(input.userId);
  const auctionUserKey = buildAuctionUserRateLimitKey(
    input.auctionId.toHexString(),
    input.userId
  );
  const ipKey = buildIpRateLimitKey(input.ip);

  if (
    !consumeLocalRateLimit(localLimits, userKey, limits.userPerSecond, nowMs) ||
    !consumeLocalRateLimit(
      localLimits,
      auctionUserKey,
      limits.auctionUserPerSecond,
      nowMs
    ) ||
    !consumeLocalRateLimit(localLimits, ipKey, limits.ipPerSecond, nowMs)
  ) {
    return false;
  }
  return true;
}

function consumeLocalRateLimit(
  localLimits: Map<string, LocalRateLimitState>,
  key: string,
  perSecond: number,
  nowMs: number
): boolean {
  if (!Number.isFinite(perSecond) || perSecond <= 0) {
    return true;
  }
  const capacity = perSecond;
  const refillRate = perSecond;
  const existing = getLocalRateLimitEntry(localLimits, key, nowMs);
  let tokens = existing?.tokens ?? capacity;
  let lastMs = existing?.lastMs ?? nowMs;

  if (tokens > capacity) {
    tokens = capacity;
  }

  if (tokens < capacity) {
    const deltaMs = nowMs - lastMs;
    if (deltaMs > 0) {
      const refill = (deltaMs / 1000) * refillRate;
      tokens = Math.min(capacity, tokens + refill);
    }
  }

  const allowed = tokens >= 1;
  if (allowed) {
    tokens -= 1;
  }

  const ttlSeconds = Math.max(1, Math.ceil((capacity / refillRate) * 2));
  const expiresAt = nowMs + ttlSeconds * 1000;
  setLocalRateLimitEntry(localLimits, key, {
    tokens,
    lastMs: nowMs,
    expiresAt
  });

  return allowed;
}

function getLocalRateLimitEntry(
  localLimits: Map<string, LocalRateLimitState>,
  key: string,
  nowMs: number
): LocalRateLimitState | null {
  const entry = localLimits.get(key);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= nowMs) {
    localLimits.delete(key);
    return null;
  }
  localLimits.delete(key);
  localLimits.set(key, entry);
  return entry;
}

function setLocalRateLimitEntry(
  localLimits: Map<string, LocalRateLimitState>,
  key: string,
  entry: LocalRateLimitState
): void {
  localLimits.delete(key);
  localLimits.set(key, entry);
  if (localLimits.size > localRateLimitMaxEntries) {
    const oldestKey = localLimits.keys().next().value;
    if (oldestKey) {
      localLimits.delete(oldestKey);
    }
  }
}

function readEnvBoolean(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}
