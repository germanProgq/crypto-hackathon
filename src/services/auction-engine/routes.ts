// Auction engine HTTP routes for auctions and bids.
import type { FastifyInstance, FastifyReply } from "fastify";
import { ObjectId, type Collection, type Document, type WithId } from "mongodb";
import { z } from "zod";
import type { ServiceDependencies } from "../../shared/service.js";
import type { RedisClient } from "../../shared/storage/redis.js";
import { runMongoTransaction } from "../../shared/storage/mongoTransaction.js";
import {
  mongoCollections,
  type AuctionDocument,
  type AuctionRoundConfig,
  type AuctionRoundStateDocument,
  type AuctionRoundStatus,
  type AuctionStatus,
  type BidDocument
} from "../../shared/storage/mongoSchemas.js";
import { LedgerError } from "../ledger/ledgerStore.js";
import { parseAuctionConfig, type AuctionConfig } from "./auctionConfig.js";
import { BidError, createBidService } from "./bidService.js";
import { buildAuctionSnapshotKey, buildRoundStateKey } from "./auctionKeys.js";
import { createAuctionRepository } from "./auctionStore.js";

const auditSchema = z
  .object({
    requestId: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    ip: z.string().min(1).optional(),
    userAgent: z.string().min(1).optional(),
    actorId: z.string().min(1).optional()
  })
  .strict();

const bidBodySchema = z
  .object({
    userId: z.string().min(1),
    amount: z.number().positive().finite(),
    idempotencyKey: z.string().min(1),
    metadata: z.record(z.unknown()).optional(),
    audit: auditSchema.optional()
  })
  .strict();

const bidParamsSchema = z.object({
  auctionId: z.string().min(1)
});

const roundParamsSchema = z.object({
  auctionId: z.string().min(1),
  roundIndex: z.string().min(1)
});

const auctionParamsSchema = z.object({
  auctionId: z.string().min(1)
});

const listQuerySchema = z
  .object({
    status: z.enum(["active", "upcoming", "closed"]).default("active"),
    limit: z.string().optional(),
    cursor: z.string().optional()
  })
  .strict();

const snapshotTtlSeconds = 5;
const roundStateTtlSeconds = 5;
const defaultListLimit = 20;
const maxListLimit = 100;

const auctionStatusValues: AuctionStatus[] = ["draft", "live", "closed"];
const roundStatusValues: AuctionRoundStatus[] = ["scheduled", "live", "closed"];

type ListingSpec = {
  status: AuctionStatus;
  sortField: "startsAt" | "endsAt";
  sortDirection: 1 | -1;
};

type ListingCursor = {
  time: Date;
  id: ObjectId;
};

type AuctionSnapshotResponse = {
  auctionId: string;
  status: AuctionStatus;
  title: string;
  currency: string;
  currentRoundIndex: number | null;
  roundStatus: AuctionRoundStatus | null;
  roundEffectiveEndAt: Date | null;
  roundLastBidAt: Date | null;
  updatedAt: Date;
  lastBidAmount: number | null;
};

type RoundTimers = {
  now: Date;
  untilStartMs: number;
  untilScheduledEndMs: number;
  untilEffectiveEndMs: number;
};

type RoundStatePayload = {
  status: AuctionRoundStatus;
  roundIndex: number;
  scheduledStartAt: Date;
  scheduledEndAt: Date;
  effectiveEndAt: Date;
  extensionCount: number;
  lastBidAt: Date | null;
  startedAt: Date | null;
  closedAt: Date | null;
  allocationSize: number;
};

type RoundStateResponse = RoundStatePayload & {
  timers: RoundTimers;
};

class AuctionApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function registerAuctionRoutes(
  app: FastifyInstance,
  deps: ServiceDependencies
): Promise<void> {
  const bidService = createBidService(deps);
  const auctionRepository = createAuctionRepository(deps.mongo);
  const auctions = deps.mongo.db.collection<AuctionDocument>(mongoCollections.auctions);
  const bids = deps.mongo.db.collection<BidDocument>(mongoCollections.bids);

  app.post("/auctions", async (request, reply) => {
    let config: AuctionConfig;
    try {
      config = parseAuctionConfig(request.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid auction payload.";
      return reply.code(400).send({ error: "invalid_request", message });
    }

    try {
      const auction = buildAuctionDocument(config, deps.config.crypto.supportedCurrencies);
      const created = await runMongoTransaction(deps.mongo, async (session) => {
        await auctions.insertOne(auction, { session });
        await auctionRepository.ensureRoundStates(auction, session);
        return auction;
      });

      return reply.code(201).send({ auction: serializeAuction(created) });
    } catch (error) {
      return handleAuctionError(reply, error);
    }
  });

  app.get("/auctions", async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid list query." });
    }

    const limit = parseLimit(query.data.limit, defaultListLimit, maxListLimit);
    if (!limit) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid limit." });
    }

    const spec = resolveListingSpec(query.data.status);
    const cursor = query.data.cursor ? parseListingCursor(query.data.cursor) : null;
    if (query.data.cursor && !cursor) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid cursor." });
    }

    try {
      const filter = buildListingFilter(spec, cursor);
      const sort = { [spec.sortField]: spec.sortDirection, _id: spec.sortDirection };
      const results = await auctions
        .find(filter)
        .sort(sort)
        .limit(limit + 1)
        .toArray();

      const page = results.slice(0, limit);
      const items = page.map(serializeAuctionSummary);
      const lastItem = page[page.length - 1];
      const nextCursor =
        results.length > limit && lastItem
          ? encodeListingCursor(lastItem[spec.sortField], lastItem._id)
          : null;

      return reply.send({ items, nextCursor });
    } catch (error) {
      return handleAuctionError(reply, error);
    }
  });

  app.get("/auctions/:auctionId", async (request, reply) => {
    const params = auctionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid auction id." });
    }

    const auctionId = parseAuctionId(params.data.auctionId);
    if (!auctionId) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid auction id." });
    }

    try {
      const auction = await auctions.findOne({ _id: auctionId });
      if (!auction) {
        throw new AuctionApiError("auction_not_found", "Auction not found.", 404);
      }
      return reply.send({ auction: serializeAuction(auction) });
    } catch (error) {
      return handleAuctionError(reply, error);
    }
  });

  app.get("/auctions/:auctionId/snapshot", async (request, reply) => {
    const params = auctionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid auction id." });
    }

    const auctionId = parseAuctionId(params.data.auctionId);
    if (!auctionId) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid auction id." });
    }

    try {
      const snapshot = await resolveAuctionSnapshot(
        deps.redis,
        auctions,
        bids,
        auctionRepository,
        auctionId
      );
      return reply.send({ snapshot });
    } catch (error) {
      return handleAuctionError(reply, error);
    }
  });

  app.get("/auctions/:auctionId/rounds/:roundIndex/state", async (request, reply) => {
    const params = roundParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid route params." });
    }

    const auctionId = parseAuctionId(params.data.auctionId);
    if (!auctionId) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid auction id." });
    }

    const roundIndex = parseRoundIndex(params.data.roundIndex);
    if (roundIndex === null) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid round index." });
    }

    try {
      const state = await resolveRoundState(
        deps.redis,
        auctions,
        auctionRepository,
        auctionId,
        roundIndex
      );
      const now = new Date();
      return reply.send({ state: buildRoundStateResponse(state, now) });
    } catch (error) {
      return handleAuctionError(reply, error);
    }
  });

  app.post("/auctions/:auctionId/bids", async (request, reply) => {
    const params = bidParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid route params." });
    }

    if (!ObjectId.isValid(params.data.auctionId)) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid auction id." });
    }

    const body = bidBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid bid payload." });
    }

    const userAgentHeader = request.headers["user-agent"];
    const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader;
    let audit = buildAudit(body.data.audit, request.ip, userAgent);
    const requestIdHeader = request.headers["x-request-id"];
    const requestId = Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader;
    if (requestId && typeof requestId === "string" && requestId.trim().length > 0) {
      audit = { ...(audit ?? {}), requestId: audit?.requestId ?? requestId };
    }

    try {
      const result = await bidService.placeBid({
        auctionId: new ObjectId(params.data.auctionId),
        userId: body.data.userId,
        amount: body.data.amount,
        idempotencyKey: body.data.idempotencyKey,
        metadata: body.data.metadata,
        audit,
        ip: request.ip
      });

      return reply.send({
        bid: serializeBid(result.bid),
        balance: result.balance,
        roundState: serializeRoundState(result.roundState),
        extended: result.extended,
        idempotent: result.idempotent
      });
    } catch (error) {
      return handleBidError(reply, error);
    }
  });
}

function buildAudit(
  audit: BidDocument["audit"] | undefined,
  ip: string | undefined,
  userAgent: string | undefined
): BidDocument["audit"] | undefined {
  const normalized: BidDocument["audit"] = audit ? { ...audit } : {};
  if (ip && (!normalized.ip || normalized.ip.trim().length === 0)) {
    normalized.ip = ip;
  }
  if (userAgent && (!normalized.userAgent || normalized.userAgent.trim().length === 0)) {
    normalized.userAgent = userAgent;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function serializeBid(bid: WithId<BidDocument>) {
  return {
    _id: bid._id.toHexString(),
    auctionId: bid.auctionId.toHexString(),
    roundIndex: bid.roundIndex ?? null,
    userId: bid.userId,
    amount: bid.amount,
    createdAt: bid.createdAt,
    idempotencyKey: bid.idempotencyKey,
    active: bid.active
  };
}

function serializeAuction(auction: WithId<AuctionDocument>) {
  return {
    ...auction,
    _id: auction._id.toHexString()
  };
}

function serializeAuctionSummary(auction: WithId<AuctionDocument>) {
  return {
    _id: auction._id.toHexString(),
    title: auction.title,
    description: auction.description ?? null,
    status: auction.status,
    currency: auction.currency,
    startsAt: auction.startsAt,
    endsAt: auction.endsAt,
    roundCount: auction.rounds.length
  };
}

function serializeRoundState(state: WithId<AuctionRoundStateDocument>) {
  return {
    status: state.status,
    roundIndex: state.roundIndex,
    scheduledStartAt: state.scheduledStartAt,
    scheduledEndAt: state.scheduledEndAt,
    effectiveEndAt: state.effectiveEndAt,
    extensionCount: state.extensionCount,
    lastBidAt: state.lastBidAt ?? null
  };
}

function buildAuctionDocument(
  config: AuctionConfig,
  supportedCurrencies: string[]
): WithId<AuctionDocument> {
  const title = normalizeRequiredText(config.title, "title");
  const currency = normalizeCurrency(config.currency, supportedCurrencies);
  const description = normalizeOptionalText(config.description);
  const rounds = normalizeRounds(config.rounds);
  const now = new Date();

  return {
    _id: new ObjectId(),
    title,
    description,
    status: "draft",
    currency,
    startsAt: config.startsAt,
    endsAt: config.endsAt,
    rounds,
    createdAt: now,
    updatedAt: now
  };
}

function normalizeRequiredText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new AuctionApiError("invalid_request", `${field} is required.`, 400);
  }
  return trimmed;
}

function normalizeOptionalText(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeCurrency(value: string, supportedCurrencies: string[]): string {
  const normalized = value.trim().toUpperCase();
  if (!supportedCurrencies.includes(normalized)) {
    throw new AuctionApiError("invalid_request", "Unsupported currency.", 400);
  }
  return normalized;
}

function normalizeRounds(rounds: AuctionRoundConfig[]): AuctionRoundConfig[] {
  return [...rounds]
    .sort((left, right) => left.index - right.index)
    .map((round) => ({
      index: round.index,
      allocationSize: round.allocationSize,
      startAt: round.startAt,
      endAt: round.endAt,
      antiSniping: {
        triggerWindowSeconds: round.antiSniping.triggerWindowSeconds,
        extensionSeconds: round.antiSniping.extensionSeconds,
        maxExtensions: round.antiSniping.maxExtensions
      }
    }));
}

function resolveListingSpec(status: "active" | "upcoming" | "closed"): ListingSpec {
  switch (status) {
    case "upcoming":
      return { status: "draft", sortField: "startsAt", sortDirection: 1 };
    case "closed":
      return { status: "closed", sortField: "endsAt", sortDirection: -1 };
    default:
      return { status: "live", sortField: "startsAt", sortDirection: 1 };
  }
}

function buildListingFilter(spec: ListingSpec, cursor: ListingCursor | null): Document {
  const filter: Document = { status: spec.status };
  if (!cursor) {
    return filter;
  }
  const timeFilter = spec.sortDirection === 1 ? { $gt: cursor.time } : { $lt: cursor.time };
  const idFilter = spec.sortDirection === 1 ? { $gt: cursor.id } : { $lt: cursor.id };
  filter.$or = [
    { [spec.sortField]: timeFilter },
    { [spec.sortField]: cursor.time, _id: idFilter }
  ];
  return filter;
}

function parseLimit(value: string | undefined, fallback: number, max: number): number | null {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    return null;
  }
  return parsed;
}

function parseListingCursor(value: string): ListingCursor | null {
  const [timeText, idText] = value.split("|");
  if (!timeText || !idText) {
    return null;
  }
  const time = new Date(timeText);
  if (Number.isNaN(time.getTime())) {
    return null;
  }
  if (!ObjectId.isValid(idText)) {
    return null;
  }
  return { time, id: new ObjectId(idText) };
}

function encodeListingCursor(time: Date, id: ObjectId): string {
  return `${time.toISOString()}|${id.toHexString()}`;
}

function parseAuctionId(value: string): ObjectId | null {
  if (!ObjectId.isValid(value)) {
    return null;
  }
  return new ObjectId(value);
}

function parseRoundIndex(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function buildRoundStateResponse(state: RoundStatePayload, now: Date): RoundStateResponse {
  return {
    ...state,
    timers: buildRoundTimers(state, now)
  };
}

function buildRoundTimers(state: RoundStatePayload, now: Date): RoundTimers {
  const nowMs = now.getTime();
  return {
    now,
    untilStartMs: Math.max(0, state.scheduledStartAt.getTime() - nowMs),
    untilScheduledEndMs: Math.max(0, state.scheduledEndAt.getTime() - nowMs),
    untilEffectiveEndMs: Math.max(0, state.effectiveEndAt.getTime() - nowMs)
  };
}

async function resolveAuctionSnapshot(
  redis: RedisClient,
  auctions: Collection<AuctionDocument>,
  bids: Collection<BidDocument>,
  repository: ReturnType<typeof createAuctionRepository>,
  auctionId: ObjectId
): Promise<AuctionSnapshotResponse> {
  const auctionIdText = auctionId.toHexString();
  const cached = await readAuctionSnapshotFromRedis(redis, auctionIdText);
  if (cached) {
    return cached;
  }

  const auction = await auctions.findOne({ _id: auctionId });
  if (!auction) {
    throw new AuctionApiError("auction_not_found", "Auction not found.", 404);
  }

  const roundStates = await repository.ensureRoundStates(auction);
  const orderedStates = [...roundStates].sort((left, right) => left.roundIndex - right.roundIndex);
  const current =
    orderedStates.find((state) => state.status === "live") ??
    orderedStates.find((state) => state.status === "scheduled") ??
    orderedStates[orderedStates.length - 1] ??
    null;

  let lastBidAmount: number | null = null;
  let roundLastBidAt: Date | null = current?.lastBidAt ?? null;
  if (current) {
    const lastBid = await bids
      .find({ auctionId, roundIndex: current.roundIndex })
      .project<{ amount: number; createdAt: Date }>({ amount: 1, createdAt: 1 })
      .sort({ createdAt: -1, _id: -1 })
      .limit(1)
      .next();
    if (lastBid) {
      lastBidAmount = lastBid.amount;
      roundLastBidAt = lastBid.createdAt;
    }
  }

  const snapshot: AuctionSnapshotResponse = {
    auctionId: auctionIdText,
    status: auction.status,
    title: auction.title,
    currency: auction.currency,
    currentRoundIndex: current?.roundIndex ?? null,
    roundStatus: current?.status ?? null,
    roundEffectiveEndAt: current?.effectiveEndAt ?? null,
    roundLastBidAt,
    updatedAt: new Date(),
    lastBidAmount
  };

  await writeAuctionSnapshotToRedis(redis, snapshot);
  return snapshot;
}

async function resolveRoundState(
  redis: RedisClient,
  auctions: Collection<AuctionDocument>,
  repository: ReturnType<typeof createAuctionRepository>,
  auctionId: ObjectId,
  roundIndex: number
): Promise<RoundStatePayload> {
  const auctionIdText = auctionId.toHexString();
  const cached = await readRoundStateFromRedis(redis, auctionIdText, roundIndex);
  if (cached) {
    return cached;
  }

  const auction = await auctions.findOne({ _id: auctionId });
  if (!auction) {
    throw new AuctionApiError("auction_not_found", "Auction not found.", 404);
  }

  const roundConfig = findRoundConfig(auction.rounds, roundIndex);
  let roundState = await repository.getRoundState(auctionId, roundIndex);
  if (!roundState) {
    const states = await repository.ensureRoundStates(auction);
    roundState = states.find((state) => state.roundIndex === roundIndex) ?? null;
  }
  if (!roundState) {
    throw new AuctionApiError("round_not_found", "Round state not found.", 404);
  }

  const payload: RoundStatePayload = {
    status: roundState.status,
    roundIndex: roundState.roundIndex,
    scheduledStartAt: roundState.scheduledStartAt,
    scheduledEndAt: roundState.scheduledEndAt,
    effectiveEndAt: roundState.effectiveEndAt,
    extensionCount: roundState.extensionCount,
    lastBidAt: roundState.lastBidAt ?? null,
    startedAt: roundState.startedAt ?? null,
    closedAt: roundState.closedAt ?? null,
    allocationSize: roundConfig.allocationSize
  };

  await writeRoundStateToRedis(redis, auctionIdText, payload);
  return payload;
}

function findRoundConfig(
  rounds: AuctionRoundConfig[],
  roundIndex: number
): AuctionRoundConfig {
  const round = rounds.find((entry) => entry.index === roundIndex);
  if (!round) {
    throw new AuctionApiError("round_not_found", "Round config not found.", 404);
  }
  return round;
}

async function readAuctionSnapshotFromRedis(
  redis: RedisClient,
  auctionId: string
): Promise<AuctionSnapshotResponse | null> {
  const key = buildAuctionSnapshotKey(auctionId);
  const data = await redis.hgetall(key);
  if (Object.keys(data).length === 0) {
    return null;
  }

  const status = parseAuctionStatus(data.status);
  const roundStatus = parseRoundStatus(data.roundStatus);
  const currentRoundIndex = parseRedisInt(data.currentRoundIndex);
  const roundEffectiveEndAt = parseRedisDate(data.roundEffectiveEndAt);
  const updatedAt = parseRedisDate(data.updatedAt);
  const title = parseRedisText(data.title);
  const currency = parseRedisText(data.currency);
  if (
    !status ||
    !roundStatus ||
    currentRoundIndex === null ||
    !roundEffectiveEndAt ||
    !updatedAt ||
    !title ||
    !currency
  ) {
    return null;
  }
  if (data.auctionId && data.auctionId !== auctionId) {
    return null;
  }

  const roundLastBidAt = parseRedisDate(data.roundLastBidAt);
  const lastBidAmount = parseRedisNumber(data.lastBidAmount);

  return {
    auctionId,
    status,
    title,
    currency,
    currentRoundIndex,
    roundStatus,
    roundEffectiveEndAt,
    roundLastBidAt,
    updatedAt,
    lastBidAmount
  };
}

async function readRoundStateFromRedis(
  redis: RedisClient,
  auctionId: string,
  roundIndex: number
): Promise<RoundStatePayload | null> {
  const key = buildRoundStateKey(auctionId, roundIndex);
  const data = await redis.hgetall(key);
  if (Object.keys(data).length === 0) {
    return null;
  }

  const status = parseRoundStatus(data.status);
  const storedIndex = parseRedisInt(data.roundIndex);
  const scheduledStartAt = parseRedisDate(data.scheduledStartAt);
  const scheduledEndAt = parseRedisDate(data.scheduledEndAt);
  const effectiveEndAt = parseRedisDate(data.effectiveEndAt);
  const extensionCount = parseRedisInt(data.extensionCount);
  const allocationSize = parseRedisInt(data.allocationSize);

  if (
    !status ||
    storedIndex === null ||
    storedIndex !== roundIndex ||
    !scheduledStartAt ||
    !scheduledEndAt ||
    !effectiveEndAt ||
    extensionCount === null ||
    allocationSize === null
  ) {
    return null;
  }

  return {
    status,
    roundIndex: storedIndex,
    scheduledStartAt,
    scheduledEndAt,
    effectiveEndAt,
    extensionCount,
    lastBidAt: parseRedisDate(data.lastBidAt),
    startedAt: null,
    closedAt: null,
    allocationSize
  };
}

async function writeAuctionSnapshotToRedis(
  redis: RedisClient,
  snapshot: AuctionSnapshotResponse
): Promise<void> {
  const key = buildAuctionSnapshotKey(snapshot.auctionId);
  const fields: Record<string, string> = {
    auctionId: snapshot.auctionId,
    status: snapshot.status,
    title: snapshot.title,
    currency: snapshot.currency,
    updatedAt: snapshot.updatedAt.toISOString()
  };

  if (snapshot.currentRoundIndex !== null) {
    fields.currentRoundIndex = snapshot.currentRoundIndex.toString();
  }
  if (snapshot.roundStatus) {
    fields.roundStatus = snapshot.roundStatus;
  }
  if (snapshot.roundEffectiveEndAt) {
    fields.roundEffectiveEndAt = snapshot.roundEffectiveEndAt.toISOString();
  }
  if (snapshot.roundLastBidAt) {
    fields.roundLastBidAt = snapshot.roundLastBidAt.toISOString();
  }
  if (snapshot.lastBidAmount !== null) {
    fields.lastBidAmount = snapshot.lastBidAmount.toString();
  }

  const pipeline = redis.multi();
  pipeline.hset(key, fields);
  pipeline.expire(key, snapshotTtlSeconds);
  await pipeline.exec();
}

async function writeRoundStateToRedis(
  redis: RedisClient,
  auctionId: string,
  state: RoundStatePayload
): Promise<void> {
  const key = buildRoundStateKey(auctionId, state.roundIndex);
  const fields: Record<string, string> = {
    status: state.status,
    roundIndex: state.roundIndex.toString(),
    scheduledStartAt: state.scheduledStartAt.toISOString(),
    scheduledEndAt: state.scheduledEndAt.toISOString(),
    effectiveEndAt: state.effectiveEndAt.toISOString(),
    extensionCount: state.extensionCount.toString(),
    allocationSize: state.allocationSize.toString(),
    updatedAt: new Date().toISOString()
  };

  if (state.lastBidAt) {
    fields.lastBidAt = state.lastBidAt.toISOString();
  }

  const pipeline = redis.multi();
  pipeline.hset(key, fields);
  pipeline.expire(key, roundStateTtlSeconds);
  await pipeline.exec();
}

function parseRedisDate(value?: string): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function parseRedisInt(value?: string): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return null;
  }
  return parsed;
}

function parseRedisNumber(value?: string): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function parseRedisText(value?: string): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseAuctionStatus(value?: string): AuctionStatus | null {
  if (!value) {
    return null;
  }
  return auctionStatusValues.includes(value as AuctionStatus) ? (value as AuctionStatus) : null;
}

function parseRoundStatus(value?: string): AuctionRoundStatus | null {
  if (!value) {
    return null;
  }
  return roundStatusValues.includes(value as AuctionRoundStatus)
    ? (value as AuctionRoundStatus)
    : null;
}

function handleBidError(reply: FastifyReply, error: unknown) {
  if (error instanceof BidError) {
    return reply.code(error.status).send({ error: error.code, message: error.message });
  }

  if (error instanceof LedgerError) {
    return reply.code(error.status).send({ error: error.code, message: error.message });
  }

  if (error instanceof Error) {
    return reply.code(500).send({ error: "internal_error", message: error.message });
  }

  return reply.code(500).send({ error: "internal_error", message: "Unknown error." });
}

function handleAuctionError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuctionApiError) {
    return reply.code(error.status).send({ error: error.code, message: error.message });
  }

  if (error instanceof Error) {
    return reply.code(500).send({ error: "internal_error", message: error.message });
  }

  return reply.code(500).send({ error: "internal_error", message: "Unknown error." });
}
