// Auction engine HTTP routes for auctions and bids.
import type { FastifyInstance, FastifyReply } from "fastify";
import { ObjectId, type Collection, type Document, type WithId } from "mongodb";
import type { ServiceDependencies } from "../../shared/service.js";
import type { RedisClient } from "../../shared/storage/redis.js";
import { runMongoTransaction } from "../../shared/storage/mongoTransaction.js";
import {
  mongoCollections,
  type AuctionDocument,
  type AuctionRoundConfig,
  type AuctionRoundStateDocument,
  type AuctionStatus,
  type BidDocument
} from "../../shared/storage/mongoSchemas.js";
import { LedgerError } from "../ledger/ledgerStore.js";
import { parseAuctionConfig, type AuctionConfig } from "./auctionConfig.js";
import { buildAuctionDocument } from "./auctionCreation.js";
import {
  invalidateActiveAuctionListCache,
  readAuctionSnapshotFromRedis,
  readRoundStateFromRedis,
  writeAuctionSnapshotToRedis,
  writeRoundStateToRedis,
  type AuctionSnapshotCache,
  type RoundStateCache
} from "./auctionCache.js";
import { BidError, createBidService } from "./bidService.js";
import { ensureAuctionRoundProgress } from "./auctionProgress.js";
import { createAuctionRepository } from "./auctionStore.js";
import { publishRealtimeEvent } from "../../shared/realtime/events.js";
import {
  requireCoreAuth,
  requireServiceAuth,
  resolveUserIdFromAuth
} from "../../shared/auth/coreAuth.js";
import { registerOpenAPI } from "../../shared/openapi/spec.js";

type BidAuditPayload = BidDocument["audit"];

type BidBody = {
  userId?: string;
  amount: number;
  maxAmount?: number;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  audit?: BidAuditPayload;
};

type BidParams = {
  auctionId: string;
};

type RoundParams = {
  auctionId: string;
  roundIndex: string;
};

type AuctionParams = {
  auctionId: string;
};

type ListQuery = {
  status?: "active" | "upcoming" | "closed";
  limit?: string;
  cursor?: string;
};

const objectIdParamSchema = { type: "string", pattern: "^[a-fA-F0-9]{24}$" } as const;

const auditSchema = {
  type: "object",
  properties: {
    requestId: { type: "string", minLength: 1 },
    source: { type: "string", minLength: 1 },
    ip: { type: "string", minLength: 1 },
    userAgent: { type: "string", minLength: 1 },
    actorId: { type: "string", minLength: 1 }
  },
  additionalProperties: false
} as const;

const bidBodySchema = {
  type: "object",
  properties: {
    userId: { type: "string", minLength: 1 },
    amount: { type: "number", exclusiveMinimum: 0 },
    maxAmount: { type: "number", exclusiveMinimum: 0 },
    idempotencyKey: { type: "string", minLength: 1 },
    metadata: { type: "object", additionalProperties: true },
    audit: auditSchema
  },
  required: ["amount", "idempotencyKey"],
  additionalProperties: false
} as const;

const auctionRoundSchema = {
  type: "object",
  properties: {
    index: { type: "integer", minimum: 0 },
    allocationSize: { type: "integer", minimum: 1 },
    startAt: { type: "string" },
    endAt: { type: "string" },
    antiSniping: {
      type: "object",
      properties: {
        triggerWindowSeconds: { type: "integer", minimum: 0 },
        extensionSeconds: { type: "integer", minimum: 0 },
        maxExtensions: { type: "integer", minimum: 0 }
      },
      required: ["triggerWindowSeconds", "extensionSeconds", "maxExtensions"],
      additionalProperties: false
    }
  },
  required: ["index", "allocationSize", "startAt", "endAt", "antiSniping"],
  additionalProperties: false
} as const;

const auctionBodySchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
    description: { type: "string" },
    currency: { type: "string", minLength: 1 },
    pricingMode: { type: "string", enum: ["first-price", "cutoff"] },
    minBid: { type: "number", minimum: 0 },
    minIncrement: { type: "number", minimum: 0 },
    deliveryType: { type: "string", enum: ["access_code", "telegram_role", "nft_mint"] },
    startsAt: { type: "string" },
    endsAt: { type: "string" },
    rounds: { type: "array", minItems: 1, items: auctionRoundSchema }
  },
  required: ["title", "currency", "startsAt", "endsAt", "rounds"],
  additionalProperties: false
} as const;

const bidParamsSchema = {
  type: "object",
  properties: {
    auctionId: objectIdParamSchema
  },
  required: ["auctionId"],
  additionalProperties: false
} as const;

const roundParamsSchema = {
  type: "object",
  properties: {
    auctionId: objectIdParamSchema,
    roundIndex: { type: "string", pattern: "^\\d+$" }
  },
  required: ["auctionId", "roundIndex"],
  additionalProperties: false
} as const;

const auctionParamsSchema = {
  type: "object",
  properties: {
    auctionId: objectIdParamSchema
  },
  required: ["auctionId"],
  additionalProperties: false
} as const;

const listQuerySchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["active", "upcoming", "closed"] },
    limit: { type: "string", pattern: "^\\d+$" },
    cursor: { type: "string", minLength: 1 }
  },
  additionalProperties: false
} as const;

const defaultListLimit = 20;
const maxListLimit = 100;

type ListingSpec = {
  status: AuctionStatus;
  sortField: "startsAt" | "endsAt";
  sortDirection: 1 | -1;
};

type ListingCursor = {
  time: Date;
  id: ObjectId;
};

type AuctionSnapshotResponse = AuctionSnapshotCache;

type RoundTimers = {
  now: Date;
  untilStartMs: number;
  untilScheduledEndMs: number;
  untilEffectiveEndMs: number;
};

type RoundStatePayload = RoundStateCache;

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
  // Register OpenAPI/Swagger documentation
  await registerOpenAPI(app);

  const bidService = createBidService(deps);
  const auctionRepository = createAuctionRepository(deps.mongo);
  const auctions = deps.mongo.db.collection<AuctionDocument>(mongoCollections.auctions);
  const bids = deps.mongo.db.collection<BidDocument>(mongoCollections.bids);

  app.post("/auctions", { schema: { body: auctionBodySchema } }, async (request, reply) => {
    if (!requireServiceAuth(request, reply, deps)) {
      return;
    }
    let config: AuctionConfig;
    try {
      config = parseAuctionConfig(request.body, {
        minIncrement: deps.config.bids.minIncrement
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid auction payload.";
      return reply.code(400).send({ error: "invalid_request", message });
    }

    let auction: WithId<AuctionDocument>;
    try {
      auction = buildAuctionDocument(config, deps.config.crypto.supportedCurrencies);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid auction payload.";
      return reply.code(400).send({ error: "invalid_request", message });
    }

    try {
      const created = await runMongoTransaction(deps.mongo, async (session) => {
        await auctions.insertOne(auction, { session });
        await auctionRepository.ensureRoundStates(auction, session);
        return auction;
      });

      try {
        await invalidateActiveAuctionListCache(deps.redis);
      } catch (error) {
        deps.logger.warn({ err: error }, "Failed to invalidate auction list cache");
      }
      try {
        await publishRealtimeEvent(deps.redis, {
          type: "auction.list.updated",
          auctionId: created._id.toHexString(),
          reason: "created"
        });
      } catch (error) {
        deps.logger.warn({ err: error }, "Failed to publish auction list update");
      }

      return reply.code(201).send({ auction: serializeAuction(created) });
    } catch (error) {
      return handleAuctionError(reply, error);
    }
  });

  app.get("/auctions", { schema: { querystring: listQuerySchema } }, async (request, reply) => {
    if (!requireCoreAuth(request, reply, deps)) {
      return;
    }
    const query = request.query as ListQuery;
    const limit = parseLimit(query.limit, defaultListLimit, maxListLimit);
    if (!limit) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid limit." });
    }

    const status = query.status ?? "active";
    const spec = resolveListingSpec(status);
    const cursor = query.cursor ? parseListingCursor(query.cursor) : null;
    if (query.cursor && !cursor) {
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

  app.get(
    "/auctions/:auctionId",
    { schema: { params: auctionParamsSchema } },
    async (request, reply) => {
      if (!requireCoreAuth(request, reply, deps)) {
        return;
      }
      const params = request.params as AuctionParams;
      const auctionId = new ObjectId(params.auctionId);

      try {
        const auction = await auctions.findOne({ _id: auctionId });
        if (!auction) {
          throw new AuctionApiError("auction_not_found", "Auction not found.", 404);
        }
        return reply.send({ auction: serializeAuction(auction) });
      } catch (error) {
        return handleAuctionError(reply, error);
      }
    }
  );

  app.get(
    "/auctions/:auctionId/snapshot",
    { schema: { params: auctionParamsSchema } },
    async (request, reply) => {
      if (!requireCoreAuth(request, reply, deps)) {
        return;
      }
      const params = request.params as AuctionParams;
      const auctionId = new ObjectId(params.auctionId);

      try {
        const now = new Date();
        try {
          await ensureAuctionRoundProgress(deps, auctionRepository, auctionId, now);
        } catch (error) {
          deps.logger.warn(
            { err: error, auctionId: params.auctionId },
            "Failed to refresh auction snapshot"
          );
        }
        const snapshot = await resolveAuctionSnapshot(
          deps.redis,
          auctions,
          bids,
          auctionRepository,
          auctionId,
          deps.logger
        );
        return reply.send({ snapshot });
      } catch (error) {
        return handleAuctionError(reply, error);
      }
    }
  );

  app.get(
    "/auctions/:auctionId/rounds/:roundIndex/state",
    { schema: { params: roundParamsSchema } },
    async (request, reply) => {
      if (!requireCoreAuth(request, reply, deps)) {
        return;
      }
      const params = request.params as RoundParams;
      const auctionId = new ObjectId(params.auctionId);
      const roundIndex = Number(params.roundIndex);

      try {
        const now = new Date();
        try {
          await ensureAuctionRoundProgress(deps, auctionRepository, auctionId, now);
        } catch (error) {
          deps.logger.warn(
            { err: error, auctionId: params.auctionId, roundIndex },
            "Failed to refresh round state"
          );
        }
        const state = await resolveRoundState(
          deps.redis,
          auctions,
          auctionRepository,
          auctionId,
          roundIndex,
          deps.logger
        );
        return reply.send({ state: buildRoundStateResponse(state, now) });
      } catch (error) {
        return handleAuctionError(reply, error);
      }
    }
  );

  app.post(
    "/auctions/:auctionId/bids",
    { schema: { params: bidParamsSchema, body: bidBodySchema } },
    async (request, reply) => {
      const auth = requireCoreAuth(request, reply, deps);
      if (!auth) {
        return;
      }
      const params = request.params as BidParams;
      const body = request.body as BidBody;
      const userId = resolveUserIdFromAuth(auth, body.userId, reply);
      if (!userId) {
        return;
      }

      const userAgentHeader = request.headers["user-agent"];
      const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader;
      let audit = buildAudit(body.audit, request.ip, userAgent);
      const requestIdHeader = request.headers["x-request-id"];
      const requestId = Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader;
      if (requestId && typeof requestId === "string" && requestId.trim().length > 0) {
        audit = { ...(audit ?? {}), requestId: audit?.requestId ?? requestId };
      }

      try {
        const result = await bidService.placeBid({
          auctionId: new ObjectId(params.auctionId),
          userId,
          amount: body.amount,
          maxAmount: body.maxAmount,
          idempotencyKey: body.idempotencyKey,
          metadata: body.metadata,
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
    }
  );
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
    maxAmount: bid.maxAmount ?? null,
    createdAt: bid.createdAt,
    idempotencyKey: bid.idempotencyKey,
    active: bid.active,
    origin: bid.origin ?? null
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
    pricingMode: auction.pricingMode ?? "first-price",
    minBid: Number.isFinite(auction.minBid) ? auction.minBid : 0,
    minIncrement: Number.isFinite(auction.minIncrement) ? auction.minIncrement : 0,
    deliveryType: auction.deliveryType ?? null,
    startsAt: auction.startsAt,
    endsAt: auction.endsAt,
    roundCount: auction.rounds.length,
    currentRoundIndex: auction.currentRoundIndex ?? null,
    roundStatus: auction.roundStatus ?? null,
    roundEffectiveEndAt: auction.roundEffectiveEndAt ?? null,
    roundLastBidAt: auction.roundLastBidAt ?? null,
    lastBidAmount: auction.lastBidAmount ?? null
  };
}

function serializeRoundState(
  state: {
    status: string;
    roundIndex: number;
    scheduledStartAt: Date;
    scheduledEndAt: Date;
    effectiveEndAt: Date;
    extensionCount: number;
    lastBidAt?: Date | null;
  }
) {
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

function buildSnapshotFromAuctionDoc(
  auction: WithId<AuctionDocument>
): AuctionSnapshotResponse | null {
  if (
    auction.currentRoundIndex === undefined ||
    auction.roundStatus === undefined ||
    auction.roundEffectiveEndAt === undefined
  ) {
    return null;
  }

  return {
    auctionId: auction._id.toHexString(),
    status: auction.status,
    title: auction.title,
    currency: auction.currency,
    pricingMode: auction.pricingMode ?? "first-price",
    minBid: Number.isFinite(auction.minBid) ? auction.minBid : 0,
    minIncrement: Number.isFinite(auction.minIncrement) ? auction.minIncrement : 0,
    currentRoundIndex: auction.currentRoundIndex,
    roundStatus: auction.roundStatus,
    roundEffectiveEndAt: auction.roundEffectiveEndAt,
    roundLastBidAt: auction.roundLastBidAt ?? null,
    updatedAt: auction.updatedAt,
    lastBidAmount: auction.lastBidAmount ?? null
  };
}

// Resolve auction snapshots with Redis acceleration and Mongo fallbacks.
async function resolveAuctionSnapshot(
  redis: RedisClient,
  auctions: Collection<AuctionDocument>,
  bids: Collection<BidDocument>,
  repository: ReturnType<typeof createAuctionRepository>,
  auctionId: ObjectId,
  logger: ServiceDependencies["logger"]
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

  const denormSnapshot = buildSnapshotFromAuctionDoc(auction);
  if (denormSnapshot) {
    try {
      await writeAuctionSnapshotToRedis(redis, denormSnapshot);
    } catch (error) {
      logger.warn({ err: error, auctionId: auctionIdText }, "Failed to cache auction snapshot");
    }
    return denormSnapshot;
  }

  let roundStates = await repository.listRoundStates(auctionId);
  if (roundStates.length === 0) {
    roundStates = await repository.ensureRoundStates(auction);
  }
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
      .find({ auctionId, active: true })
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
    pricingMode: auction.pricingMode ?? "first-price",
    minBid: Number.isFinite(auction.minBid) ? auction.minBid : 0,
    minIncrement: Number.isFinite(auction.minIncrement) ? auction.minIncrement : 0,
    currentRoundIndex: current?.roundIndex ?? null,
    roundStatus: current?.status ?? null,
    roundEffectiveEndAt: current?.effectiveEndAt ?? null,
    roundLastBidAt,
    updatedAt: new Date(),
    lastBidAmount
  };

  try {
    await writeAuctionSnapshotToRedis(redis, snapshot);
  } catch (error) {
    logger.warn({ err: error, auctionId: auctionIdText }, "Failed to cache auction snapshot");
  }
  await repository.updateAuctionSnapshot(
    auctionId,
    {
      currentRoundIndex: snapshot.currentRoundIndex,
      roundStatus: snapshot.roundStatus,
      roundEffectiveEndAt: snapshot.roundEffectiveEndAt,
      roundLastBidAt: snapshot.roundLastBidAt,
      lastBidAmount: snapshot.lastBidAmount
    },
    snapshot.updatedAt
  );
  return snapshot;
}

async function resolveRoundState(
  redis: RedisClient,
  auctions: Collection<AuctionDocument>,
  repository: ReturnType<typeof createAuctionRepository>,
  auctionId: ObjectId,
  roundIndex: number,
  logger: ServiceDependencies["logger"]
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
    antiSnipingTriggerWindowSeconds: roundConfig.antiSniping.triggerWindowSeconds,
    antiSnipingExtensionSeconds: roundConfig.antiSniping.extensionSeconds,
    antiSnipingMaxExtensions: roundConfig.antiSniping.maxExtensions,
    lastBidAt: roundState.lastBidAt ?? null,
    startedAt: roundState.startedAt ?? null,
    closedAt: roundState.closedAt ?? null,
    allocationSize: roundConfig.allocationSize
  };

  try {
    await writeRoundStateToRedis(redis, auctionIdText, payload);
  } catch (error) {
    logger.warn(
      { err: error, auctionId: auctionIdText, roundIndex },
      "Failed to cache round state"
    );
  }
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
