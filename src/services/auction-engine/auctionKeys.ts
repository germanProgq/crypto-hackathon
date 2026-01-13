// Auction Redis key builders for cached state.
export function buildRankingKey(auctionId: string): string {
  return `auction:${auctionId}:ranking`;
}

export function buildAuctionSnapshotKey(auctionId: string): string {
  return `auction:${auctionId}:snapshot`;
}

export function buildRoundStateKey(auctionId: string, roundIndex: number): string {
  return `auction:${auctionId}:round:${roundIndex}:state`;
}

export function buildTopKey(auctionId: string): string {
  return `state:auction:${auctionId}:top`;
}

export function buildRoundTopKey(auctionId: string, roundIndex: number): string {
  return `state:auction:${auctionId}:round:${roundIndex}:top`;
}

export function buildRoundLockKey(auctionId: string, roundIndex: number): string {
  return `auction:${auctionId}:round:${roundIndex}:lock`;
}

export function buildBidIdempotencyKey(idempotencyKey: string): string {
  return `idempotency:bid:${idempotencyKey}`;
}

export function buildUserRateLimitKey(userId: string): string {
  return `rate:user:${userId}`;
}

export function buildAuctionUserRateLimitKey(auctionId: string, userId: string): string {
  return `rate:auction:${auctionId}:user:${userId}`;
}

export function buildIpRateLimitKey(ip: string): string {
  return `rate:ip:${ip}`;
}

export function buildActiveAuctionListKey(): string {
  return "auction:list:active";
}
