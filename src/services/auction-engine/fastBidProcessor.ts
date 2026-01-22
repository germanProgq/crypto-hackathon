// Fast bid placement via Redis Lua script with background sync queue.
import { ObjectId } from "mongodb";
import type { LedgerBalance } from "../ledger/ledgerStore.js";
import type { RedisClient } from "../../shared/storage/redis.js";
import type { BidDocument } from "../../shared/storage/mongoSchemas.js";
import {
  primeAuctionSnapshotCache,
  primeRoundStateCache,
  readAuctionSnapshotFromRedis,
  roundStateTtlSeconds,
  snapshotTtlSeconds,
  type AuctionSnapshotCache,
  type RoundStateCache
} from "./auctionCache.js";
import {
  buildAuctionSnapshotKey,
  buildBidSyncQueueKey,
  buildFastBidActiveKey,
  buildFastBidIdempotencyKey,
  buildFastBidRecordKey,
  buildRankingKey,
  buildRoundStateKey,
  buildTopKey
} from "./auctionKeys.js";
import { buildBalanceCacheKey } from "../../shared/ledgerBalanceCache.js";

type FastBidResponsePayload = {
  bid: {
    bidId: string;
    auctionId: string;
    userId: string;
    amount: number;
    maxAmount: number;
    maxAmountProvided: number;
    createdAtMs: number;
    idempotencyKey: string;
    roundIndex: number;
    origin: string;
  };
  balance: {
    userId: string;
    currency: string;
    available: number;
    held: number;
    spent: number;
    current: number;
    updatedAtMs: number;
  };
  roundState: {
    auctionId: string;
    status: "scheduled" | "live" | "closed";
    roundIndex: number;
    scheduledStartAtMs: number;
    scheduledEndAtMs: number;
    effectiveEndAtMs: number;
    extensionCount: number;
    lastBidAtMs: number | null;
    allocationSize: number;
    antiSnipingTriggerWindowSeconds: number;
    antiSnipingExtensionSeconds: number;
    antiSnipingMaxExtensions: number;
  };
  snapshot: {
    auctionId: string;
    status: "draft" | "live" | "closed";
    title: string;
    currency: string;
    pricingMode: "first-price" | "cutoff";
    minBid: number;
    minIncrement: number;
    currentRoundIndex: number;
    roundStatus: "scheduled" | "live" | "closed";
    roundEffectiveEndAtMs: number | null;
    roundLastBidAtMs: number | null;
    lastBidAmount: number | null;
    updatedAtMs: number;
  };
  extended: boolean;
};

export type FastBidPlacement = {
  bid: BidDocument & { _id: ObjectId };
  balance: LedgerBalance;
  roundState: RoundStateCache;
  snapshot: AuctionSnapshotCache;
  extended: boolean;
  idempotent: boolean;
};

export type FastBidOutcome =
  | { status: "success"; value: FastBidPlacement }
  | { status: "fallback"; reason: string }
  | { status: "error"; error: FastBidError };

export type FastBidInput = {
  auctionId: ObjectId;
  userId: string;
  amount: number;
  maxAmount?: number;
  idempotencyKey: string;
  origin?: BidDocument["origin"];
  metadata?: Record<string, unknown>;
  audit?: BidDocument["audit"];
};

export class FastBidError extends Error {
  readonly code: string;
  readonly kind: "bid" | "ledger";
  readonly status: number;

  constructor(
    code: string,
    message: string,
    kind: "bid" | "ledger",
    status: number
  ) {
    super(message);
    this.code = code;
    this.kind = kind;
    this.status = status;
  }
}

export type FastBidProcessorOptions = {
  balanceTtlSeconds: number;
  activeTtlSeconds: number;
  bidRecordTtlSeconds: number;
  idempotencyTtlSeconds: number;
  topSetTtlSeconds: number;
};

const fastBidScript = `
local snapshotKey = KEYS[1]
local roundStateKey = KEYS[2]
local rankingKey = KEYS[3]
local topKey = KEYS[4]
local balanceKey = KEYS[5]
local activeKey = KEYS[6]
local bidKey = KEYS[7]
local idempotencyKey = KEYS[8]
local syncQueueKey = KEYS[9]

local auctionId = ARGV[1]
local userId = ARGV[2]
local bidId = ARGV[3]
local amount = tonumber(ARGV[4])
local maxAmount = tonumber(ARGV[5])
local maxAmountProvided = tonumber(ARGV[6]) or 0
local idempotencyToken = ARGV[7]
local origin = ARGV[8]
local nowMs = tonumber(ARGV[9])
local nowIso = ARGV[10]
local balanceTtl = tonumber(ARGV[11]) or 0
local activeTtl = tonumber(ARGV[12]) or 0
local bidRecordTtl = tonumber(ARGV[13]) or 0
local idempotencyTtl = tonumber(ARGV[14]) or 0
local snapshotTtl = tonumber(ARGV[15]) or 0
local roundStateTtl = tonumber(ARGV[16]) or 0
local topSetTtl = tonumber(ARGV[17]) or 0
local metadataJson = ARGV[18]
local auditJson = ARGV[19]

local function decodeJson(text)
  if not text or text == "" then
    return nil
  end
  local ok, parsed = pcall(cjson.decode, text)
  if not ok then
    return nil
  end
  return parsed
end

local function buildRankingMember(bidIdValue, createdAtMs)
  local maxTimestampMs = 9999999999999
  local padLength = 13
  local inverted = maxTimestampMs - createdAtMs
  if inverted < 0 then
    inverted = 0
  end
  local invertedStr = tostring(inverted)
  local pad = padLength - string.len(invertedStr)
  if pad > 0 then
    invertedStr = string.rep("0", pad) .. invertedStr
  end
  return invertedStr .. ":" .. bidIdValue
end

if not origin or origin == "" then
  origin = "manual"
end

if not amount or amount <= 0 then
  return { "error", "invalid_request" }
end

local existing = redis.call("GET", idempotencyKey)
if existing and existing ~= "" then
  local decoded = decodeJson(existing)
  if not decoded then
    return { "error", "idempotency_conflict" }
  end
  if decoded.auctionId ~= auctionId or decoded.userId ~= userId or tonumber(decoded.amount) ~= amount then
    return { "error", "idempotency_conflict" }
  end
  if (tonumber(decoded.maxAmountProvided) or 0) ~= maxAmountProvided then
    return { "error", "idempotency_conflict" }
  end
  if maxAmountProvided == 1 and tonumber(decoded.maxAmount) ~= maxAmount then
    return { "error", "idempotency_conflict" }
  end
  return { "idempotent", existing }
end

local snapshot = redis.call(
  "HMGET",
  snapshotKey,
  "status",
  "roundStatus",
  "currentRoundIndex",
  "roundEffectiveEndAtMs",
  "currency",
  "title",
  "pricingMode",
  "minBid",
  "minIncrement"
)

local snapshotStatus = snapshot[1]
local roundStatus = snapshot[2]
local currentRoundIndex = tonumber(snapshot[3])
local roundEffectiveEndAtMs = tonumber(snapshot[4])
local currency = snapshot[5]
local title = snapshot[6]
local pricingMode = snapshot[7] or "first-price"
local minBid = tonumber(snapshot[8]) or 0
local minIncrement = tonumber(snapshot[9]) or 0

if not snapshotStatus or snapshotStatus == "" or not roundStatus or roundStatus == "" then
  return { "fallback", "snapshot_missing" }
end

if snapshotStatus ~= "live" then
  return { "error", "auction_not_live" }
end

if roundStatus ~= "live" then
  return { "error", "round_not_live" }
end

if not currentRoundIndex or not roundEffectiveEndAtMs or not currency or not title then
  return { "fallback", "snapshot_missing" }
end

if nowMs > roundEffectiveEndAtMs then
  return { "error", "round_not_live" }
end

local round = redis.call(
  "HMGET",
  roundStateKey,
  "status",
  "roundIndex",
  "scheduledStartAtMs",
  "scheduledEndAtMs",
  "effectiveEndAtMs",
  "extensionCount",
  "lastBidAtMs",
  "allocationSize",
  "antiSnipingTriggerWindowSeconds",
  "antiSnipingExtensionSeconds",
  "antiSnipingMaxExtensions"
)

local roundStateStatus = round[1]
local roundIndex = tonumber(round[2])
local scheduledStartAtMs = tonumber(round[3])
local scheduledEndAtMs = tonumber(round[4])
local effectiveEndAtMs = tonumber(round[5])
local extensionCount = tonumber(round[6]) or 0
local lastBidAtMs = tonumber(round[7])
local allocationSize = tonumber(round[8]) or 0
local triggerWindowSeconds = tonumber(round[9]) or 0
local extensionSeconds = tonumber(round[10]) or 0
local maxExtensions = tonumber(round[11]) or 0

if not roundStateStatus or roundStateStatus == "" or not roundIndex or roundIndex ~= currentRoundIndex then
  return { "fallback", "round_state_missing" }
end

if roundStateStatus ~= "live" then
  return { "error", "round_not_live" }
end

if not scheduledStartAtMs or not scheduledEndAtMs or not effectiveEndAtMs then
  return { "fallback", "round_state_missing" }
end

if nowMs < scheduledStartAtMs or nowMs > effectiveEndAtMs then
  return { "error", "round_not_live" }
end

if maxAmountProvided ~= 1 then
  maxAmount = amount
end

if not maxAmount or maxAmount < amount then
  return { "error", "invalid_request" }
end

local active = redis.call("HMGET", activeKey, "bidId", "amount", "maxAmount", "createdAtMs")
local previousBidId = active[1]
local previousAmount = tonumber(active[2]) or 0
local previousMaxAmount = tonumber(active[3]) or previousAmount
local previousCreatedAtMs = tonumber(active[4]) or 0

if previousBidId and previousBidId ~= "" then
  if amount <= previousAmount then
    return { "error", "bid_too_low" }
  end
  if maxAmount < previousMaxAmount then
    return { "error", "bid_too_low" }
  end
end

local delta = maxAmount - previousMaxAmount
if delta < 0 then
  return { "error", "invalid_request" }
end

local top = redis.call("ZREVRANGE", rankingKey, 0, 0, "WITHSCORES")
local topAmount = 0
if top and #top >= 2 then
  topAmount = tonumber(top[2]) or 0
end

local minRequired = minBid
if topAmount > 0 then
  local candidate = topAmount + minIncrement
  if candidate > minRequired then
    minRequired = candidate
  end
end

if amount < minRequired then
  return { "error", "bid_too_low" }
end

local balance = redis.call("HMGET", balanceKey, "available", "held", "spent", "current")
local available = tonumber(balance[1])
local held = tonumber(balance[2]) or 0
local spent = tonumber(balance[3]) or 0
local current = tonumber(balance[4])

if available == nil then
  return { "fallback", "balance_missing" }
end

if available < delta then
  return { "error", "insufficient_funds" }
end

local newAvailable = available - delta
local newHeld = held + delta
local newCurrent = current
if not newCurrent then
  newCurrent = newAvailable + newHeld
else
  newCurrent = newCurrent + (newAvailable - available) + (newHeld - held)
end

redis.call("HSET", balanceKey, "userId", userId, "currency", currency)
redis.call("HSET", balanceKey, "available", newAvailable, "held", newHeld, "spent", spent, "current", newCurrent)
redis.call("HSET", balanceKey, "updatedAt", nowIso, "updatedAtMs", tostring(nowMs))
if balanceTtl > 0 then
  redis.call("EXPIRE", balanceKey, balanceTtl)
end

local lastBidAtValue = lastBidAtMs
if not lastBidAtValue or lastBidAtValue < nowMs then
  lastBidAtValue = nowMs
end

local extended = 0
if maxExtensions > extensionCount and triggerWindowSeconds > 0 and extensionSeconds > 0 then
  local windowStartMs = effectiveEndAtMs - (triggerWindowSeconds * 1000)
  if nowMs >= windowStartMs and nowMs <= effectiveEndAtMs then
    extensionCount = extensionCount + 1
    effectiveEndAtMs = effectiveEndAtMs + (extensionSeconds * 1000)
    extended = 1
  end
end

redis.call(
  "HSET",
  roundStateKey,
  "lastBidAt",
  tostring(lastBidAtValue),
  "lastBidAtMs",
  tostring(lastBidAtValue),
  "effectiveEndAt",
  tostring(effectiveEndAtMs),
  "effectiveEndAtMs",
  tostring(effectiveEndAtMs),
  "extensionCount",
  tostring(extensionCount),
  "updatedAt",
  nowIso,
  "updatedAtMs",
  tostring(nowMs)
)

if roundStateTtl > 0 then
  redis.call("EXPIRE", roundStateKey, roundStateTtl)
end

redis.call(
  "HSET",
  snapshotKey,
  "roundLastBidAt",
  tostring(lastBidAtValue),
  "roundLastBidAtMs",
  tostring(lastBidAtValue),
  "roundEffectiveEndAt",
  tostring(effectiveEndAtMs),
  "roundEffectiveEndAtMs",
  tostring(effectiveEndAtMs),
  "lastBidAmount",
  tostring(amount),
  "updatedAt",
  nowIso,
  "updatedAtMs",
  tostring(nowMs)
)

if snapshotTtl > 0 then
  redis.call("EXPIRE", snapshotKey, snapshotTtl)
end

redis.call(
  "HSET",
  activeKey,
  "bidId",
  bidId,
  "amount",
  tostring(amount),
  "maxAmount",
  tostring(maxAmount),
  "maxAmountProvided",
  tostring(maxAmountProvided),
  "createdAtMs",
  tostring(nowMs),
  "roundIndex",
  tostring(roundIndex),
  "origin",
  origin
)

if activeTtl > 0 then
  redis.call("EXPIRE", activeKey, activeTtl)
end

redis.call(
  "HSET",
  bidKey,
  "bidId",
  bidId,
  "auctionId",
  auctionId,
  "userId",
  userId,
  "amount",
  tostring(amount),
  "maxAmount",
  tostring(maxAmount),
  "maxAmountProvided",
  tostring(maxAmountProvided),
  "createdAtMs",
  tostring(nowMs),
  "roundIndex",
  tostring(roundIndex),
  "idempotencyKey",
  idempotencyToken,
  "origin",
  origin
)

if bidRecordTtl > 0 then
  redis.call("EXPIRE", bidKey, bidRecordTtl)
end

local rankingMember = buildRankingMember(bidId, nowMs)
redis.call("ZADD", rankingKey, amount, rankingMember)
if previousBidId and previousBidId ~= "" then
  local previousMember = buildRankingMember(previousBidId, previousCreatedAtMs)
  if previousMember ~= rankingMember then
    redis.call("ZREM", rankingKey, previousMember)
  end
end

redis.call("DEL", topKey)
if allocationSize > 0 then
  local topMembers = redis.call("ZREVRANGE", rankingKey, 0, allocationSize - 1)
  local bidIds = {}
  for i = 1, #topMembers do
    local member = topMembers[i]
    local sep = string.find(member, ":")
    if sep then
      local topBidId = string.sub(member, sep + 1)
      if topBidId and topBidId ~= "" then
        table.insert(bidIds, topBidId)
      end
    end
  end
  if #bidIds > 0 then
    redis.call("SADD", topKey, unpack(bidIds))
    if topSetTtl > 0 then
      redis.call("EXPIRE", topKey, topSetTtl)
    end
  end
end

local metadata = decodeJson(metadataJson)
local audit = decodeJson(auditJson)

local event = {
  bidId = bidId,
  auctionId = auctionId,
  userId = userId,
  amount = amount,
  maxAmount = maxAmount,
  maxAmountProvided = maxAmountProvided,
  createdAtMs = nowMs,
  idempotencyKey = idempotencyToken,
  roundIndex = roundIndex,
  origin = origin,
  currency = currency,
  delta = delta,
  previousBidId = previousBidId,
  previousMaxAmount = previousMaxAmount,
  metadata = metadata,
  audit = audit
}

redis.call("RPUSH", syncQueueKey, cjson.encode(event))

local response = {
  bid = {
    bidId = bidId,
    auctionId = auctionId,
    userId = userId,
    amount = amount,
    maxAmount = maxAmount,
    maxAmountProvided = maxAmountProvided,
    createdAtMs = nowMs,
    idempotencyKey = idempotencyToken,
    roundIndex = roundIndex,
    origin = origin
  },
  balance = {
    userId = userId,
    currency = currency,
    available = newAvailable,
    held = newHeld,
    spent = spent,
    current = newCurrent,
    updatedAtMs = nowMs
  },
  roundState = {
    auctionId = auctionId,
    status = roundStateStatus,
    roundIndex = roundIndex,
    scheduledStartAtMs = scheduledStartAtMs,
    scheduledEndAtMs = scheduledEndAtMs,
    effectiveEndAtMs = effectiveEndAtMs,
    extensionCount = extensionCount,
    lastBidAtMs = lastBidAtValue,
    allocationSize = allocationSize,
    antiSnipingTriggerWindowSeconds = triggerWindowSeconds,
    antiSnipingExtensionSeconds = extensionSeconds,
    antiSnipingMaxExtensions = maxExtensions
  },
  snapshot = {
    auctionId = auctionId,
    status = snapshotStatus,
    title = title,
    currency = currency,
    pricingMode = pricingMode,
    minBid = minBid,
    minIncrement = minIncrement,
    currentRoundIndex = roundIndex,
    roundStatus = roundStatus,
    roundEffectiveEndAtMs = effectiveEndAtMs,
    roundLastBidAtMs = lastBidAtValue,
    lastBidAmount = amount,
    updatedAtMs = nowMs
  },
  extended = extended == 1
}

local responseJson = cjson.encode(response)
if idempotencyTtl > 0 then
  redis.call("SET", idempotencyKey, responseJson, "EX", idempotencyTtl)
else
  redis.call("SET", idempotencyKey, responseJson)
end

return { "ok", responseJson }
`;

type FastBidScriptRedis = RedisClient & {
  fastBid?: (
    snapshotKey: string,
    roundStateKey: string,
    rankingKey: string,
    topKey: string,
    balanceKey: string,
    activeKey: string,
    bidKey: string,
    idempotencyKey: string,
    syncQueueKey: string,
    auctionId: string,
    userId: string,
    bidId: string,
    amount: string,
    maxAmount: string,
    maxAmountProvided: string,
    idempotencyToken: string,
    origin: string,
    nowMs: string,
    nowIso: string,
    balanceTtl: string,
    activeTtl: string,
    bidRecordTtl: string,
    idempotencyTtl: string,
    snapshotTtl: string,
    roundStateTtl: string,
    topSetTtl: string,
    metadataJson: string,
    auditJson: string
  ) => Promise<string[]>;
};

function ensureFastBidScript(redis: RedisClient): FastBidScriptRedis {
  const client = redis as FastBidScriptRedis;
  if (!client.fastBid) {
    client.defineCommand("fastBid", { numberOfKeys: 9, lua: fastBidScript });
  }
  return client;
}

export class FastBidProcessor {
  constructor(private readonly redis: RedisClient, private readonly options: FastBidProcessorOptions) {}

  async placeBid(input: FastBidInput): Promise<FastBidOutcome> {
    const now = new Date();
    const auctionIdText = input.auctionId.toHexString();
    const snapshot = await readAuctionSnapshotFromRedis(this.redis, auctionIdText);
    if (!snapshot || snapshot.currentRoundIndex === null) {
      const idempotent = await readIdempotentFastBid(this.redis, input.idempotencyKey);
      if (idempotent) {
        return { status: "success", value: idempotent };
      }
      return { status: "fallback", reason: "snapshot_missing" };
    }

    const bidId = new ObjectId();
    const origin = input.origin ?? (input.maxAmount !== undefined ? "proxy" : "manual");
    const snapshotKey = buildAuctionSnapshotKey(auctionIdText);
    const roundStateKey = buildRoundStateKey(auctionIdText, snapshot.currentRoundIndex);
    const rankingKey = buildRankingKey(auctionIdText);
    const topKey = buildTopKey(auctionIdText);
    const balanceKey = buildBalanceCacheKey(input.userId, snapshot.currency);
    const activeKey = buildFastBidActiveKey(auctionIdText, input.userId);
    const bidKey = buildFastBidRecordKey(bidId.toHexString());
    const idempotencyKey = buildFastBidIdempotencyKey(input.idempotencyKey);
    const syncQueueKey = buildBidSyncQueueKey();
    const maxAmountProvided = input.maxAmount !== undefined ? 1 : 0;
    const maxAmount = input.maxAmount ?? input.amount;
    const metadataJson = input.metadata ? JSON.stringify(input.metadata) : "";
    const auditJson = input.audit ? JSON.stringify(input.audit) : "";

    const client = ensureFastBidScript(this.redis);
    let result: string[] | null = null;
    try {
      result = await client.fastBid(
        snapshotKey,
        roundStateKey,
        rankingKey,
        topKey,
        balanceKey,
        activeKey,
        bidKey,
        idempotencyKey,
        syncQueueKey,
        auctionIdText,
        input.userId,
        bidId.toHexString(),
        input.amount.toString(),
        maxAmount.toString(),
        maxAmountProvided.toString(),
        input.idempotencyKey,
        origin ?? "manual",
        now.getTime().toString(),
        now.toISOString(),
        this.options.balanceTtlSeconds.toString(),
        this.options.activeTtlSeconds.toString(),
        this.options.bidRecordTtlSeconds.toString(),
        this.options.idempotencyTtlSeconds.toString(),
        snapshotTtlSeconds.toString(),
        roundStateTtlSeconds.toString(),
        this.options.topSetTtlSeconds.toString(),
        metadataJson,
        auditJson
      );
    } catch (error) {
      return { status: "fallback", reason: error instanceof Error ? error.message : "redis_error" };
    }

    if (!result || result.length === 0) {
      return { status: "fallback", reason: "empty_result" };
    }

    const [tag, payload] = result;
    if (tag === "fallback") {
      return { status: "fallback", reason: payload ?? "fallback" };
    }

    if (tag === "error") {
      const errorCode = payload ?? "invalid_request";
      const error = mapFastBidError(errorCode);
      return { status: "error", error };
    }

    if (tag !== "ok" && tag !== "idempotent") {
      return { status: "fallback", reason: "unknown_result" };
    }

    const parsed = parseFastBidPayload(payload);
    if (!parsed) {
      return { status: "fallback", reason: "invalid_payload" };
    }

    const placement = buildFastBidPlacement(parsed);
    placement.idempotent = tag === "idempotent";

    primeAuctionSnapshotCache(placement.snapshot);
    primeRoundStateCache(auctionIdText, placement.roundState);

    return { status: "success", value: placement };
  }
}

function parseFastBidPayload(payload: string | undefined): FastBidResponsePayload | null {
  if (!payload) {
    return null;
  }
  try {
    return JSON.parse(payload) as FastBidResponsePayload;
  } catch {
    return null;
  }
}

async function readIdempotentFastBid(
  redis: RedisClient,
  idempotencyKey: string
): Promise<FastBidPlacement | null> {
  try {
    const stored = await redis.get(buildFastBidIdempotencyKey(idempotencyKey));
    const parsed = parseFastBidPayload(stored ?? undefined);
    if (!parsed) {
      return null;
    }
    const placement = buildFastBidPlacement(parsed);
    placement.idempotent = true;
    primeAuctionSnapshotCache(placement.snapshot);
    primeRoundStateCache(placement.snapshot.auctionId, placement.roundState);
    return placement;
  } catch {
    return null;
  }
}

function buildFastBidPlacement(payload: FastBidResponsePayload): FastBidPlacement {
  const bidId = new ObjectId(payload.bid.bidId);
  const auctionId = new ObjectId(payload.bid.auctionId);
  const createdAt = new Date(payload.bid.createdAtMs);
  const bid: BidDocument & { _id: ObjectId } = {
    _id: bidId,
    auctionId,
    userId: payload.bid.userId,
    amount: payload.bid.amount,
    createdAt,
    idempotencyKey: payload.bid.idempotencyKey,
    active: true,
    roundIndex: payload.bid.roundIndex,
    origin: payload.bid.origin
  };
  if (payload.bid.maxAmountProvided === 1) {
    bid.maxAmount = payload.bid.maxAmount;
  }

  const roundState: RoundStateCache = {
    status: payload.roundState.status,
    roundIndex: payload.roundState.roundIndex,
    scheduledStartAt: new Date(payload.roundState.scheduledStartAtMs),
    scheduledEndAt: new Date(payload.roundState.scheduledEndAtMs),
    effectiveEndAt: new Date(payload.roundState.effectiveEndAtMs),
    extensionCount: payload.roundState.extensionCount,
    antiSnipingTriggerWindowSeconds: payload.roundState.antiSnipingTriggerWindowSeconds,
    antiSnipingExtensionSeconds: payload.roundState.antiSnipingExtensionSeconds,
    antiSnipingMaxExtensions: payload.roundState.antiSnipingMaxExtensions,
    lastBidAt: payload.roundState.lastBidAtMs ? new Date(payload.roundState.lastBidAtMs) : null,
    startedAt: null,
    closedAt: null,
    allocationSize: payload.roundState.allocationSize
  };

  const snapshot: AuctionSnapshotCache = {
    auctionId: payload.snapshot.auctionId,
    status: payload.snapshot.status,
    title: payload.snapshot.title,
    currency: payload.snapshot.currency,
    pricingMode: payload.snapshot.pricingMode ?? "first-price",
    minBid: Number.isFinite(payload.snapshot.minBid) ? payload.snapshot.minBid : 0,
    minIncrement: Number.isFinite(payload.snapshot.minIncrement) ? payload.snapshot.minIncrement : 0,
    currentRoundIndex: payload.snapshot.currentRoundIndex,
    roundStatus: payload.snapshot.roundStatus,
    roundEffectiveEndAt: payload.snapshot.roundEffectiveEndAtMs
      ? new Date(payload.snapshot.roundEffectiveEndAtMs)
      : null,
    roundLastBidAt: payload.snapshot.roundLastBidAtMs
      ? new Date(payload.snapshot.roundLastBidAtMs)
      : null,
    updatedAt: new Date(payload.snapshot.updatedAtMs),
    lastBidAmount: payload.snapshot.lastBidAmount ?? null
  };

  const balance: LedgerBalance = {
    userId: payload.balance.userId,
    currency: payload.balance.currency,
    available: payload.balance.available,
    held: payload.balance.held,
    spent: payload.balance.spent ?? 0,
    current: payload.balance.current ?? payload.balance.available + payload.balance.held
  };

  return {
    bid,
    balance,
    roundState,
    snapshot,
    extended: payload.extended,
    idempotent: false
  };
}

function mapFastBidError(code: string): FastBidError {
  switch (code) {
    case "insufficient_funds":
      return new FastBidError(
        "insufficient_funds",
        "Insufficient available balance.",
        "ledger",
        409
      );
    case "auction_not_live":
      return new FastBidError("auction_not_live", "Auction is not live.", "bid", 409);
    case "round_not_live":
      return new FastBidError("round_not_live", "Round is not live.", "bid", 409);
    case "bid_too_low":
      return new FastBidError("bid_too_low", "Bid must exceed the minimum.", "bid", 409);
    case "idempotency_conflict":
      return new FastBidError(
        "idempotency_conflict",
        "Idempotency key does not match bid payload.",
        "bid",
        409
      );
    default:
      return new FastBidError("invalid_request", "Invalid bid request.", "bid", 409);
  }
}
