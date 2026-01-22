// Auto-generated types for Crypto Auction Platform SDK

export interface Balance {
  available: number;
  held: number;
  current: number;
  spent: number;
}

export interface Auction {
  _id: string;
  title: string;
  description?: string;
  currency: string;
  status: "draft" | "live" | "closed";
  pricingMode?: "first-price" | "cutoff";
  minBid: number;
  minIncrement: number;
  startsAt: string;
  endsAt: string;
  rounds: AuctionRound[];
  currentRoundIndex: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuctionRound {
  index: number;
  allocationSize: number;
  startAt: string;
  endAt: string;
  antiSniping: { triggerWindowSeconds: number; extensionSeconds: number; maxExtensions: number };
}

export interface Bid {
  _id: string;
  auctionId: string;
  userId: string;
  amount: number;
  maxAmount?: number;
  roundIndex: number;
  active: boolean;
  createdAt: string;
}

export interface PlaceBidRequest {
  auctionId: string;
  amount: number;
  maxAmount?: number;
  idempotencyKey: string;
}

export interface PlaceBidResponse {
  bid: Bid;
  balance: Balance;
  rank: number;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  amount: number;
}

export interface ApiError {
  error: string;
  code?: string;
}

export type WsEventType = "bid_placed" | "leaderboard_update" | "outbid" | "balance_update";

export interface WsBidPlaced {
  type: "bid_placed";
  auctionId: string;
  userId: string;
  amount: number;
  rank: number;
  timestamp: string;
}
