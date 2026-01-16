// Best-effort catch-up for auction round transitions outside worker loops.
import { ObjectId } from "mongodb";
import type { ServiceDependencies } from "../../shared/service.js";
import { acquireRedisLock, releaseRedisLock } from "../../shared/storage/redisLock.js";
import { publishRealtimeEvent, toRealtimeSnapshot } from "../../shared/realtime/events.js";
import type { AuctionRoundStateDocument } from "../../shared/storage/mongoSchemas.js";
import { invalidateActiveAuctionListCache } from "./auctionCache.js";
import { updateAuctionCaches } from "./auctionCacheUpdater.js";
import { buildRoundLockKey } from "./auctionKeys.js";
import { createAuctionRepository } from "./auctionStore.js";
import { deriveAuctionStatus, evaluateRoundTransition } from "./roundStateMachine.js";

const roundLockTtlMs = 10000;
const dueBatchSize = 50;

export async function ensureAuctionRoundProgress(
  deps: ServiceDependencies,
  repository: ReturnType<typeof createAuctionRepository>,
  auctionId: ObjectId,
  now = new Date()
): Promise<{
  updatedStates: AuctionRoundStateDocument[];
} | null> {
  const dueStates = await repository.listDueRoundStatesForAuction(
    auctionId,
    now,
    dueBatchSize
  );
  if (dueStates.length === 0) {
    return null;
  }

  const updatedStates: AuctionRoundStateDocument[] = [];
  for (const state of dueStates) {
    const transition = evaluateRoundTransition(state, now);
    if (!transition || transition.status === state.status) {
      await repository.refreshNextTransitionAt(state, now);
      continue;
    }

    const auctionIdText = state.auctionId.toHexString();
    const lockKey = buildRoundLockKey(auctionIdText, state.roundIndex);
    let lock: Awaited<ReturnType<typeof acquireRedisLock>> | null = null;
    let proceedWithoutLock = false;
    try {
      lock = await acquireRedisLock(deps.redis, lockKey, roundLockTtlMs);
    } catch (error) {
      proceedWithoutLock = true;
      deps.logger.warn({ err: error, lockKey }, "Round transition lock unavailable");
    }

    if (!lock && !proceedWithoutLock) {
      continue;
    }

    try {
      const updated = await repository.applyRoundTransition(state, transition, now);
      if (updated) {
        updatedStates.push(updated);
      }
    } finally {
      if (lock) {
        await releaseRedisLock(deps.redis, lock);
      }
    }
  }

  if (updatedStates.length === 0) {
    return null;
  }

  const auction = await repository.getAuctionById(auctionId);
  if (!auction) {
    return null;
  }

  let roundStates = await repository.listRoundStates(auction._id);
  if (roundStates.length !== auction.rounds.length) {
    roundStates = await repository.ensureRoundStates(auction);
  }

  const nextStatus = deriveAuctionStatus(roundStates);
  const statusChanged = nextStatus !== auction.status;
  let statusUpdated = false;
  if (statusChanged) {
    statusUpdated = await repository.updateAuctionStatus(
      auction._id,
      auction.status,
      nextStatus,
      now
    );
  }

  if (statusChanged) {
    try {
      await invalidateActiveAuctionListCache(deps.redis);
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to invalidate auction list cache");
    }
  }

  const cacheAuction = statusUpdated ? { ...auction, status: nextStatus } : auction;
  const snapshot = await updateAuctionCaches(
    deps.logger,
    deps.redis,
    repository,
    cacheAuction,
    roundStates,
    updatedStates,
    now
  );

  if (statusChanged) {
    try {
      await publishRealtimeEvent(deps.redis, {
        type: "auction.list.updated",
        auctionId: auction._id.toHexString(),
        reason: "status_changed"
      });
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to publish auction list update");
    }
  }

  if (snapshot) {
    try {
      await publishRealtimeEvent(deps.redis, {
        type: "auction.snapshot.updated",
        auctionId: snapshot.auctionId,
        snapshot: toRealtimeSnapshot({ ...snapshot, serverTime: now })
      });
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to publish auction snapshot update");
    }
  }

  return { updatedStates };
}
