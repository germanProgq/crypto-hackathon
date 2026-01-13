// Redis key conventions and cache rules.
export type RedisKeySpec = {
  key: string;
  type: "zset" | "hash" | "string" | "set";
  ttlSeconds?: number;
  invalidationEvents: string[];
};

export const redisKeySpecs: RedisKeySpec[] = [
  {
    key: "auction:{auctionId}:ranking",
    type: "zset",
    invalidationEvents: ["bid.accepted", "round.finalized"]
  },
  {
    key: "auction:{auctionId}:snapshot",
    type: "hash",
    ttlSeconds: 5,
    invalidationEvents: ["bid.accepted", "round.extended", "round.finalized"]
  },
  {
    key: "auction:{auctionId}:round:{roundIndex}:state",
    type: "hash",
    ttlSeconds: 5,
    invalidationEvents: ["bid.accepted", "round.extended", "round.finalized"]
  },
  {
    key: "auction:{auctionId}:round:{roundIndex}:lock",
    type: "string",
    ttlSeconds: 15,
    invalidationEvents: ["lock.expired"]
  },
  {
    key: "auction:{auctionId}:bid:lock",
    type: "string",
    ttlSeconds: 15,
    invalidationEvents: ["lock.expired"]
  },
  {
    key: "rate:user:{userId}",
    type: "hash",
    ttlSeconds: 2,
    invalidationEvents: ["rate.limit.reset"]
  },
  {
    key: "rate:auction:{auctionId}:user:{userId}",
    type: "hash",
    ttlSeconds: 2,
    invalidationEvents: ["rate.limit.reset"]
  },
  {
    key: "rate:ip:{ip}",
    type: "hash",
    ttlSeconds: 2,
    invalidationEvents: ["rate.limit.reset"]
  },
  {
    key: "idempotency:bid:{idempotencyKey}",
    type: "string",
    ttlSeconds: 600,
    invalidationEvents: ["bid.persisted"]
  },
  {
    key: "state:auction:{auctionId}:top",
    type: "set",
    ttlSeconds: 10,
    invalidationEvents: ["bid.accepted", "round.finalized"]
  },
  {
    key: "notification:{notificationId}:lock",
    type: "string",
    ttlSeconds: 15,
    invalidationEvents: ["lock.expired"]
  },
  {
    key: "crypto:deposits:lock",
    type: "string",
    ttlSeconds: 15,
    invalidationEvents: ["lock.expired"]
  },
  {
    key: "crypto:withdrawals:broadcast:lock",
    type: "string",
    ttlSeconds: 20,
    invalidationEvents: ["lock.expired"]
  },
  {
    key: "crypto:withdrawals:confirm:lock",
    type: "string",
    ttlSeconds: 20,
    invalidationEvents: ["lock.expired"]
  }
];
