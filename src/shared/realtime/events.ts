import type { RedisClient } from "../storage/redis.js";
import type { AuctionRoundStatus, AuctionStatus } from "../storage/mongoSchemas.js";

export const realtimeEventChannel = "realtime:events";

export type RealtimeAuctionSnapshot = {
  auctionId: string;
  status: AuctionStatus;
  title: string;
  currency: string;
  currentRoundIndex: number | null;
  roundStatus: AuctionRoundStatus | null;
  roundEffectiveEndAt: string | null;
  roundLastBidAt: string | null;
  lastBidAmount: number | null;
  updatedAt: string;
  serverTime: string;
};

export type RealtimeEvent =
  | { type: "auction.list.updated"; reason?: string; auctionId?: string }
  | { type: "auction.snapshot.updated"; auctionId: string; snapshot: RealtimeAuctionSnapshot }
  | { type: "auction.bids.updated"; auctionId: string }
  | { type: "bids.active.updated"; userIds: string[] };

export function toRealtimeSnapshot(input: {
  auctionId: string;
  status: AuctionStatus;
  title: string;
  currency: string;
  currentRoundIndex: number | null;
  roundStatus: AuctionRoundStatus | null;
  roundEffectiveEndAt: Date | null;
  roundLastBidAt: Date | null;
  lastBidAmount: number | null;
  updatedAt: Date;
  serverTime?: Date;
}): RealtimeAuctionSnapshot {
  const serverTime = input.serverTime ?? new Date();
  return {
    auctionId: input.auctionId,
    status: input.status,
    title: input.title,
    currency: input.currency,
    currentRoundIndex: input.currentRoundIndex,
    roundStatus: input.roundStatus,
    roundEffectiveEndAt: input.roundEffectiveEndAt
      ? input.roundEffectiveEndAt.toISOString()
      : null,
    roundLastBidAt: input.roundLastBidAt ? input.roundLastBidAt.toISOString() : null,
    lastBidAmount: input.lastBidAmount,
    updatedAt: input.updatedAt.toISOString(),
    serverTime: serverTime.toISOString()
  };
}

export async function publishRealtimeEvent(
  redis: RedisClient,
  event: RealtimeEvent
): Promise<void> {
  await redis.publish(realtimeEventChannel, JSON.stringify(event));
}
