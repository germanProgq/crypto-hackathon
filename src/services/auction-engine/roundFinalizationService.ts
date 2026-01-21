// Purpose: finalize closed auction rounds with verified winners and ledger settlement.
import { randomUUID } from "node:crypto";
import { ObjectId, type AnyBulkWriteOperation, type WithId } from "mongodb";
import type { ServiceDependencies } from "../../shared/service.js";
import { runMongoTransaction } from "../../shared/storage/mongoTransaction.js";
import { buildMerkleRootFromPayloads } from "../../shared/crypto/merkle.js";
import type { RoundProofPayload, SignedRoundProof } from "../../shared/auctionProof.js";
import {
  mongoCollections,
  type AuctionDocument,
  type AuctionRoundConfig,
  type AuctionRoundStateDocument,
  type BidDocument,
  type DeliveryRecordDocument,
  type LedgerAccountDocument,
  type LedgerEntryDocument,
  type NotificationQueueDocument,
  type RoundResultDocument
} from "../../shared/storage/mongoSchemas.js";
import { publishRealtimeEvent } from "../../shared/realtime/events.js";
import { computeExpiresAt, resolveRetentionMs } from "../../shared/storage/retention.js";
import { buildRankingKey, buildTopKey } from "./auctionKeys.js";
import { buildRankingMember, parseRankingMember } from "./bidRanking.js";

const holdLookupBatchSize = 500;
const holdSettlementBatchSize = 250;
const notificationBatchSize = 200;
const topSetTtlSeconds = 10;
const finalizationLockTtlMs = 120000;

const rankingTopSetScript = `
local rankingKey = KEYS[1]
local topKey = KEYS[2]

local topCount = tonumber(ARGV[1])
local topTtl = tonumber(ARGV[2])
local removeCount = tonumber(ARGV[3]) or 0
local index = 4

if removeCount > 0 then
  local removeMembers = {}
  for i = 1, removeCount do
    removeMembers[i] = ARGV[index]
    index = index + 1
  end
  redis.call("ZREM", rankingKey, unpack(removeMembers))
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
    if topTtl and topTtl > 0 then
      redis.call("EXPIRE", topKey, topTtl)
    end
  end
end

return 1
`;

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

type DeliveryReceipt = {
  deliveryRef: string;
  deliveryType?: DeliveryRecordDocument["deliveryType"];
  deliveryPayload?: Record<string, unknown> | null;
};

type HoldSettlementAction = "capture" | "release";

type HoldSettlementInput = Pick<
  WithId<BidDocument>,
  "_id" | "userId"
> & {
  action: HoldSettlementAction;
};

type HoldSettlement = {
  holdId: string;
  bidId: ObjectId;
  userId: string;
  amount: number;
  currency: string;
  action: HoldSettlementAction;
};

type HoldResolutionEntry = Pick<
  LedgerEntryDocument,
  "entryType" | "userId" | "amount" | "currency" | "idempotencyKey" | "metadata"
>;

type HoldEntrySnapshot = Pick<
  LedgerEntryDocument,
  "userId" | "currency" | "amount" | "metadata"
>;

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
  const ledgerAccounts = deps.mongo.db.collection<LedgerAccountDocument>(
    mongoCollections.ledgerAccounts
  );
  const ledgerEntries = deps.mongo.db.collection<LedgerEntryDocument>(mongoCollections.ledgerEntries);
  const notificationQueue = deps.mongo.db.collection<NotificationQueueDocument>(
    mongoCollections.notificationQueue
  );
  const ledgerRetentionMs = resolveRetentionMs(deps.config.dataRetention.ledgerDays);
  const bidRetentionMs = resolveRetentionMs(deps.config.dataRetention.bidsDays);

  async function finalizeClosedRounds(limit = 25): Promise<number> {
    const closedRounds = await roundStates
      .find({ status: "closed", settlementCompletedAt: { $exists: false } })
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

    if (!roundState.settlementCompletedAt) {
      const locked = await acquireFinalizationLock(auctionId, roundIndex);
      if (!locked) {
        return null;
      }
    }

    const existingResult = await roundResults.findOne({ auctionId, roundIndex });
    let winners = existingResult?.winners ?? [];
    let settlementCompleted = Boolean(existingResult?.settlementCompletedAt);
    const isFinalRound = isFinalRoundIndex(auction.rounds, roundIndex);

    if (existingResult?.finalizedAt) {
      await markRoundFinalized(auctionId, roundIndex, existingResult.finalizedAt);
    }
    if (existingResult?.settlementCompletedAt) {
      await markRoundSettlementCompleted(
        auctionId,
        roundIndex,
        existingResult.settlementCompletedAt
      );
    }

    if (!existingResult) {
      winners = await resolveRoundWinners(auction, roundIndex);
      const now = new Date();
      const proof = await buildRoundProof(auction, roundState, roundIndex, winners, now);
      await roundResults.updateOne(
        { auctionId, roundIndex },
        {
          $setOnInsert: {
            auctionId,
            roundIndex,
            winners,
            merkleRoot: proof.merkleRoot,
            merkleCount: proof.merkleCount,
            proof: proof.signedProof ?? undefined,
            finalizedAt: now,
            createdAt: now
          }
        },
        { upsert: true }
      );
      await markRoundFinalized(auctionId, roundIndex, now);
    } else if (!existingResult.merkleRoot || !existingResult.proof) {
      const finalizedAt = existingResult.finalizedAt ?? new Date();
      const proof = await buildRoundProof(
        auction,
        roundState,
        roundIndex,
        winners,
        finalizedAt
      );
      await roundResults.updateOne(
        { auctionId, roundIndex },
        {
          $set: {
            merkleRoot: proof.merkleRoot,
            merkleCount: proof.merkleCount,
            proof: proof.signedProof ?? undefined
          }
        }
      );
    }

    if (!settlementCompleted) {
      const activeBids = await loadActiveBids(auctionId);
      const deliveryRefs = await ensureDeliveryRecords(auction, roundIndex, winners);
      const winnerUsers = new Set(winners.map((winner) => winner.userId));
      const winnerUserIds = Array.from(winnerUsers);
      const loserUserIds = Array.from(
        new Set(
          activeBids.filter((bid) => !winnerUsers.has(bid.userId)).map((bid) => bid.userId)
        )
      );

      const settlementUserIds = isFinalRound
        ? Array.from(new Set([...winnerUserIds, ...loserUserIds]))
        : winnerUserIds;
      const settlementBids = await loadUnsettledBids(auctionId, settlementUserIds);
      const winnerBids = settlementBids.filter((bid) => winnerUsers.has(bid.userId));
      const loserBids = isFinalRound
        ? settlementBids.filter((bid) => !winnerUsers.has(bid.userId))
        : [];

      await settleRoundHolds(auction, roundIndex, winnerBids, loserBids);
      await markBidSettlement(auctionId, roundIndex, winnerUserIds, loserUserIds, isFinalRound);
      await updateRedisRankingAfterSettlement(
        auction,
        roundIndex,
        activeBids,
        winnerUsers,
        isFinalRound
      );
      try {
        if (settlementUserIds.length > 0) {
          await publishRealtimeEvent(deps.redis, {
            type: "bids.active.updated",
            userIds: settlementUserIds
          });
          await publishRealtimeEvent(deps.redis, {
            type: "balance.updated",
            userIds: settlementUserIds,
            currency: auction.currency
          });
        }
        await publishRealtimeEvent(deps.redis, {
          type: "auction.bids.updated",
          auctionId: auction._id.toHexString()
        });
      } catch (error) {
        deps.logger.warn({ err: error }, "Failed to publish realtime settlement updates");
      }
      await queueRoundNotifications(auction, roundIndex, activeBids, winners, deliveryRefs);
      const settledAt = new Date();
      await roundResults.updateOne(
        { auctionId, roundIndex },
        { $set: { settlementCompletedAt: settledAt } }
      );
      settlementCompleted = true;
      await markRoundSettlementCompleted(auctionId, roundIndex, settledAt);
    }

    return {
      auctionId,
      roundIndex,
      winnerCount: winners.length,
      settlementCompleted
    };
  }

  async function markRoundFinalized(
    auctionId: ObjectId,
    roundIndex: number,
    finalizedAt: Date
  ): Promise<void> {
    await roundStates.updateOne(
      { auctionId, roundIndex, finalizedAt: { $exists: false } },
      { $set: { finalizedAt, updatedAt: finalizedAt } }
    );
  }

  async function markRoundSettlementCompleted(
    auctionId: ObjectId,
    roundIndex: number,
    settledAt: Date
  ): Promise<void> {
    await roundStates.updateOne(
      { auctionId, roundIndex, settlementCompletedAt: { $exists: false } },
      { $set: { settlementCompletedAt: settledAt, updatedAt: settledAt } }
    );
  }

  async function acquireFinalizationLock(
    auctionId: ObjectId,
    roundIndex: number
  ): Promise<boolean> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - finalizationLockTtlMs);
    const result = await roundStates.findOneAndUpdate(
      {
        auctionId,
        roundIndex,
        status: "closed",
        settlementCompletedAt: { $exists: false },
        $or: [
          { finalizationLockedAt: { $exists: false } },
          { finalizationLockedAt: { $lte: staleBefore } }
        ]
      },
      { $set: { finalizationLockedAt: now, updatedAt: now } },
      { returnDocument: "after" }
    );
    return Boolean(result);
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
      allocationSize
    );
    const mongoTop = await loadMongoTopBids(auction._id, allocationSize);
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

  async function buildRoundProof(
    auction: WithId<AuctionDocument>,
    roundState: WithId<AuctionRoundStateDocument>,
    roundIndex: number,
    winners: RoundResultDocument["winners"],
    finalizedAt: Date
  ): Promise<{ merkleRoot: string; merkleCount: number; signedProof: SignedRoundProof | null }> {
    const roundConfig = findRoundConfig(auction.rounds, roundIndex);
    const bidPayloads = await loadRoundBidsForProof(auction._id, roundIndex);
    const { root } = buildMerkleRootFromPayloads(bidPayloads);
    const payload: RoundProofPayload = {
      auctionId: auction._id.toHexString(),
      roundIndex,
      allocationSize: roundConfig.allocationSize,
      roundStartAt: roundConfig.startAt.toISOString(),
      roundEndAt: roundConfig.endAt.toISOString(),
      effectiveEndAt: roundState.effectiveEndAt?.toISOString() ?? null,
      extensionCount: roundState.extensionCount ?? null,
      antiSniping: {
        triggerWindowSeconds: roundConfig.antiSniping.triggerWindowSeconds,
        extensionSeconds: roundConfig.antiSniping.extensionSeconds,
        maxExtensions: roundConfig.antiSniping.maxExtensions
      },
      bidsRoot: root,
      bidsCount: bidPayloads.length,
      winners: winners.map((winner) => ({
        userId: winner.userId,
        bidId: winner.bidId.toHexString(),
        amount: winner.amount,
        rank: winner.rank
      })),
      finalizedAt: finalizedAt.toISOString()
    };

    let signedProof: SignedRoundProof | null = null;
    try {
      signedProof = await signRoundProof(payload);
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to sign round proof");
    }

    return { merkleRoot: root, merkleCount: bidPayloads.length, signedProof };
  }

  async function loadRoundBidsForProof(
    auctionId: ObjectId,
    roundIndex: number
  ): Promise<Array<Record<string, unknown>>> {
    const docs = await bids
      .find({ auctionId, roundIndex })
      .sort({ createdAt: 1, _id: 1 })
      .project<Pick<WithId<BidDocument>, "_id" | "userId" | "amount" | "maxAmount" | "createdAt" | "origin">>({
        _id: 1,
        userId: 1,
        amount: 1,
        maxAmount: 1,
        createdAt: 1,
        origin: 1
      })
      .toArray();

    return docs.map((bid) => ({
      bidId: bid._id.toHexString(),
      userId: bid.userId,
      amount: bid.amount,
      maxAmount: bid.maxAmount ?? null,
      createdAt: bid.createdAt.toISOString(),
      origin: bid.origin ?? "manual"
    }));
  }

  async function signRoundProof(payload: RoundProofPayload): Promise<SignedRoundProof | null> {
    const signerUrl = deps.config.crypto.signerUrl.trim();
    const signerToken = deps.config.crypto.signerToken.trim();
    if (!signerUrl || signerUrl.toLowerCase() === "mock") {
      return null;
    }
    if (!signerToken) {
      throw new Error("Signer token is required to sign round proofs.");
    }
    const url = `${normalizeBaseUrl(signerUrl)}/signer/sign-round-result`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signer-token": signerToken
      },
      body: JSON.stringify({ payload })
    });
    if (!response.ok) {
      throw new Error(`Round proof signer failed with ${response.status}.`);
    }
    const json = (await response.json()) as { signedPayload?: SignedRoundProof };
    if (!json?.signedPayload) {
      throw new Error("Round proof signer returned an invalid payload.");
    }
    return json.signedPayload;
  }

  async function loadActiveBids(
    auctionId: ObjectId
  ): Promise<Array<Pick<WithId<BidDocument>, "_id" | "userId" | "amount" | "createdAt">>> {
    return bids
      .find({ auctionId, active: true })
      .project<Pick<WithId<BidDocument>, "_id" | "userId" | "amount" | "createdAt">>({
        _id: 1,
        userId: 1,
        amount: 1,
        createdAt: 1
      })
      .toArray();
  }

  async function loadUnsettledBids(
    auctionId: ObjectId,
    userIds: string[]
  ): Promise<Array<Pick<WithId<BidDocument>, "_id" | "userId">>> {
    if (userIds.length === 0) {
      return [];
    }

    return bids
      .find({
        auctionId,
        userId: { $in: userIds },
        settledAt: { $exists: false }
      })
      .project<Pick<WithId<BidDocument>, "_id" | "userId">>({
        _id: 1,
        userId: 1
      })
      .toArray();
  }

  async function loadMongoTopBids(
    auctionId: ObjectId,
    allocationSize: number
  ): Promise<MongoRankedBid[]> {
    const docs = await bids
      .find({ auctionId, active: true })
      .sort({ amount: -1, createdAt: 1, _id: 1, userId: 1 })
      .limit(allocationSize)
      .project<Pick<WithId<BidDocument>, "_id" | "userId" | "amount" | "createdAt">>({
        _id: 1,
        userId: 1,
        amount: 1,
        createdAt: 1
      })
      .toArray();
    return docs.map((doc) => ({
      bidId: doc._id,
      userId: doc.userId,
      amount: doc.amount,
      createdAt: doc.createdAt
    }));
  }

  async function loadRedisTopBids(
    serviceDeps: ServiceDependencies,
    auctionId: string,
    allocationSize: number
  ): Promise<Array<{ bidId: string; amount: number }>> {
    if (allocationSize <= 0) {
      return [];
    }

    const rankingKey = buildRankingKey(auctionId);
    let entries: string[] = [];
    try {
      entries = await serviceDeps.redis.zrevrange(
        rankingKey,
        0,
        allocationSize - 1,
        "WITHSCORES"
      );
    } catch (error) {
      serviceDeps.logger.warn({ err: error }, "Failed to read Redis ranking for winners");
      return [];
    }
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
    auction: WithId<AuctionDocument>,
    roundIndex: number,
    winners: RoundResultDocument["winners"]
  ): Promise<Map<string, DeliveryReceipt>> {
    const deliveryRefByUser = new Map<string, DeliveryReceipt>();
    if (winners.length === 0) {
      return deliveryRefByUser;
    }

    const now = new Date();
    const deliveryType = resolveDeliveryType(auction);
    const operations = winners.map((winner) => {
      const receipt = buildDeliveryReceipt(
        deliveryType,
        auction._id.toHexString(),
        roundIndex,
        winner.userId,
        winner.rank
      );
      deliveryRefByUser.set(winner.userId, receipt);
      return {
        updateOne: {
          filter: { auctionId: auction._id, roundIndex, userId: winner.userId },
          update: {
            $setOnInsert: {
              auctionId: auction._id,
              roundIndex,
              userId: winner.userId,
              deliveryRef: receipt.deliveryRef,
              deliveryType: receipt.deliveryType,
              deliveryPayload: receipt.deliveryPayload ?? undefined,
              status: "delivered" as const,
              deliveredAt: now,
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

  // Settle holds for winners (capture) and optional losers (release) in batches.
  async function settleRoundHolds(
    auction: WithId<AuctionDocument>,
    roundIndex: number,
    captureBids: Array<Pick<WithId<BidDocument>, "_id" | "userId">>,
    releaseBids: Array<Pick<WithId<BidDocument>, "_id" | "userId">>
  ): Promise<void> {
    if (captureBids.length === 0 && releaseBids.length === 0) {
      return;
    }

    const settlements: HoldSettlementInput[] = [
      ...captureBids.map((bid) => ({ ...bid, action: "capture" as const })),
      ...releaseBids.map((bid) => ({ ...bid, action: "release" as const }))
    ];
    const operations = await buildHoldSettlements(auction, settlements);
    await settleHoldOperations(auction, roundIndex, operations);
  }

  async function buildHoldSettlements(
    auction: WithId<AuctionDocument>,
    bidsForSettlement: HoldSettlementInput[]
  ): Promise<HoldSettlement[]> {
    if (bidsForSettlement.length === 0) {
      return [];
    }

    const holdIds: string[] = [];
    const bidsByHoldId = new Map<string, HoldSettlementInput>();
    for (const bid of bidsForSettlement) {
      const holdId = buildHoldId(bid._id.toHexString());
      if (bidsByHoldId.has(holdId)) {
        throw new Error(`Duplicate hold settlement requested for ${holdId}.`);
      }
      bidsByHoldId.set(holdId, bid);
      holdIds.push(holdId);
    }
    const holdEntries = await loadHoldEntries(holdIds);
    const settlements: HoldSettlement[] = [];

    for (const [holdId, bid] of bidsByHoldId) {
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

      settlements.push({
        holdId,
        bidId: bid._id,
        userId: bid.userId,
        amount: holdEntry.amount,
        currency: holdEntry.currency,
        action: bid.action
      });
    }

    return settlements;
  }

  async function loadHoldEntries(holdIds: string[]): Promise<Map<string, HoldEntrySnapshot>> {
    const entries = new Map<string, HoldEntrySnapshot>();
    for (let index = 0; index < holdIds.length; index += holdLookupBatchSize) {
      const batch = holdIds.slice(index, index + holdLookupBatchSize);
      const results = await ledgerEntries
        .find({ entryType: "hold_created", "metadata.holdId": { $in: batch } })
        .project<HoldEntrySnapshot>({
          userId: 1,
          currency: 1,
          amount: 1,
          metadata: 1
        })
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
    if (operations.length === 0) {
      return;
    }
    for (let index = 0; index < operations.length; index += holdSettlementBatchSize) {
      const batch = operations.slice(index, index + holdSettlementBatchSize);
      await settleHoldOperationsBatch(auction, roundIndex, batch);
    }
  }

  async function settleHoldOperationsBatch(
    auction: WithId<AuctionDocument>,
    roundIndex: number,
    operations: HoldSettlement[]
  ): Promise<void> {
    // Bulk resolve holds per batch, preserving idempotency checks while reducing round trips.
    if (operations.length === 0) {
      return;
    }

    const auctionId = auction._id.toHexString();
    await runMongoTransaction(deps.mongo, async (session) => {
      const holdIds = operations.map((entry) => entry.holdId);
      const existingResolutions = await ledgerEntries
        .find(
          {
            entryType: { $in: ["hold_released", "hold_captured"] },
            "metadata.holdId": { $in: holdIds }
          },
          { session }
        )
        .project<HoldResolutionEntry>({
          entryType: 1,
          userId: 1,
          amount: 1,
          currency: 1,
          idempotencyKey: 1,
          metadata: 1
        })
        .toArray();
      const existingByHoldId = new Map<string, HoldResolutionEntry>();
      for (const entry of existingResolutions) {
        const holdId = extractHoldId(entry.metadata);
        if (!holdId) {
          continue;
        }
        if (existingByHoldId.has(holdId)) {
          throw new Error(`Hold resolved multiple times for ${holdId}.`);
        }
        existingByHoldId.set(holdId, entry);
      }

      const now = new Date();
      const entryOps: Array<AnyBulkWriteOperation<LedgerEntryDocument>> = [];
      const accountIncrements = new Map<
        string,
        {
          userId: string;
          currency: string;
          count: number;
          totals: Partial<Record<LedgerEntryDocument["entryType"], number>>;
        }
      >();

      const expiresAt = computeExpiresAt(now, ledgerRetentionMs);
      for (const settlement of operations) {
        const entryType = toHoldResolutionEntryType(settlement.action);
        const idempotencyKey = buildSettlementIdempotencyKey(
          auctionId,
          roundIndex,
          settlement.action,
          settlement.holdId
        );
        const existing = existingByHoldId.get(settlement.holdId);
        if (existing) {
          assertHoldResolutionMatches(existing, settlement, entryType, idempotencyKey);
          continue;
        }

        const metadata = {
          auctionId,
          roundIndex,
          bidId: settlement.bidId.toHexString(),
          action: settlement.action,
          holdId: settlement.holdId
        };

        const entryDocument: Record<string, unknown> = {
          userId: settlement.userId,
          entryType,
          amount: settlement.amount,
          currency: settlement.currency,
          createdAt: now,
          idempotencyKey,
          metadata
        };
        if (expiresAt) {
          entryDocument.expiresAt = expiresAt;
        }

        entryOps.push({
          updateOne: {
            filter: { idempotencyKey },
            update: {
              $setOnInsert: {
                ...entryDocument
              }
            },
            upsert: true
          }
        });

        const accountKey = `${settlement.userId}:${settlement.currency}`;
        const existingAccount = accountIncrements.get(accountKey);
        if (existingAccount) {
          existingAccount.count += 1;
          existingAccount.totals[entryType] =
            (existingAccount.totals[entryType] ?? 0) + settlement.amount;
        } else {
          accountIncrements.set(accountKey, {
            userId: settlement.userId,
            currency: settlement.currency,
            count: 1,
            totals: { [entryType]: settlement.amount }
          });
        }
      }

      if (entryOps.length === 0) {
        return 0;
      }

      if (accountIncrements.size > 0) {
        const accountOps: Array<AnyBulkWriteOperation<LedgerAccountDocument>> = [];
        for (const account of accountIncrements.values()) {
          const increments: Record<string, number> = { sequence: account.count };
          for (const [entryType, amount] of Object.entries(account.totals)) {
            increments[`totals.${entryType}`] = amount;
          }
          accountOps.push({
            updateOne: {
              filter: { userId: account.userId, currency: account.currency },
              update: {
                $setOnInsert: {
                  userId: account.userId,
                  currency: account.currency,
                  createdAt: now
                },
                $set: { updatedAt: now },
                $inc: increments
              },
              upsert: true
            }
          });
        }
        await ledgerAccounts.bulkWrite(accountOps, { ordered: false, session });
      }

      await ledgerEntries.bulkWrite(entryOps, { ordered: false, session });
      return entryOps.length;
    });
  }

  async function queueRoundNotifications(
    auction: WithId<AuctionDocument>,
    roundIndex: number,
    activeBids: Array<Pick<WithId<BidDocument>, "_id" | "userId" | "amount" | "createdAt">>,
    winners: RoundResultDocument["winners"],
    deliveryRefs: Map<string, DeliveryReceipt>
  ): Promise<void> {
    const winnerByUser = new Map(
      winners.map((winner) => [winner.userId, winner] as const)
    );
    const topBidByUser = resolveTopBidsByUser(activeBids);
    const entries = Array.from(topBidByUser.entries());

    for (let index = 0; index < entries.length; index += notificationBatchSize) {
      const batch = entries.slice(index, index + notificationBatchSize);
      const now = new Date();
      const operations: Array<AnyBulkWriteOperation<NotificationQueueDocument>> = batch.map(
        ([userId, bid]) => {
        const winner = winnerByUser.get(userId);
        const delivery = winner ? deliveryRefs.get(userId) ?? null : null;
        const replayUrl = buildReplayUrl(
          deps.config.web.publicUrl,
          auction._id.toHexString(),
          roundIndex
        );
        const payload: Record<string, unknown> = {
          auctionId: auction._id.toHexString(),
          roundIndex,
          currency: auction.currency,
          result: winner ? "winner" : "non_winner",
          amount: bid.amount,
          bidId: bid._id.toHexString(),
          rank: winner?.rank ?? null,
          deliveryRef: delivery?.deliveryRef ?? null,
          deliveryType: delivery?.deliveryType ?? null,
          deliveryPayload: delivery?.deliveryPayload ?? null,
          replayUrl
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

  async function markBidSettlement(
    auctionId: ObjectId,
    roundIndex: number,
    winnerUserIds: string[],
    loserUserIds: string[],
    isFinalRound: boolean
  ): Promise<void> {
    const now = new Date();
    const expiresAt = computeExpiresAt(now, bidRetentionMs);
    if (isFinalRound) {
      const allUserIds = Array.from(new Set([...winnerUserIds, ...loserUserIds]));
      if (allUserIds.length === 0) {
        return;
      }
      const updateFields: Record<string, unknown> = {
        active: false,
        inactiveAt: now,
        settledAt: now,
        settlementRoundIndex: roundIndex,
        settlementAction: {
          $cond: [{ $in: ["$userId", winnerUserIds] }, "captured", "released"]
        }
      };
      if (expiresAt) {
        updateFields.expiresAt = expiresAt;
      }
      await bids.updateMany(
        { auctionId, userId: { $in: allUserIds }, settledAt: { $exists: false } },
        [
          {
            $set: updateFields
          }
        ]
      );
      return;
    }

    if (winnerUserIds.length > 0) {
      const updateFields: Record<string, unknown> = {
        active: false,
        inactiveAt: now,
        settledAt: now,
        settlementAction: "captured",
        settlementRoundIndex: roundIndex
      };
      if (expiresAt) {
        updateFields.expiresAt = expiresAt;
      }
      await bids.updateMany(
        { auctionId, userId: { $in: winnerUserIds }, settledAt: { $exists: false } },
        {
          $set: {
            ...updateFields
          }
        }
      );
    }
  }

  async function updateRedisRankingAfterSettlement(
    auction: WithId<AuctionDocument>,
    roundIndex: number,
    activeBids: Array<Pick<WithId<BidDocument>, "_id" | "userId" | "amount" | "createdAt">>,
    winnerUsers: Set<string>,
    isFinalRound: boolean
  ): Promise<void> {
    if (activeBids.length === 0) {
      return;
    }

    const auctionId = auction._id.toHexString();
    const rankingKey = buildRankingKey(auctionId);
    const removeMembers = activeBids
      .filter((bid) => isFinalRound || winnerUsers.has(bid.userId))
      .map((bid) => buildRankingMember(bid._id, bid.createdAt));

    const roundConfig = findRoundConfig(auction.rounds, roundIndex);
    const topCount = Math.max(1, Math.floor(roundConfig.allocationSize));
    const topKey = buildTopKey(auctionId);
    const args = [
      topCount.toString(),
      topSetTtlSeconds.toString(),
      removeMembers.length.toString(),
      ...removeMembers
    ];

    try {
      await deps.redis.eval(rankingTopSetScript, 2, rankingKey, topKey, ...args);
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to update Redis ranking after settlement");
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

function isFinalRoundIndex(rounds: AuctionRoundConfig[], roundIndex: number): boolean {
  const firstIndex = rounds[0]?.index;
  if (firstIndex === undefined) {
    return true;
  }
  const maxIndex = rounds.reduce((max, round) => Math.max(max, round.index), firstIndex);
  return roundIndex >= maxIndex;
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
  action: HoldSettlementAction,
  holdId: string
): string {
  return `settlement:${auctionId}:${roundIndex}:${action}:${holdId}`;
}

function toHoldResolutionEntryType(
  action: HoldSettlementAction
): "hold_captured" | "hold_released" {
  return action === "capture" ? "hold_captured" : "hold_released";
}

function assertHoldResolutionMatches(
  entry: HoldResolutionEntry,
  settlement: HoldSettlement,
  expectedEntryType: "hold_captured" | "hold_released",
  expectedIdempotencyKey: string
): void {
  const holdId = extractHoldId(entry.metadata);
  if (!holdId) {
    throw new Error(`Hold id missing for ${settlement.holdId}.`);
  }
  if (holdId !== settlement.holdId) {
    throw new Error(`Hold id mismatch for ${settlement.holdId}.`);
  }
  if (entry.entryType !== expectedEntryType) {
    throw new Error(`Hold settlement action mismatch for ${settlement.holdId}.`);
  }
  if (entry.idempotencyKey !== expectedIdempotencyKey) {
    throw new Error(`Hold settlement idempotency mismatch for ${settlement.holdId}.`);
  }
  if (entry.userId !== settlement.userId) {
    throw new Error(`Hold settlement user mismatch for ${settlement.holdId}.`);
  }
  if (entry.currency !== settlement.currency) {
    throw new Error(`Hold settlement currency mismatch for ${settlement.holdId}.`);
  }
  if (entry.amount !== settlement.amount) {
    throw new Error(`Hold settlement amount mismatch for ${settlement.holdId}.`);
  }
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

function resolveDeliveryType(
  auction: WithId<AuctionDocument>
): DeliveryRecordDocument["deliveryType"] {
  return auction.deliveryType ?? "access_code";
}

function buildDeliveryReceipt(
  deliveryType: DeliveryRecordDocument["deliveryType"],
  auctionId: string,
  roundIndex: number,
  userId: string,
  rank: number
): DeliveryReceipt {
  const reference = buildDeliveryRef(auctionId, roundIndex, userId, rank);
  switch (deliveryType) {
    case "telegram_role": {
      const token = `ROLE-${buildShortToken()}`;
      return {
        deliveryRef: token,
        deliveryType,
        deliveryPayload: { token, role: "VIP", reference }
      };
    }
    case "nft_mint": {
      const mintId = `NFT-${buildShortToken()}`;
      return {
        deliveryRef: mintId,
        deliveryType,
        deliveryPayload: { mintId, reference }
      };
    }
    default: {
      const code = `CODE-${buildShortToken()}`;
      return {
        deliveryRef: code,
        deliveryType: "access_code",
        deliveryPayload: { code, reference }
      };
    }
  }
}

function buildShortToken(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
}

function buildReplayUrl(
  baseUrl: string | undefined,
  auctionId: string,
  roundIndex: number
): string | null {
  if (!baseUrl) {
    return null;
  }
  const base = normalizeBaseUrl(baseUrl);
  return `${base}/?replay=${auctionId}:${roundIndex}`;
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
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
