// Shared helper to update auction caches and snapshot fields.
import type { Logger } from "pino";
import type { WithId } from "mongodb";
import type { RedisClient } from "../../shared/storage/redis.js";
import {
  buildAuctionSnapshotKey,
  buildRoundStateKey
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
import type { createAuctionRepository } from "./auctionStore.js";
import type {
  AuctionDocument,
  AuctionRoundConfig,
  AuctionRoundStateDocument
} from "../../shared/storage/mongoSchemas.js";

export async function updateAuctionCaches(
  logger: Logger,
  redis: RedisClient,
  repository: ReturnType<typeof createAuctionRepository>,
  auction: WithId<AuctionDocument>,
  roundStates: AuctionRoundStateDocument[],
  updatedStates: AuctionRoundStateDocument[],
  now: Date
): Promise<AuctionSnapshotCache | null> {
  if (updatedStates.length === 0) {
    return null;
  }

  const roundConfigMap = new Map<number, AuctionRoundConfig>(
    auction.rounds.map((round) => [round.index, round])
  );
  const pipeline = redis.multi();
  const auctionIdText = auction._id.toHexString();
  const roundStatesToPrime: RoundStateCache[] = [];
  let snapshotToPrime: AuctionSnapshotCache | null = null;
  let hasOps = false;

  for (const state of updatedStates) {
    const roundConfig = roundConfigMap.get(state.roundIndex);
    if (!roundConfig) {
      continue;
    }
    const roundCache: RoundStateCache = {
      status: state.status,
      roundIndex: state.roundIndex,
      scheduledStartAt: state.scheduledStartAt,
      scheduledEndAt: state.scheduledEndAt,
      effectiveEndAt: state.effectiveEndAt,
      extensionCount: state.extensionCount,
      antiSnipingTriggerWindowSeconds: roundConfig.antiSniping.triggerWindowSeconds,
      antiSnipingExtensionSeconds: roundConfig.antiSniping.extensionSeconds,
      antiSnipingMaxExtensions: roundConfig.antiSniping.maxExtensions,
      lastBidAt: state.lastBidAt ?? null,
      startedAt: state.startedAt ?? null,
      closedAt: state.closedAt ?? null,
      allocationSize: roundConfig.allocationSize
    };
    roundStatesToPrime.push(roundCache);
    const roundStateKey = buildRoundStateKey(auctionIdText, state.roundIndex);
    pipeline.hset(roundStateKey, buildRoundStateFields(roundCache, now));
    pipeline.expire(roundStateKey, roundStateTtlSeconds);
    hasOps = true;
  }

  const ordered = [...roundStates].sort((left, right) => left.roundIndex - right.roundIndex);
  const current =
    ordered.find((state) => state.status === "live") ??
    ordered.find((state) => state.status === "scheduled") ??
    ordered[ordered.length - 1] ??
    null;

  const snapshotRoundIndex = current?.roundIndex ?? null;
  const snapshotRoundStatus = current?.status ?? null;
  const snapshotRoundEffectiveEndAt = current?.effectiveEndAt ?? null;
  const snapshotRoundLastBidAt = current?.lastBidAt ?? null;

  if (current) {
    const snapshot: AuctionSnapshotCache = {
      auctionId: auctionIdText,
      status: auction.status,
      title: auction.title,
      currency: auction.currency,
      pricingMode: auction.pricingMode ?? "first-price",
      minBid: Number.isFinite(auction.minBid) ? auction.minBid : 0,
      minIncrement: Number.isFinite(auction.minIncrement) ? auction.minIncrement : 0,
      currentRoundIndex: current.roundIndex,
      roundStatus: current.status,
      roundEffectiveEndAt: current.effectiveEndAt,
      roundLastBidAt: current.lastBidAt ?? null,
      updatedAt: now,
      lastBidAmount: null
    };
    snapshotToPrime = snapshot;
    const snapshotKey = buildAuctionSnapshotKey(auctionIdText);
    pipeline.hset(snapshotKey, buildAuctionSnapshotFields(snapshot));
    pipeline.expire(snapshotKey, snapshotTtlSeconds);
    hasOps = true;
  }

  await repository.updateAuctionSnapshot(
    auction._id,
    {
      currentRoundIndex: snapshotRoundIndex,
      roundStatus: snapshotRoundStatus,
      roundEffectiveEndAt: snapshotRoundEffectiveEndAt,
      roundLastBidAt: snapshotRoundLastBidAt,
      lastBidAmount: null
    },
    now
  );

  if (hasOps) {
    try {
      await pipeline.exec();
    } catch (error) {
      logger.warn({ err: error }, "Failed to update auction caches in Redis");
    }
    for (const state of roundStatesToPrime) {
      primeRoundStateCache(auctionIdText, state);
    }
    if (snapshotToPrime) {
      primeAuctionSnapshotCache(snapshotToPrime);
    }
  }
  return snapshotToPrime;
}
