// Auction storage operations for round state and anti-sniping.
import type {
  AnyBulkWriteOperation,
  ClientSession,
  Document,
  ObjectId,
  WithId
} from "mongodb";
import type { MongoDependencies } from "../../shared/storage/mongo.js";
import {
  mongoCollections,
  type AuctionDocument,
  type AuctionRoundConfig,
  type AuctionRoundStateDocument,
  type AuctionStatus
} from "../../shared/storage/mongoSchemas.js";
import { applyAntiSnipingExtension, type RoundTransition } from "./roundStateMachine.js";

const antiSnipingUpdateAttempts = 3;

export interface RoundBidUpdateResult {
  state: WithId<AuctionRoundStateDocument>;
  extended: boolean;
}

export function createAuctionRepository(mongo: MongoDependencies) {
  const auctions = mongo.db.collection<AuctionDocument>(mongoCollections.auctions);
  const roundStates = mongo.db.collection<AuctionRoundStateDocument>(
    mongoCollections.auctionRoundStates
  );

  async function listActiveAuctions(): Promise<Array<WithId<AuctionDocument>>> {
    return auctions
      .find({ status: { $in: ["draft", "live"] } })
      .sort({ startsAt: 1 })
      .toArray();
  }

  async function getAuctionById(
    auctionId: ObjectId,
    session?: ClientSession
  ): Promise<WithId<AuctionDocument> | null> {
    return auctions.findOne({ _id: auctionId }, { session });
  }

  async function getRoundState(
    auctionId: ObjectId,
    roundIndex: number,
    session?: ClientSession
  ): Promise<WithId<AuctionRoundStateDocument> | null> {
    return roundStates.findOne({ auctionId, roundIndex }, { session });
  }

  async function getLiveRoundState(
    auctionId: ObjectId,
    session?: ClientSession
  ): Promise<WithId<AuctionRoundStateDocument> | null> {
    return roundStates.findOne(
      { auctionId, status: "live" },
      { session, sort: { roundIndex: 1 } }
    );
  }

  async function ensureRoundStates(
    auction: WithId<AuctionDocument>,
    session?: ClientSession
  ): Promise<Array<WithId<AuctionRoundStateDocument>>> {
    if (auction.rounds.length === 0) {
      return [];
    }

    const now = new Date();
    const operations: Array<AnyBulkWriteOperation<AuctionRoundStateDocument>> = auction.rounds.map(
      (round) => ({
      updateOne: {
        filter: { auctionId: auction._id, roundIndex: round.index },
        update: {
          $setOnInsert: {
            auctionId: auction._id,
            roundIndex: round.index,
            status: "scheduled",
            scheduledStartAt: round.startAt,
            scheduledEndAt: round.endAt,
            effectiveEndAt: round.endAt,
            extensionCount: 0,
            createdAt: now,
            updatedAt: now
          }
        },
        upsert: true
      }
    })
    );

    if (operations.length > 0) {
      await roundStates.bulkWrite(operations, { ordered: false, session });
    }

    return roundStates
      .find({ auctionId: auction._id }, { session })
      .sort({ roundIndex: 1 })
      .toArray();
  }

  async function applyRoundTransition(
    state: WithId<AuctionRoundStateDocument>,
    transition: RoundTransition,
    now: Date
  ): Promise<WithId<AuctionRoundStateDocument> | null> {
    const updateFields: Record<string, unknown> = {
      status: transition.status,
      updatedAt: now
    };

    if (transition.startedAt) {
      updateFields.startedAt = transition.startedAt;
    }

    if (transition.closedAt) {
      updateFields.closedAt = transition.closedAt;
    }

    const filter: Document = { _id: state._id, status: state.status };
    if (transition.status === "closed") {
      filter.effectiveEndAt = state.effectiveEndAt;
    }

    const updated = await roundStates.findOneAndUpdate(
      filter,
      { $set: updateFields },
      { returnDocument: "after" }
    );
    return updated ?? null;
  }

  async function updateAuctionStatus(
    auctionId: ObjectId,
    expectedStatus: AuctionStatus,
    status: AuctionStatus,
    now: Date
  ): Promise<boolean> {
    const result = await auctions.updateOne(
      { _id: auctionId, status: expectedStatus },
      { $set: { status, updatedAt: now } }
    );
    return result.modifiedCount > 0;
  }

  async function applyBidAntiSniping(
    auction: WithId<AuctionDocument>,
    roundIndex: number,
    bidAt: Date,
    session?: ClientSession
  ): Promise<RoundBidUpdateResult> {
    const roundConfig = findRoundConfig(auction.rounds, roundIndex);

    for (let attempt = 0; attempt < antiSnipingUpdateAttempts; attempt += 1) {
      const state = await roundStates.findOne(
        { auctionId: auction._id, roundIndex },
        { session }
      );
      if (!state) {
        throw new Error(`Round state missing for auction ${auction._id.toHexString()}.`);
      }

      const update = applyAntiSnipingExtension(state, roundConfig, bidAt);
      if (!requiresRoundStateUpdate(toRoundStateSnapshot(state), update.state)) {
        return { state, extended: false };
      }

      const now = new Date();
      const updateFields: Record<string, unknown> = {
        lastBidAt: update.state.lastBidAt ?? state.lastBidAt,
        extensionCount: update.state.extensionCount,
        effectiveEndAt: update.state.effectiveEndAt,
        updatedAt: now
      };

      const updated = await roundStates.findOneAndUpdate(
        { _id: state._id, updatedAt: state.updatedAt },
        { $set: updateFields },
        { returnDocument: "after", session }
      );

      if (updated) {
        return { state: updated, extended: update.extended };
      }
    }

    throw new Error("Round state update conflict.");
  }

  return {
    listActiveAuctions,
    getAuctionById,
    getRoundState,
    getLiveRoundState,
    ensureRoundStates,
    applyRoundTransition,
    updateAuctionStatus,
    applyBidAntiSniping
  };
}

function findRoundConfig(
  rounds: AuctionRoundConfig[],
  roundIndex: number
): AuctionRoundConfig {
  const round = rounds.find((entry) => entry.index === roundIndex);
  if (!round) {
    throw new Error(`Round config missing for index ${roundIndex}.`);
  }
  return round;
}

function requiresRoundStateUpdate(current: RoundStateSnapshot, next: RoundStateSnapshot): boolean {
  if (current.extensionCount !== next.extensionCount) {
    return true;
  }

  if (current.effectiveEndAt.getTime() !== next.effectiveEndAt.getTime()) {
    return true;
  }

  return !datesMatch(current.lastBidAt, next.lastBidAt);
}

function datesMatch(left?: Date, right?: Date): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return left.getTime() === right.getTime();
}

function toRoundStateSnapshot(state: RoundStateSnapshot): RoundStateSnapshot {
  return {
    extensionCount: state.extensionCount,
    effectiveEndAt: state.effectiveEndAt,
    lastBidAt: state.lastBidAt
  };
}

type RoundStateSnapshot = {
  extensionCount: number;
  effectiveEndAt: Date;
  lastBidAt?: Date;
};
