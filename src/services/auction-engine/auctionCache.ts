// Redis cache helpers for auction snapshots and round state.
import type { RedisClient } from "../../shared/storage/redis.js";
import type { AuctionRoundStatus, AuctionStatus } from "../../shared/storage/mongoSchemas.js";
import {
  buildActiveAuctionListKey,
  buildAuctionSnapshotKey,
  buildRoundStateKey
} from "./auctionKeys.js";

export const snapshotTtlSeconds = 5;
export const roundStateTtlSeconds = 5;
const activeAuctionListTtlSeconds = 10;
const activeAuctionListKey = buildActiveAuctionListKey();
const inProcessCacheTtlMs = 2000;
const inProcessCacheMaxEntries = 512;

type CacheEntry<V> = {
  value: V;
  expiresAt: number;
};

class TtlLruCache<V> {
  private readonly entries = new Map<string, CacheEntry<V>>();

  constructor(private readonly maxEntries: number, private readonly ttlMs: number) {}

  get(key: string): V | null {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    const expiresAt = Date.now() + this.ttlMs;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt });
    if (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
  }
}

export type AuctionSnapshotCache = {
  auctionId: string;
  status: AuctionStatus;
  title: string;
  currency: string;
  pricingMode: "first-price" | "cutoff";
  minBid: number;
  minIncrement: number;
  currentRoundIndex: number | null;
  roundStatus: AuctionRoundStatus | null;
  roundEffectiveEndAt: Date | null;
  roundLastBidAt: Date | null;
  updatedAt: Date;
  lastBidAmount: number | null;
};

export type RoundStateCache = {
  status: AuctionRoundStatus;
  roundIndex: number;
  scheduledStartAt: Date;
  scheduledEndAt: Date;
  effectiveEndAt: Date;
  extensionCount: number;
  antiSnipingTriggerWindowSeconds: number;
  antiSnipingExtensionSeconds: number;
  antiSnipingMaxExtensions: number;
  lastBidAt: Date | null;
  startedAt: Date | null;
  closedAt: Date | null;
  allocationSize: number;
};

const snapshotCache = new TtlLruCache<AuctionSnapshotCache>(
  inProcessCacheMaxEntries,
  inProcessCacheTtlMs
);
const roundStateCache = new TtlLruCache<RoundStateCache>(
  inProcessCacheMaxEntries,
  inProcessCacheTtlMs
);
const snapshotReadsInFlight = new Map<string, Promise<AuctionSnapshotCache | null>>();
const roundStateReadsInFlight = new Map<string, Promise<RoundStateCache | null>>();

export function primeAuctionSnapshotCache(snapshot: AuctionSnapshotCache): void {
  snapshotCache.set(buildAuctionSnapshotKey(snapshot.auctionId), snapshot);
}

export function primeRoundStateCache(auctionId: string, state: RoundStateCache): void {
  roundStateCache.set(buildRoundStateKey(auctionId, state.roundIndex), state);
}

export async function readActiveAuctionListFromRedis(
  redis: RedisClient
): Promise<unknown[] | null> {
  try {
    const data = await redis.get(activeAuctionListKey);
    if (!data) {
      return null;
    }

    try {
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
    }

    await redis.del(activeAuctionListKey);
    return null;
  } catch {
    return null;
  }
}

export async function writeActiveAuctionListToRedis(
  redis: RedisClient,
  auctions: unknown[]
): Promise<void> {
  await redis.set(
    activeAuctionListKey,
    JSON.stringify(auctions),
    "EX",
    activeAuctionListTtlSeconds
  );
}

export async function invalidateActiveAuctionListCache(redis: RedisClient): Promise<void> {
  await redis.del(activeAuctionListKey);
}

export async function readAuctionSnapshotFromRedis(
  redis: RedisClient,
  auctionId: string
): Promise<AuctionSnapshotCache | null> {
  const key = buildAuctionSnapshotKey(auctionId);
  const cached = snapshotCache.get(key);
  if (cached) {
    return cached;
  }
  const pending = snapshotReadsInFlight.get(key);
  if (pending) {
    return pending;
  }

  const fetchPromise = (async () => {
    try {
      const data = await redis.hgetall(key);
      if (Object.keys(data).length === 0) {
        return null;
      }

      const status = parseAuctionStatus(data.status);
      const roundStatus = parseRoundStatus(data.roundStatus);
      const currentRoundIndex = parseRedisInt(data.currentRoundIndex);
      const roundEffectiveEndAt = parseRedisDate(data.roundEffectiveEndAt);
      const updatedAt = parseRedisDate(data.updatedAt);
      const title = parseRedisText(data.title);
      const currency = parseRedisText(data.currency);
      const pricingMode = parsePricingMode(data.pricingMode) ?? "first-price";
      const minBid = normalizeNonNegative(parseRedisNumber(data.minBid));
      const minIncrement = normalizeNonNegative(parseRedisNumber(data.minIncrement));
      if (
        !status ||
        !roundStatus ||
        currentRoundIndex === null ||
        !roundEffectiveEndAt ||
        !updatedAt ||
        !title ||
        !currency
      ) {
        return null;
      }
      if (data.auctionId && data.auctionId !== auctionId) {
        return null;
      }

      const roundLastBidAt = parseRedisDate(data.roundLastBidAt);
      const lastBidAmount = parseRedisNumber(data.lastBidAmount);

      return {
        auctionId,
        status,
        title,
        currency,
        pricingMode,
        minBid,
        minIncrement,
        currentRoundIndex,
        roundStatus,
        roundEffectiveEndAt,
        roundLastBidAt,
        updatedAt,
        lastBidAmount
      };
    } catch {
      return null;
    }
  })();

  snapshotReadsInFlight.set(key, fetchPromise);
  try {
    const result = await fetchPromise;
    if (result) {
      snapshotCache.set(key, result);
    }
    return result;
  } finally {
    snapshotReadsInFlight.delete(key);
  }
}

export async function readRoundStateFromRedis(
  redis: RedisClient,
  auctionId: string,
  roundIndex: number
): Promise<RoundStateCache | null> {
  const key = buildRoundStateKey(auctionId, roundIndex);
  const cached = roundStateCache.get(key);
  if (cached) {
    return cached;
  }
  const pending = roundStateReadsInFlight.get(key);
  if (pending) {
    return pending;
  }

  const fetchPromise = (async () => {
    try {
      const data = await redis.hgetall(key);
      if (Object.keys(data).length === 0) {
        return null;
      }

      const status = parseRoundStatus(data.status);
      const storedIndex = parseRedisInt(data.roundIndex);
      const scheduledStartAt = parseRedisDate(data.scheduledStartAt);
      const scheduledEndAt = parseRedisDate(data.scheduledEndAt);
      const effectiveEndAt = parseRedisDate(data.effectiveEndAt);
      const extensionCount = parseRedisInt(data.extensionCount);
      const allocationSize = parseRedisInt(data.allocationSize);
      const startedAt = parseRedisDate(data.startedAt);
      const closedAt = parseRedisDate(data.closedAt);
      const antiSnipingTriggerWindowSeconds = normalizeNonNegative(
        parseRedisInt(data.antiSnipingTriggerWindowSeconds)
      );
      const antiSnipingExtensionSeconds = normalizeNonNegative(
        parseRedisInt(data.antiSnipingExtensionSeconds)
      );
      const antiSnipingMaxExtensions = normalizeNonNegative(
        parseRedisInt(data.antiSnipingMaxExtensions)
      );

      if (
        !status ||
        storedIndex === null ||
        storedIndex !== roundIndex ||
        !scheduledStartAt ||
        !scheduledEndAt ||
        !effectiveEndAt ||
        extensionCount === null ||
        allocationSize === null
      ) {
        return null;
      }

      return {
        status,
        roundIndex: storedIndex,
        scheduledStartAt,
        scheduledEndAt,
        effectiveEndAt,
        extensionCount,
        antiSnipingTriggerWindowSeconds,
        antiSnipingExtensionSeconds,
        antiSnipingMaxExtensions,
        lastBidAt: parseRedisDate(data.lastBidAt),
        startedAt,
        closedAt,
        allocationSize
      };
    } catch {
      return null;
    }
  })();

  roundStateReadsInFlight.set(key, fetchPromise);
  try {
    const result = await fetchPromise;
    if (result) {
      roundStateCache.set(key, result);
    }
    return result;
  } finally {
    roundStateReadsInFlight.delete(key);
  }
}

export async function writeAuctionSnapshotToRedis(
  redis: RedisClient,
  snapshot: AuctionSnapshotCache,
  ttlSeconds = snapshotTtlSeconds
): Promise<void> {
  const key = buildAuctionSnapshotKey(snapshot.auctionId);
  const fields = buildAuctionSnapshotFields(snapshot);

  const pipeline = redis.multi();
  pipeline.hset(key, fields);
  pipeline.expire(key, ttlSeconds);
  await pipeline.exec();
  primeAuctionSnapshotCache(snapshot);
}

export async function writeRoundStateToRedis(
  redis: RedisClient,
  auctionId: string,
  state: RoundStateCache,
  ttlSeconds = roundStateTtlSeconds,
  updatedAt = new Date()
): Promise<void> {
  const key = buildRoundStateKey(auctionId, state.roundIndex);
  const fields = buildRoundStateFields(state, updatedAt);

  const pipeline = redis.multi();
  pipeline.hset(key, fields);
  pipeline.expire(key, ttlSeconds);
  await pipeline.exec();
  primeRoundStateCache(auctionId, state);
}

export function buildAuctionSnapshotFields(
  snapshot: AuctionSnapshotCache
): Record<string, string> {
  const fields: Record<string, string> = {
    auctionId: snapshot.auctionId,
    status: snapshot.status,
    title: snapshot.title,
    currency: snapshot.currency,
    pricingMode: snapshot.pricingMode,
    minBid: snapshot.minBid.toString(),
    minIncrement: snapshot.minIncrement.toString(),
    updatedAt: snapshot.updatedAt.toISOString()
  };

  if (snapshot.currentRoundIndex !== null) {
    fields.currentRoundIndex = snapshot.currentRoundIndex.toString();
  }
  if (snapshot.roundStatus) {
    fields.roundStatus = snapshot.roundStatus;
  }
  if (snapshot.roundEffectiveEndAt) {
    fields.roundEffectiveEndAt = snapshot.roundEffectiveEndAt.toISOString();
    fields.roundEffectiveEndAtMs = snapshot.roundEffectiveEndAt.getTime().toString();
  }
  if (snapshot.roundLastBidAt) {
    fields.roundLastBidAt = snapshot.roundLastBidAt.toISOString();
    fields.roundLastBidAtMs = snapshot.roundLastBidAt.getTime().toString();
  }
  if (snapshot.lastBidAmount !== null) {
    fields.lastBidAmount = snapshot.lastBidAmount.toString();
  }

  return fields;
}

export function buildRoundStateFields(
  state: RoundStateCache,
  updatedAt = new Date()
): Record<string, string> {
  const fields: Record<string, string> = {
    status: state.status,
    roundIndex: state.roundIndex.toString(),
    scheduledStartAt: state.scheduledStartAt.toISOString(),
    scheduledEndAt: state.scheduledEndAt.toISOString(),
    effectiveEndAt: state.effectiveEndAt.toISOString(),
    extensionCount: state.extensionCount.toString(),
    antiSnipingTriggerWindowSeconds: state.antiSnipingTriggerWindowSeconds.toString(),
    antiSnipingExtensionSeconds: state.antiSnipingExtensionSeconds.toString(),
    antiSnipingMaxExtensions: state.antiSnipingMaxExtensions.toString(),
    allocationSize: state.allocationSize.toString(),
    updatedAt: updatedAt.toISOString(),
    updatedAtMs: updatedAt.getTime().toString(),
    scheduledStartAtMs: state.scheduledStartAt.getTime().toString(),
    scheduledEndAtMs: state.scheduledEndAt.getTime().toString(),
    effectiveEndAtMs: state.effectiveEndAt.getTime().toString()
  };

  if (state.lastBidAt) {
    fields.lastBidAt = state.lastBidAt.toISOString();
    fields.lastBidAtMs = state.lastBidAt.getTime().toString();
  }
  if (state.startedAt) {
    fields.startedAt = state.startedAt.toISOString();
    fields.startedAtMs = state.startedAt.getTime().toString();
  }
  if (state.closedAt) {
    fields.closedAt = state.closedAt.toISOString();
    fields.closedAtMs = state.closedAt.getTime().toString();
  }

  return fields;
}

function parseRedisDate(value?: string): Date | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      const numericDate = new Date(numeric);
      if (!Number.isNaN(numericDate.getTime())) {
        return numericDate;
      }
    }
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function parseRedisInt(value?: string): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return null;
  }
  return parsed;
}

function parseRedisNumber(value?: string): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRedisText(value?: string): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseAuctionStatus(value?: string): AuctionStatus | null {
  return isAuctionStatus(value) ? value : null;
}

function parsePricingMode(value?: string): "first-price" | "cutoff" | null {
  if (!value) {
    return null;
  }
  if (value === "first-price" || value === "cutoff") {
    return value;
  }
  return null;
}

function parseRoundStatus(value?: string): AuctionRoundStatus | null {
  return isRoundStatus(value) ? value : null;
}

function isAuctionStatus(value?: string): value is AuctionStatus {
  return value === "draft" || value === "live" || value === "closed";
}

function isRoundStatus(value?: string): value is AuctionRoundStatus {
  return value === "scheduled" || value === "live" || value === "closed";
}

function normalizeNonNegative(value: number | null): number {
  if (value === null || !Number.isFinite(value)) {
    return 0;
  }
  return value < 0 ? 0 : value;
}
