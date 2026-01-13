// Redis cache helpers for auction snapshots and round state.
import type { RedisClient } from "../../shared/storage/redis.js";
import type { AuctionRoundStatus, AuctionStatus } from "../../shared/storage/mongoSchemas.js";
import { buildAuctionSnapshotKey, buildRoundStateKey } from "./auctionKeys.js";

export const snapshotTtlSeconds = 5;
export const roundStateTtlSeconds = 5;

export type AuctionSnapshotCache = {
  auctionId: string;
  status: AuctionStatus;
  title: string;
  currency: string;
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
  lastBidAt: Date | null;
  startedAt: Date | null;
  closedAt: Date | null;
  allocationSize: number;
};

export async function readAuctionSnapshotFromRedis(
  redis: RedisClient,
  auctionId: string
): Promise<AuctionSnapshotCache | null> {
  const key = buildAuctionSnapshotKey(auctionId);
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
    currentRoundIndex,
    roundStatus,
    roundEffectiveEndAt,
    roundLastBidAt,
    updatedAt,
    lastBidAmount
  };
}

export async function readRoundStateFromRedis(
  redis: RedisClient,
  auctionId: string,
  roundIndex: number
): Promise<RoundStateCache | null> {
  const key = buildRoundStateKey(auctionId, roundIndex);
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
    lastBidAt: parseRedisDate(data.lastBidAt),
    startedAt: null,
    closedAt: null,
    allocationSize
  };
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
}

export function buildAuctionSnapshotFields(
  snapshot: AuctionSnapshotCache
): Record<string, string> {
  const fields: Record<string, string> = {
    auctionId: snapshot.auctionId,
    status: snapshot.status,
    title: snapshot.title,
    currency: snapshot.currency,
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
  }
  if (snapshot.roundLastBidAt) {
    fields.roundLastBidAt = snapshot.roundLastBidAt.toISOString();
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
    allocationSize: state.allocationSize.toString(),
    updatedAt: updatedAt.toISOString()
  };

  if (state.lastBidAt) {
    fields.lastBidAt = state.lastBidAt.toISOString();
  }

  return fields;
}

function parseRedisDate(value?: string): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
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

function parseRoundStatus(value?: string): AuctionRoundStatus | null {
  return isRoundStatus(value) ? value : null;
}

function isAuctionStatus(value?: string): value is AuctionStatus {
  return value === "draft" || value === "live" || value === "closed";
}

function isRoundStatus(value?: string): value is AuctionRoundStatus {
  return value === "scheduled" || value === "live" || value === "closed";
}
