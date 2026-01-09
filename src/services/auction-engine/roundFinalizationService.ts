// Purpose: finalize closed auction rounds with verified winners and ledger settlement.
import { ObjectId, type AnyBulkWriteOperation, type WithId } from "mongodb";
import type { ServiceDependencies } from "../../shared/service.js";
import {
  mongoCollections,
  type AuctionDocument,
  type AuctionRoundConfig,
  type AuctionRoundStateDocument,
  type BidDocument,
  type DeliveryRecordDocument,
  type LedgerEntryDocument,
  type NotificationQueueDocument,
  type RoundResultDocument
} from "../../shared/storage/mongoSchemas.js";
import { createLedgerRepository, LedgerError } from "../ledger/ledgerStore.js";
import { parseRankingMember } from "./bidRanking.js";

const holdLookupBatchSize = 500;
const holdBatchSize = 25;
const notificationBatchSize = 200;

type MongoRankedBid = {
  bidId: ObjectId;
  userId: string;
  amount: number;
  createdAt: Date;
};

type RoundFinalizationSummary = {
  auctionId: ObjectId;
  roundIndex: number;
  winnerCount: number;
  settlementCompleted: boolean;
};

export function createRoundFinalizationService(deps: ServiceDependencies) {
  const auctions = deps.mongo.db.collection<AuctionDocument>(mongoCollections.auctions);
  const roundStates = deps.mongo.db.collection<AuctionRoundStateDocument>(
    mongoCollections.auctionRoundStates
  );
  const bids = deps.mongo.db.collection<BidDocument>(mongoCollections.bids);
  const roundResults = deps.mongo.db.collection<RoundResultDocument>(mongoCollections.roundResults);
  const deliveryRecords = deps.mongo.db.collection<DeliveryRecordDocument>(
    mongoCollections.deliveryRecords
  );
  const ledgerEntries = deps.mongo.db.collection<LedgerEntryDocument>(mongoCollections.ledgerEntries);
  const notificationQueue = deps.mongo.db.collection<NotificationQueueDocument>(
    mongoCollections.notificationQueue
  );
  const ledger = createLedgerRepository(deps.mongo);

  async function finalizeClosedRounds(limit = 25): Promise<number> {
    const closedRounds = await roundStates
      .find({ status: "closed" })
      .sort({ closedAt: 1, effectiveEndAt: 1 })
      .limit(limit)
      .toArray();
    let finalized = 0;

    for (const state of closedRounds) {
      const summary = await finalizeRound(state.auctionId, state.roundIndex);
      if (summary) {
        finalized += 1;
      }
    }

    return finalized;
  }

  // Finalize a closed round with re-entrant settlement steps.
  async function finalizeRound(
    auctionId: ObjectId,
    roundIndex: number
  ): Promise<RoundFinalizationSummary | null> {
    const auction = await auctions.findOne({ _id: auctionId });
    if (!auction) {
      throw new Error(`Auction not found for round finalization: ${auctionId.toHexString()}.`);
    }

    const roundState = await roundStates.findOne({ auctionId, roundIndex });
    if (!roundState || roundState.status !== "closed") {
      return null;
    }

    const existingResult = await roundResults.findOne({ auctionId, roundIndex });
    let winners = existingResult?.winners ?? [];
    let settlementCompleted = Boolean(existingResult?.settlementCompletedAt);

    if (!existingResult) {
      winners = await resolveRoundWinners(auction, roundIndex);
      const now = new Date();
      await roundResults.updateOne(
        { auctionId, roundIndex },
        {
          $setOnInsert: {
            auctionId,
            roundIndex,
            winners,
            finalizedAt: now,
            createdAt: now
          }
        },
        { upsert: true }
      );
    }

    if (!settlementCompleted) {
      const deliveryRefs = await ensureDeliveryRecords(auctionId, roundIndex, winners);
      const roundBids = await loadRoundBids(auctionId, roundIndex);
      await settleRoundHolds(auction, roundIndex, roundBids, winners);
      await queueRoundNotifications(
        auction,
        roundIndex,
        roundBids,
        winners,
        deliveryRefs
      );
      const settledAt = new Date();
      await roundResults.updateOne(
        { auctionId, roundIndex },
        { $set: { settlementCompletedAt: settledAt } }
      );
      settlementCompleted = true;
    }

    return {
      auctionId,
      roundIndex,
      winnerCount: winners.length,
      settlementCompleted
    };
  }

  async function resolveRoundWinners(
    auction: WithId<AuctionDocument>,
    roundIndex: number
  ): Promise<RoundResultDocument["winners"]> {
    const roundConfig = findRoundConfig(auction.rounds, roundIndex);
    const allocationSize = Math.max(0, Math.floor(roundConfig.allocationSize));
    if (allocationSize === 0) {
      return [];
    }

    const redisTop = await loadRedisTopBids(
      deps,
      auction._id.toHexString(),
      roundIndex,
      allocationSize
    );
    const mongoTop = await loadMongoTopBids(auction._id, roundIndex, allocationSize);
    const redisBidIds = redisTop.map((entry) => entry.bidId);
    const mongoBidIds = mongoTop.map((entry) => entry.bidId.toHexString());
    const rankingMatch = rankingsMatch(redisTop, mongoTop);
    if (!rankingMatch && redisBidIds.length > 0) {
      deps.logger.warn(
        { auctionId: auction._id.toHexString(), roundIndex, redisBidIds, mongoBidIds },
        "Redis ranking mismatch detected; using MongoDB ordering."
      );
    }

    return mongoTop.map((entry, index) => ({
      userId: entry.userId,
      bidId: entry.bidId,
      amount: entry.amount,
      rank: index + 1
    }));
  }

  async function loadRoundBids(
    auctionId: ObjectId,
    roundIndex: number
  ): Promise<Array<Pick<WithId<BidDocument>, "_id" | "userId" | "amount" | "createdAt">>> {
    return bids
      .find({ auctionId, roundIndex })
      .project<Pick<WithId<BidDocument>, "_id" | "userId" | "amount" | "createdAt">>({
        _id: 1,
        userId: 1,
        amount: 1,
        createdAt: 1
      })
      .toArray();
  }

  async function loadMongoTopBids(
    auctionId: ObjectId,
    roundIndex: number,
    allocationSize: number
  ): Promise<MongoRankedBid[]> {
    return bids
      .aggregate<MongoRankedBid>([
        { $match: { auctionId, roundIndex } },
        { $sort: { amount: -1, createdAt: 1, _id: 1, userId: 1 } },
        {
          $group: {
            _id: "$userId",
            bidId: { $first: "$_id" },
            userId: { $first: "$userId" },
            amount: { $first: "$amount" },
            createdAt: { $first: "$createdAt" }
          }
        },
        { $sort: { amount: -1, createdAt: 1, bidId: 1, userId: 1 } },
        { $limit: allocationSize }
      ])
      .toArray();
  }

  async function loadRedisTopBids(
    serviceDeps: ServiceDependencies,
    auctionId: string,
    roundIndex: number,
    allocationSize: number
  ): Promise<Array<{ bidId: string; amount: number }>> {
    if (allocationSize <= 0) {
      return [];
    }

    const rankingKey = buildRankingKey(auctionId, roundIndex);
    const entries = await serviceDeps.redis.zrevrange(
      rankingKey,
      0,
      allocationSize - 1,
      "WITHSCORES"
    );
    const results: Array<{ bidId: string; amount: number }> = [];

    for (let index = 0; index < entries.length; index += 2) {
      const member = entries[index];
      const score = entries[index + 1];
      if (!member || !score) {
        continue;
      }

      const parsed = parseRankingMember(member);
      if (!parsed.bidId) {
        continue;
      }

      const amount = Number(score);
      if (!Number.isFinite(amount)) {
        continue;
      }

      results.push({ bidId: parsed.bidId, amount });
    }

    return results;
  }

  async function ensureDeliveryRecords(
    auctionId: ObjectId,
    roundIndex: number,
    winners: RoundResultDocument["winners"]
  ): Promise<Map<string, string>> {
    const deliveryRefByUser = new Map<string, string>();
    if (winners.length === 0) {
      return deliveryRefByUser;
    }

    const now = new Date();
    const operations = winners.map((winner) => {
      const deliveryRef = buildDeliveryRef(
        auctionId.toHexString(),
        roundIndex,
        winner.userId,
        winner.rank
      );
      deliveryRefByUser.set(winner.userId, deliveryRef);
      return {
        updateOne: {
          filter: { auctionId, roundIndex, userId: winner.userId },
          update: {
            $setOnInsert: {
              auctionId,
              roundIndex,
              userId: winner.userId,
              deliveryRef,
              createdAt: now
            }
          },
          upsert: true
        }
      };
    });

    await deliveryRecords.bulkWrite(operations, { ordered: false });
    return deliveryRefByUser;
  }

  // Settle holds for winners and non-winners in batches.
  async function settleRoundHolds(
    auction: WithId<AuctionDocument>,
    roundIndex: number,
    roundBids: Array<Pick<WithId<BidDocument>, "_id" | "userId" | "amount" | "createdAt">>,
    winners: RoundResultDocument["winners"]
  ): Promise<void> {
    if (roundBids.length === 0) {
      return;
    }

    const winnerUsers = new Set(winners.map((winner) => winner.userId));
    const holdIds = roundBids.map((bid) => buildHoldId(bid._id.toHexString()));
    const holdEntries = await loadHoldEntries(holdIds);
    const captureOps: HoldSettlement[] = [];
    const releaseOps: HoldSettlement[] = [];

    for (const bid of roundBids) {
      const holdId = buildHoldId(bid._id.toHexString());
      const holdEntry = holdEntries.get(holdId);
      if (!holdEntry) {
        throw new Error(`Hold entry missing for bid ${bid._id.toHexString()}.`);
      }

      if (holdEntry.userId !== bid.userId) {
        throw new Error(`Hold user mismatch for bid ${bid._id.toHexString()}.`);
      }

      if (holdEntry.currency !== auction.currency) {
        throw new Error(`Hold currency mismatch for bid ${bid._id.toHexString()}.`);
      }

      const action: HoldSettlement["action"] = winnerUsers.has(bid.userId) ? "capture" : "release";
      const settlement: HoldSettlement = {
        holdId,
        bidId: bid._id,
        userId: bid.userId,
        amount: holdEntry.amount,
        currency: holdEntry.currency,
        action
      };

      if (action === "capture") {
        captureOps.push(settlement);
      } else {
        releaseOps.push(settlement);
      }
    }

    await settleHoldOperations(auction, roundIndex, captureOps);
    await settleHoldOperations(auction, roundIndex, releaseOps);
  }

  async function loadHoldEntries(holdIds: string[]): Promise<Map<string, LedgerEntryDocument>> {
    const entries = new Map<string, LedgerEntryDocument>();
    for (let index = 0; index < holdIds.length; index += holdLookupBatchSize) {
      const batch = holdIds.slice(index, index + holdLookupBatchSize);
      const results = await ledgerEntries
        .find({ entryType: "hold_created", "metadata.holdId": { $in: batch } })
        .toArray();
      for (const entry of results) {
        const holdId = extractHoldId(entry.metadata);
        if (holdId) {
          entries.set(holdId, entry);
        }
      }
    }
    return entries;
  }

  async function settleHoldOperations(
    auction: WithId<AuctionDocument>,
    roundIndex: number,
    operations: HoldSettlement[]
  ): Promise<void> {
    for (let index = 0; index < operations.length; index += holdBatchSize) {
      const batch = operations.slice(index, index + holdBatchSize);
      await Promise.all(
        batch.map((entry) => resolveHoldOperation(auction, roundIndex, entry))
      );
    }
  }

  async function resolveHoldOperation(
    auction: WithId<AuctionDocument>,
    roundIndex: number,
    settlement: HoldSettlement
  ): Promise<void> {
    const idempotencyKey = buildSettlementIdempotencyKey(
      auction._id.toHexString(),
      roundIndex,
      settlement.action,
      settlement.holdId
    );
    const metadata = {
      auctionId: auction._id.toHexString(),
      roundIndex,
      bidId: settlement.bidId.toHexString(),
      action: settlement.action
    };

    try {
      if (settlement.action === "capture") {
        await ledger.captureHold({
          userId: settlement.userId,
          amount: settlement.amount,
          currency: settlement.currency,
          holdId: settlement.holdId,
          idempotencyKey,
          metadata
        });
      } else {
        await ledger.releaseHold({
          userId: settlement.userId,
          amount: settlement.amount,
          currency: settlement.currency,
          holdId: settlement.holdId,
          idempotencyKey,
          metadata
        });
      }
    } catch (error) {
      if (error instanceof LedgerError) {
        throw new Error(
          `Hold ${settlement.action} failed for ${settlement.holdId}: ${error.code}.`
        );
      }
      throw error;
    }
  }

  async function queueRoundNotifications(
    auction: WithId<AuctionDocument>,
    roundIndex: number,
    roundBids: Array<Pick<WithId<BidDocument>, "_id" | "userId" | "amount" | "createdAt">>,
    winners: RoundResultDocument["winners"],
    deliveryRefs: Map<string, string>
  ): Promise<void> {
    const winnerByUser = new Map(
      winners.map((winner) => [winner.userId, winner] as const)
    );
    const topBidByUser = resolveTopBidsByUser(roundBids);
    const entries = Array.from(topBidByUser.entries());

    for (let index = 0; index < entries.length; index += notificationBatchSize) {
      const batch = entries.slice(index, index + notificationBatchSize);
      const now = new Date();
      const operations: Array<AnyBulkWriteOperation<NotificationQueueDocument>> = batch.map(
        ([userId, bid]) => {
        const winner = winnerByUser.get(userId);
        const deliveryRef = winner ? deliveryRefs.get(userId) ?? null : null;
        const payload: Record<string, unknown> = {
          auctionId: auction._id.toHexString(),
          roundIndex,
          currency: auction.currency,
          result: winner ? "winner" : "non_winner",
          amount: bid.amount,
          bidId: bid._id.toHexString(),
          rank: winner?.rank ?? null,
          deliveryRef
        };
        const idempotencyKey = buildNotificationIdempotencyKey(
          auction._id.toHexString(),
          roundIndex,
          userId
        );

        return {
          updateOne: {
            filter: { idempotencyKey },
            update: {
              $setOnInsert: {
                type: "round_result",
                userId,
                auctionId: auction._id,
                roundIndex,
                status: "pending",
                payload,
                idempotencyKey,
                attempts: 0,
                nextAttemptAt: now,
                createdAt: now,
                updatedAt: now
              }
            },
            upsert: true
          }
        };
      }
    );

      if (operations.length > 0) {
        await notificationQueue.bulkWrite(operations, { ordered: false });
      }
    }
  }

  return {
    finalizeRound,
    finalizeClosedRounds
  };
}

function findRoundConfig(rounds: AuctionRoundConfig[], roundIndex: number): AuctionRoundConfig {
  const round = rounds.find((entry) => entry.index === roundIndex);
  if (!round) {
    throw new Error(`Round config missing for index ${roundIndex}.`);
  }
  return round;
}

function buildRankingKey(auctionId: string, roundIndex: number): string {
  return `auction:${auctionId}:round:${roundIndex}:ranking`;
}

function buildHoldId(bidId: string): string {
  return `bid:${bidId}`;
}

function extractHoldId(metadata: Record<string, unknown> | undefined): string | null {
  if (!metadata) {
    return null;
  }
  const holdId = metadata.holdId;
  return typeof holdId === "string" && holdId.length > 0 ? holdId : null;
}

function buildSettlementIdempotencyKey(
  auctionId: string,
  roundIndex: number,
  action: "capture" | "release",
  holdId: string
): string {
  return `settlement:${auctionId}:${roundIndex}:${action}:${holdId}`;
}

function buildNotificationIdempotencyKey(
  auctionId: string,
  roundIndex: number,
  userId: string
): string {
  return `notification:${auctionId}:${roundIndex}:${userId}`;
}

function buildDeliveryRef(
  auctionId: string,
  roundIndex: number,
  userId: string,
  rank: number
): string {
  return `delivery:${auctionId}:${roundIndex}:${userId}:${rank}`;
}

function rankingsMatch(
  redisTop: Array<{ bidId: string; amount: number }>,
  mongoTop: MongoRankedBid[]
): boolean {
  if (redisTop.length !== mongoTop.length) {
    return false;
  }
  for (let index = 0; index < redisTop.length; index += 1) {
    const redisBid = redisTop[index];
    const mongoBid = mongoTop[index];
    if (!redisBid || !mongoBid) {
      return false;
    }
    if (redisBid.bidId !== mongoBid.bidId.toHexString()) {
      return false;
    }
    if (Math.abs(redisBid.amount - mongoBid.amount) > 1e-9) {
      return false;
    }
  }
  return true;
}

function resolveTopBidsByUser(
  bids: Array<Pick<WithId<BidDocument>, "_id" | "userId" | "amount" | "createdAt">>
): Map<string, Pick<WithId<BidDocument>, "_id" | "amount" | "createdAt">> {
  const topByUser = new Map<
    string,
    Pick<WithId<BidDocument>, "_id" | "amount" | "createdAt">
  >();

  for (const bid of bids) {
    const existing = topByUser.get(bid.userId);
    if (!existing || compareBidPriority(bid, existing) < 0) {
      topByUser.set(bid.userId, bid);
    }
  }

  return topByUser;
}

function compareBidPriority(
  left: Pick<WithId<BidDocument>, "_id" | "amount" | "createdAt">,
  right: Pick<WithId<BidDocument>, "_id" | "amount" | "createdAt">
): number {
  if (left.amount !== right.amount) {
    return right.amount - left.amount;
  }

  const timeDelta = left.createdAt.getTime() - right.createdAt.getTime();
  if (timeDelta !== 0) {
    return timeDelta;
  }

  const leftId = left._id.toHexString();
  const rightId = right._id.toHexString();
  if (leftId === rightId) {
    return 0;
  }
  return leftId < rightId ? -1 : 1;
}

type HoldSettlement = {
  holdId: string;
  bidId: ObjectId;
  userId: string;
  amount: number;
  currency: string;
  action: "capture" | "release";
};
