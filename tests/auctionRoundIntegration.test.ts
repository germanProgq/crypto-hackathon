// Auction round scheduling integration tests.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/shared/config.js";
import { createLogger } from "../src/shared/logger.js";
import {
  connectMongo,
  ensureMongoCollections,
  ensureMongoIndexes,
  type MongoDependencies
} from "../src/shared/storage/mongo.js";
import {
  mongoCollections,
  type AuctionDocument,
  type AuctionRoundConfig,
  type AuctionRoundStateDocument
} from "../src/shared/storage/mongoSchemas.js";
import { createAuctionRepository } from "../src/services/auction-engine/auctionStore.js";
import { deriveAuctionStatus, evaluateRoundTransition } from "../src/services/auction-engine/roundStateMachine.js";

describe("auction round scheduling", () => {
  const testDbName = `crypto_hack_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const config = loadConfig({
    serviceName: "auction-test",
    defaultPort: 4201,
    env: {
      MONGO_DB: testDbName,
      MONGO_URI: "mongodb://127.0.0.1:27017",
      LOG_LEVEL: "error"
    }
  });
  const logger = createLogger(config);
  let mongo: MongoDependencies;
  let repository: ReturnType<typeof createAuctionRepository>;

  beforeAll(async () => {
    mongo = await connectMongo(config, logger);
    await ensureMongoCollections(mongo.db, logger);
    await ensureMongoIndexes(mongo.db, logger);
    repository = createAuctionRepository(mongo);
  }, 60000);

  beforeEach(async () => {
    await mongo.db.collection(mongoCollections.auctions).deleteMany({});
    await mongo.db.collection(mongoCollections.auctionRoundStates).deleteMany({});
  });

  afterAll(async () => {
    if (mongo) {
      await mongo.db.dropDatabase();
      await mongo.client.close();
    }
  }, 20000);

  it("advances rounds and updates auction status", async () => {
    const base = new Date("2024-01-01T00:00:00Z");
    const rounds: AuctionRoundConfig[] = [
      {
        index: 0,
        allocationSize: 1,
        startAt: base,
        endAt: new Date(base.getTime() + 60_000),
        antiSniping: {
          triggerWindowSeconds: 10,
          extensionSeconds: 30,
          maxExtensions: 1
        }
      },
      {
        index: 1,
        allocationSize: 1,
        startAt: new Date(base.getTime() + 60_000),
        endAt: new Date(base.getTime() + 120_000),
        antiSniping: {
          triggerWindowSeconds: 10,
          extensionSeconds: 30,
          maxExtensions: 1
        }
      }
    ];
    const [firstRound, secondRound] = rounds;
    if (!firstRound || !secondRound) {
      throw new Error("Round config missing.");
    }

    const auction: AuctionDocument = {
      title: "Test auction",
      description: "Integration check",
      status: "draft",
      currency: "USDT",
      pricingMode: "first-price",
      minBid: 0,
      minIncrement: 0,
      startsAt: firstRound.startAt,
      endsAt: secondRound.endAt,
      rounds,
      createdAt: base,
      updatedAt: base
    };

    const auctions = mongo.db.collection<AuctionDocument>(mongoCollections.auctions);
    const inserted = await auctions.insertOne(auction);
    const stored = await auctions.findOne({ _id: inserted.insertedId });
    if (!stored) {
      throw new Error("Auction seed failed.");
    }

    const initialStates = await repository.ensureRoundStates(stored);
    expect(initialStates).toHaveLength(2);

    const firstState = initialStates[0];
    if (!firstState) {
      throw new Error("Round state missing.");
    }

    const liveTime = new Date(base.getTime() + 1_000);
    const liveTransition = evaluateRoundTransition(firstState, liveTime);
    expect(liveTransition?.status).toBe("live");
    const liveState = await repository.applyRoundTransition(firstState, liveTransition!, liveTime);
    expect(liveState?.status).toBe("live");
    if (!liveState) {
      throw new Error("Round did not transition to live.");
    }

    const bidAt = new Date(liveState.effectiveEndAt.getTime() - 5_000);
    const bidUpdate = await repository.applyBidAntiSniping(stored, 0, bidAt);
    expect(bidUpdate.extended).toBe(true);
    expect(bidUpdate.state.extensionCount).toBe(1);

    const statesAfterLive = await mongo.db
      .collection<AuctionRoundStateDocument>(mongoCollections.auctionRoundStates)
      .find({ auctionId: inserted.insertedId })
      .sort({ roundIndex: 1 })
      .toArray();
    const liveStatus = deriveAuctionStatus(statesAfterLive);
    const updatedLive = await repository.updateAuctionStatus(
      inserted.insertedId,
      "draft",
      liveStatus,
      liveTime
    );
    expect(updatedLive).toBe(true);
    const liveAuction = await auctions.findOne({ _id: inserted.insertedId });
    expect(liveAuction?.status).toBe("live");

    const closeTime = new Date(bidUpdate.state.effectiveEndAt.getTime() + 1_000);
    const closeTransition = evaluateRoundTransition(bidUpdate.state, closeTime);
    expect(closeTransition?.status).toBe("closed");
    const closedState = await repository.applyRoundTransition(
      bidUpdate.state,
      closeTransition!,
      closeTime
    );
    expect(closedState?.status).toBe("closed");

    const secondState = await mongo.db
      .collection<AuctionRoundStateDocument>(mongoCollections.auctionRoundStates)
      .findOne({ auctionId: inserted.insertedId, roundIndex: 1 });
    if (!secondState) {
      throw new Error("Second round state missing.");
    }

    const secondLiveTime = new Date(secondRound.startAt.getTime() + 1_000);
    const secondLiveTransition = evaluateRoundTransition(secondState, secondLiveTime);
    expect(secondLiveTransition?.status).toBe("live");
    const secondLiveState = await repository.applyRoundTransition(
      secondState,
      secondLiveTransition!,
      secondLiveTime
    );
    expect(secondLiveState?.status).toBe("live");

    if (!secondLiveState) {
      throw new Error("Second round did not transition to live.");
    }

    const secondCloseTime = new Date(secondRound.endAt.getTime() + 1_000);
    const secondCloseTransition = evaluateRoundTransition(secondLiveState, secondCloseTime);
    expect(secondCloseTransition?.status).toBe("closed");
    const secondClosedState = await repository.applyRoundTransition(
      secondLiveState,
      secondCloseTransition!,
      secondCloseTime
    );
    expect(secondClosedState?.status).toBe("closed");

    const statesAfterClose = await mongo.db
      .collection<AuctionRoundStateDocument>(mongoCollections.auctionRoundStates)
      .find({ auctionId: inserted.insertedId })
      .sort({ roundIndex: 1 })
      .toArray();
    const finalStatus = deriveAuctionStatus(statesAfterClose);
    const updatedClosed = await repository.updateAuctionStatus(
      inserted.insertedId,
      "live",
      finalStatus,
      secondCloseTime
    );
    expect(updatedClosed).toBe(true);
    const closedAuction = await auctions.findOne({ _id: inserted.insertedId });
    expect(closedAuction?.status).toBe("closed");
  }, 20000);
});
