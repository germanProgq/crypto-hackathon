// Auction round state transitions and bid ranking rules.
import type { AuctionRoundConfig, AuctionStatus } from "../../shared/storage/mongoSchemas.js";

export type RoundStatus = "scheduled" | "live" | "closed";

export interface AuctionRoundState {
  status: RoundStatus;
  scheduledStartAt: Date;
  scheduledEndAt: Date;
  effectiveEndAt: Date;
  extensionCount: number;
  lastBidAt?: Date;
  startedAt?: Date;
  closedAt?: Date;
}

export interface RoundTransition {
  status: RoundStatus;
  startedAt?: Date;
  closedAt?: Date;
}

export interface AntiSnipingUpdate {
  state: AuctionRoundState;
  extended: boolean;
}

export interface RankedBid {
  bidId: string;
  userId: string;
  amount: number;
  createdAt: Date;
}

export function applyAntiSnipingExtension(
  state: AuctionRoundState,
  config: AuctionRoundConfig,
  bidAt: Date
): AntiSnipingUpdate {
  const bidTimestamp = bidAt.getTime();
  const lastBidAt =
    state.lastBidAt && state.lastBidAt.getTime() > bidTimestamp ? state.lastBidAt : bidAt;
  const normalizedState = { ...state, lastBidAt };

  if (state.status !== "live") {
    return { state: normalizedState, extended: false };
  }

  const { triggerWindowSeconds, extensionSeconds, maxExtensions } = config.antiSniping;
  if (maxExtensions <= state.extensionCount || triggerWindowSeconds <= 0 || extensionSeconds <= 0) {
    return { state: normalizedState, extended: false };
  }

  const effectiveEndMs = state.effectiveEndAt.getTime();
  if (bidTimestamp < state.scheduledStartAt.getTime() || bidTimestamp > effectiveEndMs) {
    return { state: normalizedState, extended: false };
  }

  const windowStartMs = effectiveEndMs - triggerWindowSeconds * 1000;
  if (bidTimestamp < windowStartMs) {
    return { state: normalizedState, extended: false };
  }

  const nextEndAt = new Date(effectiveEndMs + extensionSeconds * 1000);
  return {
    state: {
      ...normalizedState,
      extensionCount: state.extensionCount + 1,
      effectiveEndAt: nextEndAt
    },
    extended: true
  };
}

export function evaluateRoundTransition(
  state: AuctionRoundState,
  now: Date
): RoundTransition | null {
  const nowMs = now.getTime();

  if (state.status === "scheduled") {
    if (nowMs >= state.effectiveEndAt.getTime()) {
      return {
        status: "closed",
        startedAt: state.scheduledStartAt,
        closedAt: state.effectiveEndAt
      };
    }

    if (nowMs >= state.scheduledStartAt.getTime()) {
      return {
        status: "live",
        startedAt: state.scheduledStartAt
      };
    }
  }

  if (state.status === "live" && nowMs >= state.effectiveEndAt.getTime()) {
    return {
      status: "closed",
      closedAt: state.effectiveEndAt
    };
  }

  return null;
}

export function deriveAuctionStatus(
  states: Array<Pick<AuctionRoundState, "status">>
): AuctionStatus {
  if (states.length === 0) {
    return "draft";
  }

  const hasLive = states.some((state) => state.status === "live");
  if (hasLive) {
    return "live";
  }

  const allClosed = states.every((state) => state.status === "closed");
  if (allClosed) {
    return "closed";
  }

  const hasClosed = states.some((state) => state.status === "closed");
  if (hasClosed) {
    return "live";
  }

  return "draft";
}

export function compareRankedBids(left: RankedBid, right: RankedBid): number {
  if (left.amount !== right.amount) {
    return right.amount - left.amount;
  }

  const timeDelta = left.createdAt.getTime() - right.createdAt.getTime();
  if (timeDelta !== 0) {
    return timeDelta;
  }

  const bidIdDelta = compareStrings(left.bidId, right.bidId);
  if (bidIdDelta !== 0) {
    return bidIdDelta;
  }

  return compareStrings(left.userId, right.userId);
}

export function sortRankedBids(bids: RankedBid[]): RankedBid[] {
  return [...bids].sort(compareRankedBids);
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}
