// Auction engine HTTP routes for bid placement.
import type { FastifyInstance, FastifyReply } from "fastify";
import { ObjectId, type WithId } from "mongodb";
import { z } from "zod";
import type { ServiceDependencies } from "../../shared/service.js";
import { LedgerError } from "../ledger/ledgerStore.js";
import { BidError, createBidService } from "./bidService.js";
import type { AuctionRoundStateDocument, BidDocument } from "../../shared/storage/mongoSchemas.js";

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
  auctionId: z.string().min(1),
  roundIndex: z.string().min(1)
});

export async function registerAuctionRoutes(
  app: FastifyInstance,
  deps: ServiceDependencies
): Promise<void> {
  const bidService = createBidService(deps);

  app.post("/auctions/:auctionId/rounds/:roundIndex/bids", async (request, reply) => {
    const params = bidParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid route params." });
    }

    const roundIndexText = params.data.roundIndex.trim();
    if (!/^\d+$/.test(roundIndexText)) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid round index." });
    }
    const roundIndex = Number(roundIndexText);
    if (!Number.isInteger(roundIndex) || roundIndex < 0) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid round index." });
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
        roundIndex,
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
    roundIndex: bid.roundIndex,
    userId: bid.userId,
    amount: bid.amount,
    createdAt: bid.createdAt,
    idempotencyKey: bid.idempotencyKey
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
