// Balance cache helpers for fast bid validation and UI reads.
import type { RedisClient } from "./storage/redis.js";
import type { LedgerEntryType } from "./storage/mongoSchemas.js";

export type BalanceCacheSnapshot = {
  userId: string;
  currency: string;
  available: number;
  held: number;
  spent: number;
  current: number;
  updatedAt: Date;
};

type BalanceDelta = {
  availableDelta: number;
  heldDelta: number;
  spentDelta: number;
};

const balanceCacheTtlSeconds = 3600;
const balanceIdempotencyTtlSeconds = 86400;

const balanceDeltaScript = `
local balanceKey = KEYS[1]
local idempotencyKey = KEYS[2]

local ttlSeconds = tonumber(ARGV[1])
local idempotencyTtl = tonumber(ARGV[2])
local availableDelta = tonumber(ARGV[3]) or 0
local heldDelta = tonumber(ARGV[4]) or 0
local spentDelta = tonumber(ARGV[5]) or 0
local currentDelta = tonumber(ARGV[6]) or 0
local userId = ARGV[7]
local currency = ARGV[8]
local updatedAt = ARGV[9]

if idempotencyKey and idempotencyKey ~= "" then
  local inserted = redis.call("SETNX", idempotencyKey, updatedAt)
  if inserted == 0 then
    return 0
  end
  if idempotencyTtl and idempotencyTtl > 0 then
    redis.call("EXPIRE", idempotencyKey, idempotencyTtl)
  end
end

if userId and userId ~= "" then
  redis.call("HSET", balanceKey, "userId", userId)
end
if currency and currency ~= "" then
  redis.call("HSET", balanceKey, "currency", currency)
end

redis.call("HINCRBYFLOAT", balanceKey, "available", availableDelta)
redis.call("HINCRBYFLOAT", balanceKey, "held", heldDelta)
redis.call("HINCRBYFLOAT", balanceKey, "spent", spentDelta)
redis.call("HINCRBYFLOAT", balanceKey, "current", currentDelta)
redis.call("HSET", balanceKey, "updatedAt", updatedAt)

if ttlSeconds and ttlSeconds > 0 then
  redis.call("EXPIRE", balanceKey, ttlSeconds)
end

return 1
`;

type BalanceScriptRedis = RedisClient & {
  applyBalanceDelta?: (
    keyCount: number,
    balanceKey: string,
    idempotencyKey: string,
    ttlSeconds: string,
    idempotencyTtl: string,
    availableDelta: string,
    heldDelta: string,
    spentDelta: string,
    currentDelta: string,
    userId: string,
    currency: string,
    updatedAt: string
  ) => Promise<number>;
};

function ensureBalanceScript(redis: RedisClient): BalanceScriptRedis {
  const client = redis as BalanceScriptRedis;
  if (!client.applyBalanceDelta) {
    client.defineCommand("applyBalanceDelta", {
      numberOfKeys: 2,
      lua: balanceDeltaScript
    });
  }
  return client;
}

export function buildBalanceCacheKey(userId: string, currency: string): string {
  return `balance:${userId}:${currency}`;
}

export function buildBalanceIdempotencyKey(idempotencyKey: string): string {
  return `balance:idemp:${idempotencyKey}`;
}

export async function readBalanceCache(
  redis: RedisClient,
  userId: string,
  currency: string
): Promise<BalanceCacheSnapshot | null> {
  const key = buildBalanceCacheKey(userId, currency);
  let data: Record<string, string> = {};
  try {
    data = await redis.hgetall(key);
  } catch {
    return null;
  }
  if (!data || Object.keys(data).length === 0) {
    return null;
  }

  const available = parseNumber(data.available);
  const held = parseNumber(data.held);
  const spent = parseNumber(data.spent);
  const current = parseNumber(data.current);
  const updatedAt = parseDate(data.updatedAt);
  const resolvedUserId = data.userId ?? userId;
  const resolvedCurrency = data.currency ?? currency;

  if (
    available === null ||
    held === null ||
    spent === null ||
    current === null ||
    !updatedAt
  ) {
    return null;
  }

  return {
    userId: resolvedUserId,
    currency: resolvedCurrency,
    available,
    held,
    spent,
    current,
    updatedAt
  };
}

export async function writeBalanceCache(
  redis: RedisClient,
  balance: BalanceCacheSnapshot,
  ttlSeconds = balanceCacheTtlSeconds
): Promise<void> {
  const key = buildBalanceCacheKey(balance.userId, balance.currency);
  const pipeline = redis.multi();
  pipeline.hset(key, {
    userId: balance.userId,
    currency: balance.currency,
    available: balance.available.toString(),
    held: balance.held.toString(),
    spent: balance.spent.toString(),
    current: balance.current.toString(),
    updatedAt: balance.updatedAt.toISOString()
  });
  if (ttlSeconds > 0) {
    pipeline.expire(key, ttlSeconds);
  }
  await pipeline.exec();
}

export async function applyBalanceDelta(
  redis: RedisClient,
  input: {
    userId: string;
    currency: string;
    entryType: LedgerEntryType;
    amount: number;
    idempotencyKey: string;
    updatedAt?: Date;
  },
  ttlSeconds = balanceCacheTtlSeconds,
  idempotencyTtlSeconds = balanceIdempotencyTtlSeconds
): Promise<boolean> {
  const deltas = resolveBalanceDelta(input.entryType, input.amount);
  if (!deltas) {
    return false;
  }

  const updatedAt = input.updatedAt ?? new Date();
  const balanceKey = buildBalanceCacheKey(input.userId, input.currency);
  const idempotencyKey = buildBalanceIdempotencyKey(input.idempotencyKey);
  const client = ensureBalanceScript(redis);
  const currentDelta = deltas.availableDelta + deltas.heldDelta;

  const applied = await client.applyBalanceDelta(
    2,
    balanceKey,
    idempotencyKey,
    ttlSeconds.toString(),
    idempotencyTtlSeconds.toString(),
    deltas.availableDelta.toString(),
    deltas.heldDelta.toString(),
    deltas.spentDelta.toString(),
    currentDelta.toString(),
    input.userId,
    input.currency,
    updatedAt.toISOString()
  );

  return applied === 1;
}

function resolveBalanceDelta(entryType: LedgerEntryType, amount: number): BalanceDelta | null {
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  switch (entryType) {
    case "deposit_confirmed":
      return { availableDelta: amount, heldDelta: 0, spentDelta: 0 };
    case "hold_created":
      return { availableDelta: -amount, heldDelta: amount, spentDelta: 0 };
    case "hold_released":
      return { availableDelta: amount, heldDelta: -amount, spentDelta: 0 };
    case "hold_captured":
      return { availableDelta: 0, heldDelta: -amount, spentDelta: amount };
    case "withdrawal_requested":
      return { availableDelta: -amount, heldDelta: amount, spentDelta: 0 };
    case "withdrawal_confirmed":
      return { availableDelta: 0, heldDelta: -amount, spentDelta: amount };
    case "withdrawal_failed":
      return { availableDelta: amount, heldDelta: -amount, spentDelta: 0 };
    case "withdrawal_broadcasted":
      return null;
    default:
      return null;
  }
}

function parseNumber(value?: string): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDate(value?: string): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
