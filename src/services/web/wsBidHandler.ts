// WebSocket bid handler for direct bid placement with fast-path compatibility.
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import type { Logger } from "pino";
import type { RedisClient } from "../../shared/storage/redis.js";
import { buildRankingKey } from "../auction-engine/auctionKeys.js";
import {
  BidError,
  type BidPlacementInput,
  type BidPlacementResult
} from "../auction-engine/bidService.js";
import { LedgerError } from "../ledger/ledgerStore.js";

type BidService = {
  placeBid(input: BidPlacementInput): Promise<BidPlacementResult>;
};

export type WsBidRequest = {
  type: "place_bid";
  requestId?: unknown;
  auctionId?: unknown;
  amount?: unknown;
  maxAmount?: unknown;
  idempotencyKey?: unknown;
};

export type WsBidResponse = {
  type: "bid_result";
  requestId: string;
  success: boolean;
  error?: string;
  message?: string;
  bidId?: string;
  auctionId?: string;
  amount?: number;
  maxAmount?: number | null;
  rank?: number | null;
  idempotent?: boolean;
  extended?: boolean;
  latencyMs: number;
};

export class TurboBidHandler {
  constructor(
    private readonly deps: {
      bidService: BidService;
      redis: RedisClient;
      logger: Logger;
    }
  ) {}

  async handleBid(input: {
    userId: string;
    ip: string;
    userAgent?: string;
    request: WsBidRequest;
  }): Promise<WsBidResponse> {
    const started = process.hrtime.bigint();
    const requestId = normalizeText(input.request.requestId) ?? randomUUID();
    const auctionIdText = normalizeText(input.request.auctionId);
    const amount = parseNumber(input.request.amount);
    const maxAmount =
      input.request.maxAmount === undefined || input.request.maxAmount === null
        ? null
        : parseNumber(input.request.maxAmount);
    const idempotencyKey = normalizeText(input.request.idempotencyKey) ?? randomUUID();

    if (
      !auctionIdText ||
      !ObjectId.isValid(auctionIdText) ||
      amount === null ||
      amount <= 0 ||
      (maxAmount !== null && (maxAmount <= 0 || maxAmount < amount))
    ) {
      return buildBidResponse({
        requestId,
        success: false,
        error: "invalid_request",
        message: "Invalid bid request.",
        started
      });
    }

    const audit = {
      requestId,
      source: "websocket",
      ip: input.ip,
      userAgent: input.userAgent
    };

    try {
      const result = await this.deps.bidService.placeBid({
        auctionId: new ObjectId(auctionIdText),
        userId: input.userId,
        amount,
        maxAmount: maxAmount ?? undefined,
        idempotencyKey,
        audit,
        ip: input.ip,
        origin: "manual"
      });

      const rank = await resolveRank(this.deps.redis, auctionIdText, input.userId);

      return buildBidResponse({
        requestId,
        success: true,
        bidId: result.bid._id.toHexString(),
        auctionId: auctionIdText,
        amount: result.bid.amount,
        maxAmount: result.bid.maxAmount ?? null,
        rank,
        idempotent: result.idempotent,
        extended: result.extended,
        started
      });
    } catch (error) {
      if (error instanceof BidError || error instanceof LedgerError) {
        return buildBidResponse({
          requestId,
          success: false,
          error: error.code,
          message: error.message,
          started
        });
      }
      this.deps.logger.error(
        { err: error, userId: input.userId, auctionId: auctionIdText },
        "WebSocket bid failed"
      );
      return buildBidResponse({
        requestId,
        success: false,
        error: "internal_error",
        message: "Internal error.",
        started
      });
    }
  }
}

async function resolveRank(
  redis: RedisClient,
  auctionId: string,
  userId: string
): Promise<number | null> {
  try {
    const rank = await redis.zrevrank(buildRankingKey(auctionId), userId);
    return typeof rank === "number" ? rank + 1 : null;
  } catch {
    return null;
  }
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildBidResponse(input: {
  requestId: string;
  success: boolean;
  error?: string;
  message?: string;
  bidId?: string;
  auctionId?: string;
  amount?: number;
  maxAmount?: number | null;
  rank?: number | null;
  idempotent?: boolean;
  extended?: boolean;
  started: bigint;
}): WsBidResponse {
  const latencyMs = Number(process.hrtime.bigint() - input.started) / 1_000_000;
  return {
    type: "bid_result",
    requestId: input.requestId,
    success: input.success,
    error: input.error,
    message: input.message,
    bidId: input.bidId,
    auctionId: input.auctionId,
    amount: input.amount,
    maxAmount: input.maxAmount ?? null,
    rank: input.rank ?? null,
    idempotent: input.idempotent,
    extended: input.extended,
    latencyMs: Math.round(latencyMs * 100) / 100
  };
}
