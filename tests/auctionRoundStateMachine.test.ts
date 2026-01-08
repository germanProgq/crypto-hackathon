// Auction round state machine tests.
import { describe, expect, it } from "vitest";
import {
  applyAntiSnipingExtension,
  evaluateRoundTransition,
  sortRankedBids,
  type AuctionRoundState,
  type RankedBid
} from "../src/services/auction-engine/roundStateMachine.js";
import type { AuctionRoundConfig } from "../src/shared/storage/mongoSchemas.js";

describe("round state transitions", () => {
  it("moves a scheduled round to live after the start time", () => {
    const startAt = new Date("2024-01-01T00:00:00Z");
    const endAt = new Date("2024-01-01T00:01:00Z");
    const state: AuctionRoundState = {
      status: "scheduled",
      scheduledStartAt: startAt,
      scheduledEndAt: endAt,
      effectiveEndAt: endAt,
      extensionCount: 0
    };

    const transition = evaluateRoundTransition(state, new Date("2024-01-01T00:00:10Z"));
    expect(transition).toEqual({ status: "live", startedAt: startAt });
  });

  it("closes a round once the effective end time passes", () => {
    const startAt = new Date("2024-01-01T00:00:00Z");
    const endAt = new Date("2024-01-01T00:01:00Z");
    const state: AuctionRoundState = {
      status: "scheduled",
      scheduledStartAt: startAt,
      scheduledEndAt: endAt,
      effectiveEndAt: endAt,
      extensionCount: 0
    };

    const transition = evaluateRoundTransition(state, new Date("2024-01-01T00:02:00Z"));
    expect(transition).toEqual({
      status: "closed",
      startedAt: startAt,
      closedAt: endAt
    });
  });
});

describe("anti-sniping extensions", () => {
  const startAt = new Date("2024-01-01T00:00:00Z");
  const endAt = new Date("2024-01-01T00:01:00Z");
  const config: AuctionRoundConfig = {
    index: 0,
    allocationSize: 10,
    startAt,
    endAt,
    antiSniping: {
      triggerWindowSeconds: 10,
      extensionSeconds: 30,
      maxExtensions: 2
    }
  };

  it("extends a round within the trigger window and honors caps", () => {
    const state: AuctionRoundState = {
      status: "live",
      scheduledStartAt: startAt,
      scheduledEndAt: endAt,
      effectiveEndAt: endAt,
      extensionCount: 0
    };

    const firstBidAt = new Date(endAt.getTime() - 5000);
    const first = applyAntiSnipingExtension(state, config, firstBidAt);
    expect(first.extended).toBe(true);
    expect(first.state.extensionCount).toBe(1);
    expect(first.state.effectiveEndAt.getTime()).toBe(endAt.getTime() + 30000);

    const secondBidAt = new Date(first.state.effectiveEndAt.getTime() - 9000);
    const second = applyAntiSnipingExtension(first.state, config, secondBidAt);
    expect(second.extended).toBe(true);
    expect(second.state.extensionCount).toBe(2);

    const thirdBidAt = new Date(second.state.effectiveEndAt.getTime() - 9000);
    const third = applyAntiSnipingExtension(second.state, config, thirdBidAt);
    expect(third.extended).toBe(false);
    expect(third.state.extensionCount).toBe(2);
  });
});

describe("deterministic bid tie-breakers", () => {
  it("orders identical bids by created time then id", () => {
    const bids: RankedBid[] = [
      {
        bidId: "b2",
        userId: "u2",
        amount: 100,
        createdAt: new Date("2024-01-01T00:00:01Z")
      },
      {
        bidId: "b1",
        userId: "u1",
        amount: 100,
        createdAt: new Date("2024-01-01T00:00:00Z")
      },
      {
        bidId: "b0",
        userId: "u0",
        amount: 100,
        createdAt: new Date("2024-01-01T00:00:00Z")
      },
      {
        bidId: "b3",
        userId: "u3",
        amount: 90,
        createdAt: new Date("2024-01-01T00:00:00Z")
      }
    ];

    const sorted = sortRankedBids(bids);
    expect(sorted.map((bid) => bid.bidId)).toEqual(["b0", "b1", "b2", "b3"]);
  });
});
