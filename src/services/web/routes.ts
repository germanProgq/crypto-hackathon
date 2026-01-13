// Web UI routes and static file serving.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ObjectId, type WithId } from "mongodb";
import type { ServiceDependencies } from "../../shared/service.js";
import {
  mongoCollections,
  type AuctionDocument,
  type AuctionStatus,
  type BidDocument
} from "../../shared/storage/mongoSchemas.js";
import {
  invalidateActiveAuctionListCache,
  readActiveAuctionListFromRedis,
  writeActiveAuctionListToRedis
} from "../auction-engine/auctionCache.js";
import { parseRankingMember } from "../auction-engine/bidRanking.js";
import { BidError, createBidService } from "../auction-engine/bidService.js";
import { createAuctionRepository } from "../auction-engine/auctionStore.js";
import { createLedgerRepository, LedgerError } from "../ledger/ledgerStore.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

type CreateAuctionBody = {
  title: string;
  description?: string;
  currency?: string;
  rounds?: number;
  allocationSize?: number;
  roundDurationSeconds?: number;
  startOffsetSeconds?: number;
  antiSniping?: {
    triggerWindowSeconds: number;
    extensionSeconds: number;
    maxExtensions: number;
  };
};

type BidPlacementBody = {
  userId?: string;
  amount: number;
  idempotencyKey?: string;
};

const createAuctionSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
    description: { type: "string" },
    currency: { type: "string", minLength: 1 },
    rounds: { type: "integer", minimum: 1, maximum: 20 },
    allocationSize: { type: "integer", minimum: 1, maximum: 500 },
    roundDurationSeconds: { type: "integer", minimum: 30, maximum: 7200 },
    startOffsetSeconds: { type: "integer", minimum: 0, maximum: 86400 },
    antiSniping: {
      type: "object",
      properties: {
        triggerWindowSeconds: { type: "integer", minimum: 0, maximum: 600 },
        extensionSeconds: { type: "integer", minimum: 0, maximum: 600 },
        maxExtensions: { type: "integer", minimum: 0, maximum: 20 }
      },
      required: ["triggerWindowSeconds", "extensionSeconds", "maxExtensions"],
      additionalProperties: false
    }
  },
  required: ["title"],
  additionalProperties: false
} as const;

const bidPlacementSchema = {
  type: "object",
  properties: {
    userId: { type: "string", minLength: 1 },
    amount: { type: "number", exclusiveMinimum: 0 },
    idempotencyKey: { type: "string", minLength: 1 }
  },
  required: ["amount"],
  additionalProperties: false
} as const;

export async function registerWebRoutes(
  app: FastifyInstance,
  deps: ServiceDependencies
): Promise<void> {
  const auctionRepository = createAuctionRepository(deps.mongo);
  const ledgerRepository = createLedgerRepository(deps.mongo);
  const bidService = createBidService(deps);
  const bids = deps.mongo.db.collection<BidDocument>(mongoCollections.bids);

  app.get("/", async (request, reply) => {
    const html = await loadHtml("index.html");
    return reply.type("text/html").send(html);
  });

  app.get("/api/auctions", async () => {
    try {
      const cached = await readActiveAuctionListFromRedis(deps.redis);
      if (cached !== null) {
        return cached;
      }
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to read auction list cache");
    }

    const auctions = await auctionRepository.listActiveAuctions();
    const payload = auctions.map((auction) => ({
      _id: auction._id.toHexString(),
      title: auction.title,
      description: auction.description,
      status: auction.status,
      currency: auction.currency,
      startsAt: auction.startsAt,
      endsAt: auction.endsAt,
      currentRoundIndex: auction.currentRoundIndex ?? null,
      roundStatus: auction.roundStatus ?? null,
      roundEffectiveEndAt: auction.roundEffectiveEndAt ?? null,
      roundLastBidAt: auction.roundLastBidAt ?? null,
      lastBidAmount: auction.lastBidAmount ?? null,
      rounds: auction.rounds.map((round) => ({
        index: round.index,
        allocationSize: round.allocationSize,
        startAt: round.startAt,
        endAt: round.endAt
      }))
    }));

    try {
      await writeActiveAuctionListToRedis(deps.redis, payload);
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to write auction list cache");
    }

    return payload;
  });

  app.post(
    "/api/auctions",
    { schema: { body: createAuctionSchema } },
    async (request, reply) => {
      const body = request.body as CreateAuctionBody;
      const now = new Date();
      const roundsCount = body.rounds ?? 3;
      const allocationSize = body.allocationSize ?? 5;
      const roundDurationSeconds = body.roundDurationSeconds ?? 300;
      const startOffsetSeconds = Math.max(0, body.startOffsetSeconds ?? 0);
      const startAt = new Date(now.getTime() + startOffsetSeconds * 1000);
      const rounds = Array.from({ length: roundsCount }).map((_, index) => {
        const roundStart = new Date(startAt.getTime() + index * roundDurationSeconds * 1000);
        const roundEnd = new Date(roundStart.getTime() + roundDurationSeconds * 1000);
        return {
          index,
          allocationSize,
          startAt: roundStart,
          endAt: roundEnd,
          antiSniping: {
            triggerWindowSeconds: body.antiSniping?.triggerWindowSeconds ?? 10,
            extensionSeconds: body.antiSniping?.extensionSeconds ?? 15,
            maxExtensions: body.antiSniping?.maxExtensions ?? 3
          }
        };
      });
      const firstRound = rounds[0] ?? null;
      const endsAt = rounds[rounds.length - 1]?.endAt ?? startAt;
      const status: AuctionStatus = startAt.getTime() <= now.getTime() ? "live" : "draft";
      const auction: AuctionDocument = {
        title: body.title,
        status,
        currency: body.currency ?? "USDT",
        startsAt: startAt,
        endsAt,
        rounds,
        currentRoundIndex: firstRound?.index ?? null,
        roundStatus: firstRound ? "scheduled" : null,
        roundEffectiveEndAt: firstRound?.endAt ?? null,
        roundLastBidAt: null,
        lastBidAmount: null,
        createdAt: now,
        updatedAt: now
      };
      if (body.description && body.description.trim().length > 0) {
        auction.description = body.description.trim();
      }

      const auctions = deps.mongo.db.collection<AuctionDocument>(mongoCollections.auctions);
      const inserted = await auctions.insertOne(auction);
      const stored = await auctions.findOne({ _id: inserted.insertedId });
      if (stored) {
        await auctionRepository.ensureRoundStates(stored);
      }

      try {
        await invalidateActiveAuctionListCache(deps.redis);
      } catch (error) {
        deps.logger.warn({ err: error }, "Failed to invalidate auction list cache");
      }

      return reply.code(201).send({ _id: inserted.insertedId.toHexString(), status });
    }
  );

  app.get("/api/auctions/:auctionId", async (request, reply) => {
    const params = request.params as { auctionId: string };
    if (!ObjectId.isValid(params.auctionId)) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid auction id." });
    }
    const auction = await auctionRepository.getAuctionById(new ObjectId(params.auctionId));
    if (!auction) {
      return reply.code(404).send({ error: "not_found", message: "Auction not found." });
    }
    return {
      _id: auction._id.toHexString(),
      title: auction.title,
      description: auction.description,
      status: auction.status,
      currency: auction.currency,
      startsAt: auction.startsAt,
      endsAt: auction.endsAt,
      rounds: auction.rounds
    };
  });

  app.get("/api/auctions/:auctionId/snapshot", async (request, reply) => {
    const params = request.params as { auctionId: string };
    if (!ObjectId.isValid(params.auctionId)) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid auction id." });
    }
    const auctionId = params.auctionId;
    const snapshotKey = `auction:${auctionId}:snapshot`;
    const snapshot = await deps.redis.hgetall(snapshotKey);

    if (Object.keys(snapshot).length === 0) {
      const auction = await auctionRepository.getAuctionById(new ObjectId(auctionId));
      if (!auction) {
        return reply.code(404).send({ error: "not_found", message: "Auction not found." });
      }
      const now = new Date();
      if (
        auction.currentRoundIndex !== undefined &&
        auction.roundStatus !== undefined &&
        auction.roundEffectiveEndAt !== undefined
      ) {
        return {
          auctionId,
          status: auction.status,
          title: auction.title,
          currency: auction.currency,
          currentRoundIndex: auction.currentRoundIndex,
          roundStatus: auction.roundStatus,
          roundEffectiveEndAt: auction.roundEffectiveEndAt?.toISOString() ?? null,
          roundLastBidAt: auction.roundLastBidAt?.toISOString() ?? null,
          lastBidAmount: auction.lastBidAmount ?? null,
          updatedAt: auction.updatedAt?.toISOString() ?? null,
          serverTime: now.toISOString()
        };
      }

      const roundState = await auctionRepository.getLiveRoundState(new ObjectId(auctionId));
      if (roundState) {
        await auctionRepository.updateAuctionSnapshot(
          auction._id,
          {
            currentRoundIndex: roundState.roundIndex,
            roundStatus: roundState.status,
            roundEffectiveEndAt: roundState.effectiveEndAt,
            roundLastBidAt: roundState.lastBidAt ?? null,
            lastBidAmount: null
          },
          now
        );
      }
      return {
        auctionId,
        status: auction.status,
        title: auction.title,
        currency: auction.currency,
        currentRoundIndex: roundState?.roundIndex ?? null,
        roundStatus: roundState?.status ?? null,
        roundEffectiveEndAt: roundState?.effectiveEndAt?.toISOString() ?? null,
        roundLastBidAt: roundState?.lastBidAt?.toISOString() ?? null,
        lastBidAmount: null,
        updatedAt: roundState?.updatedAt?.toISOString() ?? null,
        serverTime: now.toISOString()
      };
    }

    return {
      auctionId: snapshot.auctionId ?? auctionId,
      status: snapshot.status ?? null,
      title: snapshot.title ?? null,
      currency: snapshot.currency ?? null,
      currentRoundIndex: parseNumber(snapshot.currentRoundIndex),
      roundStatus: snapshot.roundStatus ?? null,
      roundEffectiveEndAt: snapshot.roundEffectiveEndAt ?? null,
      roundLastBidAt: snapshot.roundLastBidAt ?? null,
      lastBidAmount: parseNumber(snapshot.lastBidAmount),
      updatedAt: snapshot.updatedAt ?? null,
      serverTime: new Date().toISOString()
    };
  });

  app.get("/api/auctions/:auctionId/bids", async (request, reply) => {
    const params = request.params as { auctionId: string };
    const query = request.query as { limit?: string };
    if (!ObjectId.isValid(params.auctionId)) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid auction id." });
    }
    const limit = normalizeLimit(query.limit);
    const auctionId = params.auctionId;
    const rankingKey = `auction:${auctionId}:ranking`;
    const members = await deps.redis.zrevrange(rankingKey, 0, limit - 1);
    let orderedBidIds = members
      .map((member) => parseRankingMember(member).bidId)
      .filter((bidId) => bidId.length > 0);

    let bidDocs: Array<WithId<BidDocument>> = [];
    if (orderedBidIds.length > 0) {
      const objectIds = orderedBidIds
        .filter((id) => ObjectId.isValid(id))
        .map((id) => new ObjectId(id));
      if (objectIds.length > 0) {
        bidDocs = await bids.find({ _id: { $in: objectIds } }).toArray();
      }
    }

    if (bidDocs.length === 0) {
      bidDocs = await bids
        .find({ auctionId: new ObjectId(auctionId), active: true })
        .sort({ amount: -1, createdAt: 1, _id: 1 })
        .limit(limit)
        .toArray();
      orderedBidIds = bidDocs.map((bid) => bid._id.toHexString());
    }

    const byId = new Map(bidDocs.map((bid) => [bid._id.toHexString(), bid]));
    return orderedBidIds
      .map((id) => byId.get(id))
      .filter((bid): bid is WithId<BidDocument> => Boolean(bid))
      .map((bid) => ({
        _id: bid._id.toHexString(),
        userId: bid.userId,
        amount: bid.amount,
        createdAt: bid.createdAt
      }));
  });

  app.post(
    "/api/auctions/:auctionId/bids",
    { schema: { body: bidPlacementSchema } },
    async (request, reply) => {
      const params = request.params as { auctionId: string };
      if (!ObjectId.isValid(params.auctionId)) {
        return reply.code(400).send({ error: "invalid_request", message: "Invalid auction id." });
      }

      const body = request.body as BidPlacementBody;

      const userId = resolveUserId(request, body.userId);
      if (!userId) {
        return reply.code(400).send({ error: "invalid_request", message: "User id required." });
      }

      const userAgentHeader = request.headers["user-agent"];
      const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader;
      const audit = {
        source: "web",
        ip: request.ip,
        userAgent:
          typeof userAgent === "string" && userAgent.trim().length > 0 ? userAgent : undefined
      };

      try {
        const result = await bidService.placeBid({
          auctionId: new ObjectId(params.auctionId),
          userId,
          amount: body.amount,
          idempotencyKey: body.idempotencyKey ?? randomUUID(),
          audit,
          ip: request.ip
        });

        return reply.send({
          bid: {
            _id: result.bid._id.toHexString(),
            auctionId: result.bid.auctionId.toHexString(),
            roundIndex: result.bid.roundIndex ?? null,
            userId: result.bid.userId,
            amount: result.bid.amount,
            createdAt: result.bid.createdAt,
            idempotencyKey: result.bid.idempotencyKey,
            active: result.bid.active
          },
          balance: result.balance,
          roundState: {
            status: result.roundState.status,
            roundIndex: result.roundState.roundIndex,
            scheduledStartAt: result.roundState.scheduledStartAt,
            scheduledEndAt: result.roundState.scheduledEndAt,
            effectiveEndAt: result.roundState.effectiveEndAt,
            extensionCount: result.roundState.extensionCount,
            lastBidAt: result.roundState.lastBidAt ?? null
          },
          extended: result.extended,
          idempotent: result.idempotent
        });
      } catch (error) {
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
    }
  );

  app.get("/api/balance", async (request, reply) => {
    const query = request.query as { userId?: string; currency?: string };
    const userId = resolveUserId(request, query.userId ?? null);
    if (!userId) {
      return reply.code(400).send({ error: "invalid_request", message: "User id required." });
    }
    const currency = query.currency || "USDT";
    const balance = await ledgerRepository.getBalance(userId, currency);
    return balance;
  });

  app.get("/api/balance/:userId", async (request) => {
    const params = request.params as { userId: string };
    const query = request.query as { currency?: string };
    const currency = query.currency || "USDT";
    const balance = await ledgerRepository.getBalance(params.userId, currency);
    return balance;
  });
}

function resolveUserId(request: FastifyRequest, fallback?: string | null): string | null {
  const headerValue = request.headers["x-telegram-user-id"] ?? request.headers["x-user-id"];
  const header = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof header === "string" && header.trim().length > 0) {
    return header.trim();
  }
  if (fallback && fallback.trim().length > 0) {
    return fallback.trim();
  }
  return null;
}

function parseNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeLimit(value: string | undefined): number {
  if (!value) {
    return 20;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 20;
  }
  return Math.min(50, Math.max(1, Math.floor(parsed)));
}

async function loadHtml(filename: string): Promise<string> {
  try {
    const filePath = join(__dirname, "static", filename);
    return await readFile(filePath, "utf-8");
  } catch {
    return getDefaultHtml();
  }
}

function getDefaultHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Gift Auctions</title>
  <style>
    :root {
      color-scheme: light;
      --tg-bg: var(--tg-theme-bg-color, #f4f6fb);
      --tg-text: var(--tg-theme-text-color, #162031);
      --tg-hint: var(--tg-theme-hint-color, #6b7a90);
      --tg-accent: var(--tg-theme-button-color, #2aabee);
      --tg-accent-text: var(--tg-theme-button-text-color, #ffffff);
      --tg-card: var(--tg-theme-secondary-bg-color, #ffffff);
      --tg-section: var(--tg-theme-section-bg-color, #ffffff);
      --tg-divider: var(--tg-theme-section-separator-color, #e3e7ee);
      --tg-header: var(--tg-theme-header-bg-color, #f6f7fa);
      --radius: 14px;
      --shadow: 0 18px 60px rgba(15, 23, 42, 0.08);
      --shadow-soft: 0 10px 30px rgba(15, 23, 42, 0.06);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "Fira Sans", "Avenir Next", "Segoe UI", sans-serif;
      background: var(--tg-bg);
      color: var(--tg-text);
      min-height: 100vh;
      line-height: 1.4;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      background:
        radial-gradient(1200px 500px at 20% -10%, rgba(42, 171, 238, 0.15), transparent 55%),
        radial-gradient(800px 400px at 90% 10%, rgba(35, 83, 122, 0.12), transparent 60%),
        linear-gradient(180deg, rgba(255, 255, 255, 0.7), rgba(245, 248, 252, 0.9));
      z-index: -2;
    }
    body::after {
      content: "";
      position: fixed;
      inset: 0;
      background-image:
        linear-gradient(rgba(29, 45, 64, 0.04) 1px, transparent 1px),
        linear-gradient(90deg, rgba(29, 45, 64, 0.04) 1px, transparent 1px);
      background-size: 22px 22px;
      opacity: 0.4;
      z-index: -1;
    }
    .app {
      max-width: 1080px;
      margin: 0 auto;
      padding: 20px 16px 96px;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 18px;
      border-radius: calc(var(--radius) + 6px);
      background: var(--tg-header);
      box-shadow: var(--shadow-soft);
      border: 1px solid rgba(21, 32, 49, 0.06);
      position: sticky;
      top: 10px;
      z-index: 10;
      backdrop-filter: blur(6px);
    }
    .brand {
      display: flex;
      gap: 12px;
      align-items: center;
    }
    .brand-badge {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      background: linear-gradient(135deg, #2aabee, #1f7cc2);
      color: #fff;
      font-weight: 700;
      display: grid;
      place-items: center;
      letter-spacing: 0.05em;
      font-size: 0.95rem;
    }
    .brand-title {
      font-size: 1.05rem;
      font-weight: 600;
    }
    .brand-subtitle {
      font-size: 0.82rem;
      color: var(--tg-hint);
    }
    .live-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-radius: 999px;
      background: rgba(42, 171, 238, 0.12);
      color: #1f7cc2;
      font-size: 0.8rem;
      font-weight: 600;
    }
    .live-pill .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #1f7cc2;
      animation: pulse 1.6s ease-in-out infinite;
    }
    .content {
      margin-top: 20px;
    }
    .screen {
      display: none;
      animation: rise 0.4s ease both;
    }
    .screen.active {
      display: block;
    }
    .grid {
      display: grid;
      gap: 16px;
    }
    .card {
      background: var(--tg-card);
      border-radius: var(--radius);
      border: 1px solid var(--tg-divider);
      box-shadow: var(--shadow-soft);
      padding: 16px;
    }
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-weight: 600;
      font-size: 0.95rem;
      margin-bottom: 12px;
    }
    .card-header span {
      display: inline-flex;
      gap: 8px;
      align-items: center;
    }
    .chip {
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 0.72rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      background: rgba(21, 32, 49, 0.08);
      color: var(--tg-text);
    }
    .chip.subtle {
      background: rgba(42, 171, 238, 0.1);
      color: #1f7cc2;
    }
    .user-row {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .avatar {
      width: 54px;
      height: 54px;
      border-radius: 16px;
      background: linear-gradient(140deg, rgba(42, 171, 238, 0.2), rgba(31, 124, 194, 0.08));
      border: 1px solid rgba(42, 171, 238, 0.25);
      display: grid;
      place-items: center;
      font-weight: 700;
      color: #1f7cc2;
    }
    .user-info {
      flex: 1;
    }
    .user-name {
      font-weight: 600;
      font-size: 1rem;
    }
    .user-id {
      font-size: 0.82rem;
      color: var(--tg-hint);
      margin-top: 2px;
    }
    .user-actions {
      display: grid;
      gap: 10px;
      margin-top: 14px;
    }
    .input {
      width: 100%;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid var(--tg-divider);
      background: rgba(255, 255, 255, 0.7);
      color: var(--tg-text);
      font-size: 0.9rem;
    }
    .input:focus {
      outline: 2px solid rgba(42, 171, 238, 0.25);
      border-color: rgba(42, 171, 238, 0.5);
    }
    .btn {
      border: none;
      padding: 10px 14px;
      border-radius: 12px;
      font-weight: 600;
      font-size: 0.86rem;
      cursor: pointer;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .btn.primary {
      background: var(--tg-accent);
      color: var(--tg-accent-text);
      box-shadow: 0 12px 26px rgba(42, 171, 238, 0.2);
    }
    .btn.ghost {
      background: rgba(21, 32, 49, 0.06);
      color: var(--tg-text);
    }
    .btn:active {
      transform: translateY(1px);
    }
    .balance-grid {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    }
    .balance-item {
      padding: 12px;
      border-radius: 12px;
      background: rgba(42, 171, 238, 0.08);
    }
    .balance-item .label {
      font-size: 0.72rem;
      color: var(--tg-hint);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .balance-item .value {
      margin-top: 6px;
      font-size: 1rem;
      font-weight: 600;
    }
    .auction-list {
      display: grid;
      gap: 12px;
    }
    .auction-card {
      border-radius: 14px;
      border: 1px solid rgba(21, 32, 49, 0.08);
      padding: 14px;
      background: linear-gradient(135deg, rgba(42, 171, 238, 0.08), rgba(255, 255, 255, 0.8));
      cursor: pointer;
      display: grid;
      gap: 8px;
      animation: rise 0.4s ease both;
      animation-delay: var(--delay, 0ms);
    }
    .auction-card:hover {
      box-shadow: var(--shadow);
      transform: translateY(-2px);
    }
    .auction-title {
      font-weight: 600;
      font-size: 1rem;
    }
    .auction-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      font-size: 0.8rem;
      color: var(--tg-hint);
    }
    .auction-status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 0.72rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .auction-status.live {
      background: rgba(42, 171, 238, 0.16);
      color: #1f7cc2;
    }
    .auction-status.draft {
      background: rgba(107, 122, 144, 0.12);
      color: #6b7a90;
    }
    .auction-status.closed {
      background: rgba(231, 76, 60, 0.12);
      color: #c0392b;
    }
    .form-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    }
    label {
      display: grid;
      gap: 6px;
      font-size: 0.78rem;
      color: var(--tg-hint);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .form-actions {
      margin-top: 12px;
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
    }
    .form-note {
      font-size: 0.8rem;
      color: var(--tg-hint);
    }
    .detail-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .detail-title {
      font-size: 1.4rem;
      font-weight: 600;
    }
    .detail-desc {
      color: var(--tg-hint);
      margin-top: 6px;
      font-size: 0.9rem;
    }
    .metrics-grid {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      margin-top: 16px;
    }
    .metric {
      padding: 12px;
      border-radius: 12px;
      background: rgba(21, 32, 49, 0.04);
    }
    .metric .label {
      font-size: 0.72rem;
      color: var(--tg-hint);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .metric .value {
      margin-top: 6px;
      font-weight: 600;
    }
    .bid-form {
      display: grid;
      gap: 10px;
      grid-template-columns: 1fr auto;
      align-items: center;
    }
    .hint {
      margin-top: 10px;
      font-size: 0.82rem;
      color: var(--tg-hint);
    }
    .bids-list {
      display: grid;
      gap: 8px;
    }
    .bid-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 12px;
      border-radius: 12px;
      background: rgba(42, 171, 238, 0.08);
    }
    .bid-row .rank {
      font-weight: 600;
      color: #1f7cc2;
      margin-right: 8px;
    }
    .bid-row .meta {
      font-size: 0.8rem;
      color: var(--tg-hint);
    }
    .bottom-nav {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      display: flex;
      justify-content: center;
      gap: 12px;
      padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
      background: rgba(244, 247, 251, 0.95);
      border-top: 1px solid rgba(21, 32, 49, 0.08);
      backdrop-filter: blur(8px);
    }
    .nav-btn {
      border: none;
      background: rgba(42, 171, 238, 0.12);
      color: #1f7cc2;
      padding: 8px 16px;
      border-radius: 999px;
      font-size: 0.78rem;
      font-weight: 600;
    }
    .nav-btn.active {
      background: #1f7cc2;
      color: #fff;
    }
    .loading {
      color: var(--tg-hint);
      font-size: 0.9rem;
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: 0.6; }
      50% { transform: scale(1.4); opacity: 1; }
    }
    @keyframes rise {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @media (min-width: 900px) {
      .grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        align-items: start;
      }
      .auctions-card {
        grid-column: span 2;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      * {
        animation: none !important;
        transition: none !important;
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <div class="brand-badge">GA</div>
        <div>
          <div class="brand-title">Gift Auctions</div>
          <div class="brand-subtitle">Active bids carry over each round</div>
        </div>
      </div>
      <div class="live-pill"><span class="dot"></span>Live</div>
    </header>

    <main class="content">
      <section id="screen-list" class="screen active">
        <div class="grid">
          <div class="card user-card" style="--delay: 60ms;">
            <div class="card-header">
              <span>Profile</span>
              <span class="chip subtle" id="userStatus">Demo</span>
            </div>
            <div class="user-row">
              <div class="avatar" id="userAvatar">TG</div>
              <div class="user-info">
                <div class="user-name" id="userName">Guest</div>
                <div class="user-id" id="userId">Connect via Telegram or set demo user</div>
              </div>
            </div>
            <div class="user-actions" id="manualUserPanel">
              <input class="input" id="manualUserInput" placeholder="User ID for demo" />
              <button class="btn primary" id="manualUserBtn">Set user</button>
            </div>
          </div>

          <div class="card wallet-card" id="walletCard" style="--delay: 120ms;">
            <div class="card-header">
              <span>Wallet</span>
              <span class="chip" id="walletCurrency">USDT</span>
            </div>
            <div class="balance-grid">
              <div class="balance-item">
                <div class="label">Available</div>
                <div class="value" id="balanceAvailable">--</div>
              </div>
              <div class="balance-item">
                <div class="label">Held</div>
                <div class="value" id="balanceHeld">--</div>
              </div>
              <div class="balance-item">
                <div class="label">Spent</div>
                <div class="value" id="balanceSpent">--</div>
              </div>
              <div class="balance-item">
                <div class="label">Total</div>
                <div class="value" id="balanceCurrent">--</div>
              </div>
            </div>
            <div class="form-actions">
              <button class="btn ghost" id="refreshBalance">Refresh balance</button>
              <span class="form-note" id="balanceNote"></span>
            </div>
          </div>

          <div class="card auctions-card" style="--delay: 180ms;">
            <div class="card-header">
              <span>Auctions</span>
              <button class="btn ghost" id="refreshAuctions">Refresh</button>
            </div>
            <div id="auctionList" class="auction-list">
              <div class="loading" id="auctionLoading">Loading auctions...</div>
            </div>
          </div>

          <div class="card create-card" id="createPanel" style="--delay: 240ms;">
            <div class="card-header">
              <span>Create auction</span>
              <span class="chip subtle">Operator</span>
            </div>
            <div class="form-grid">
              <label>
                Title
                <input class="input" id="createTitle" placeholder="Gift Drop 01" />
              </label>
              <label>
                Currency
                <input class="input" id="createCurrency" value="USDT" />
              </label>
              <label>
                Rounds
                <input class="input" id="createRounds" type="number" min="1" value="3" />
              </label>
              <label>
                Allocation
                <input class="input" id="createAllocation" type="number" min="1" value="5" />
              </label>
              <label>
                Round duration (sec)
                <input class="input" id="createDuration" type="number" min="30" value="300" />
              </label>
              <label>
                Start offset (sec)
                <input class="input" id="createStartOffset" type="number" min="0" value="0" />
              </label>
            </div>
            <div class="form-actions">
              <button class="btn primary" id="createAuctionBtn">Create auction</button>
              <span class="form-note" id="createStatus"></span>
            </div>
          </div>
        </div>
      </section>

      <section id="screen-detail" class="screen">
        <div class="detail-header">
          <button class="btn ghost" id="backBtn">Back</button>
          <span class="chip" id="detailStatus">Status</span>
        </div>
        <div class="detail-title" id="detailTitle">Auction</div>
        <div class="detail-desc" id="detailDesc">--</div>

        <div class="metrics-grid">
          <div class="metric">
            <div class="label">Round</div>
            <div class="value" id="detailRound">--</div>
          </div>
          <div class="metric">
            <div class="label">Ends in</div>
            <div class="value" id="detailEnds">--</div>
          </div>
          <div class="metric">
            <div class="label">Last bid</div>
            <div class="value" id="detailLastBid">--</div>
          </div>
          <div class="metric">
            <div class="label">Currency</div>
            <div class="value" id="detailCurrency">--</div>
          </div>
        </div>

        <div class="card bid-card" style="margin-top: 16px;">
          <div class="card-header">
            <span>Place bid</span>
            <span class="chip subtle" id="bidUserBadge">Guest</span>
          </div>
          <div class="bid-form">
            <input class="input" id="bidAmount" type="number" min="0" step="0.01" placeholder="Bid amount" />
            <button class="btn primary" id="bidSubmit">Bid</button>
          </div>
          <div class="hint" id="bidHint">Active bids carry over automatically to the next round.</div>
        </div>

        <div class="card bids-card" style="margin-top: 16px;">
          <div class="card-header">
            <span>Top bids</span>
            <span class="form-note" id="bidsUpdated">--</span>
          </div>
          <div class="bids-list" id="bidsList"></div>
        </div>
      </section>
    </main>

    <nav class="bottom-nav">
      <button class="nav-btn active" data-target="list">Auctions</button>
      <button class="nav-btn" data-target="create">Create</button>
      <button class="nav-btn" data-target="wallet">Wallet</button>
    </nav>
  </div>

  <script>
    const state = {
      auctions: [],
      currentAuction: null,
      currentUser: null,
      timers: {
        snapshot: null,
        bids: null,
        list: null
      }
    };

    const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

    const elements = {
      screenList: document.getElementById('screen-list'),
      screenDetail: document.getElementById('screen-detail'),
      auctionList: document.getElementById('auctionList'),
      auctionLoading: document.getElementById('auctionLoading'),
      refreshAuctions: document.getElementById('refreshAuctions'),
      detailTitle: document.getElementById('detailTitle'),
      detailDesc: document.getElementById('detailDesc'),
      detailStatus: document.getElementById('detailStatus'),
      detailRound: document.getElementById('detailRound'),
      detailEnds: document.getElementById('detailEnds'),
      detailLastBid: document.getElementById('detailLastBid'),
      detailCurrency: document.getElementById('detailCurrency'),
      bidsList: document.getElementById('bidsList'),
      bidsUpdated: document.getElementById('bidsUpdated'),
      bidAmount: document.getElementById('bidAmount'),
      bidSubmit: document.getElementById('bidSubmit'),
      bidUserBadge: document.getElementById('bidUserBadge'),
      backBtn: document.getElementById('backBtn'),
      userName: document.getElementById('userName'),
      userId: document.getElementById('userId'),
      userAvatar: document.getElementById('userAvatar'),
      userStatus: document.getElementById('userStatus'),
      manualUserPanel: document.getElementById('manualUserPanel'),
      manualUserInput: document.getElementById('manualUserInput'),
      manualUserBtn: document.getElementById('manualUserBtn'),
      balanceAvailable: document.getElementById('balanceAvailable'),
      balanceHeld: document.getElementById('balanceHeld'),
      balanceSpent: document.getElementById('balanceSpent'),
      balanceCurrent: document.getElementById('balanceCurrent'),
      balanceNote: document.getElementById('balanceNote'),
      refreshBalance: document.getElementById('refreshBalance'),
      walletCurrency: document.getElementById('walletCurrency'),
      createTitle: document.getElementById('createTitle'),
      createCurrency: document.getElementById('createCurrency'),
      createRounds: document.getElementById('createRounds'),
      createAllocation: document.getElementById('createAllocation'),
      createDuration: document.getElementById('createDuration'),
      createStartOffset: document.getElementById('createStartOffset'),
      createAuctionBtn: document.getElementById('createAuctionBtn'),
      createStatus: document.getElementById('createStatus')
    };

    function applyThemeParams(params) {
      if (!params || typeof params !== 'object') return;
      Object.entries(params).forEach(([key, value]) => {
        if (typeof value === 'string') {
          const cssKey = '--tg-theme-' + key.replace(/_/g, '-');
          document.documentElement.style.setProperty(cssKey, value);
        }
      });
    }

    function initTelegram() {
      if (!tg) return;
      try {
        tg.ready();
        tg.expand();
        applyThemeParams(tg.themeParams || (tg.initDataUnsafe && tg.initDataUnsafe.theme_params) || {});
        if (tg.onEvent) {
          tg.onEvent('theme_changed', () => {
            applyThemeParams(tg.themeParams || (tg.initDataUnsafe && tg.initDataUnsafe.theme_params) || {});
          });
        }
        const user = tg.initDataUnsafe && tg.initDataUnsafe.user;
        if (user) {
          setUser({
            id: String(user.id),
            name: [user.first_name, user.last_name].filter(Boolean).join(' ')
          });
        }
      } catch (error) {
        console.warn('Telegram init failed', error);
      }
    }

    function setUser(user) {
      state.currentUser = user;
      const initials = user.name ? user.name.slice(0, 2).toUpperCase() : 'TG';
      elements.userAvatar.textContent = initials;
      elements.userName.textContent = user.name || 'Telegram user';
      elements.userId.textContent = 'ID ' + user.id;
      elements.userStatus.textContent = tg ? 'Telegram' : 'Demo';
      elements.bidUserBadge.textContent = user.name || 'User ' + user.id;
      elements.manualUserPanel.style.display = tg ? 'none' : 'grid';
      localStorage.setItem('demoUserId', user.id);
      loadBalance();
    }

    function resolveUserId() {
      return state.currentUser ? state.currentUser.id : null;
    }

    function apiFetch(url, options = {}) {
      const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
      const userId = resolveUserId();
      if (userId) {
        headers['x-telegram-user-id'] = userId;
      }
      return fetch(url, Object.assign({}, options, { headers }));
    }

    function startListTimer() {
      if (state.timers.list) return;
      state.timers.list = setInterval(loadAuctions, 12000);
    }

    function showScreen(name) {
      elements.screenList.classList.toggle('active', name === 'list');
      elements.screenDetail.classList.toggle('active', name === 'detail');
      document.querySelectorAll('.nav-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.target === name);
      });
      if (name === 'list') {
        startListTimer();
      }
    }

    function renderAuctions(auctions) {
      if (!auctions.length) {
        elements.auctionList.innerHTML = '<div class="loading">No auctions yet</div>';
        return;
      }
      elements.auctionList.innerHTML = auctions.map((auction, index) => {
        const status = auction.status || 'draft';
        const statusClass = status === 'live' ? 'live' : status === 'closed' ? 'closed' : 'draft';
        const rounds = auction.rounds ? auction.rounds.length : 0;
        const startsAt = auction.startsAt ? new Date(auction.startsAt).toLocaleString() : '--';
        const endsAt = auction.endsAt ? new Date(auction.endsAt).toLocaleString() : '--';
        return \`
          <div class="auction-card" data-id="\${auction._id}" style="--delay: \${index * 60}ms">
            <div class="auction-title">\${auction.title}</div>
            <div class="auction-status \${statusClass}">\${status}</div>
            <div class="auction-meta">
              <span>Currency: \${auction.currency}</span>
              <span>Rounds: \${rounds}</span>
              <span>Starts: \${startsAt}</span>
              <span>Ends: \${endsAt}</span>
            </div>
          </div>
        \`;
      }).join('');

      elements.auctionList.querySelectorAll('.auction-card').forEach((card) => {
        card.addEventListener('click', () => {
          const id = card.dataset.id;
          if (id) {
            openAuction(id);
          }
        });
      });
    }

    async function loadAuctions() {
      elements.auctionLoading.style.display = 'block';
      try {
        const response = await apiFetch('/api/auctions');
        const data = await response.json();
        state.auctions = Array.isArray(data) ? data : [];
        renderAuctions(state.auctions);
      } catch (error) {
        elements.auctionList.innerHTML = '<div class="loading">Failed to load auctions</div>';
      } finally {
        elements.auctionLoading.style.display = 'none';
      }
    }

    async function openAuction(auctionId) {
      clearTimers();
      showScreen('detail');
      try {
        const response = await apiFetch('/api/auctions/' + auctionId);
        const auction = await response.json();
        state.currentAuction = auction;
        elements.detailTitle.textContent = auction.title || 'Auction';
        elements.detailDesc.textContent = auction.description || 'No description provided.';
        elements.detailStatus.textContent = auction.status || 'draft';
        elements.detailCurrency.textContent = auction.currency || '--';
        updateStatusChip(elements.detailStatus, auction.status);
      } catch (error) {
        elements.detailTitle.textContent = 'Auction not available';
        return;
      }
      await refreshSnapshot();
      await loadBids();
      state.timers.snapshot = setInterval(refreshSnapshot, 4000);
      state.timers.bids = setInterval(loadBids, 4500);
    }

    function updateStatusChip(element, status) {
      element.className = 'chip';
      if (status === 'live') element.classList.add('subtle');
    }

    async function refreshSnapshot() {
      if (!state.currentAuction) return;
      try {
        const response = await apiFetch('/api/auctions/' + state.currentAuction._id + '/snapshot');
        const snapshot = await response.json();
        const roundIndex = snapshot.currentRoundIndex !== null ? snapshot.currentRoundIndex + 1 : '--';
        elements.detailRound.textContent = roundIndex;
        elements.detailLastBid.textContent = snapshot.lastBidAmount
          ? snapshot.lastBidAmount + ' ' + (snapshot.currency || '')
          : '--';
        const endsIn = formatCountdown(snapshot.roundEffectiveEndAt, snapshot.serverTime);
        elements.detailEnds.textContent = endsIn;
      } catch (error) {
        elements.detailEnds.textContent = '--';
      }
    }

    async function loadBids() {
      if (!state.currentAuction) return;
      try {
        const response = await apiFetch('/api/auctions/' + state.currentAuction._id + '/bids?limit=15');
        const data = await response.json();
        const bids = Array.isArray(data) ? data : [];
        renderBids(bids);
      } catch (error) {
        elements.bidsList.innerHTML = '<div class="loading">No bids yet</div>';
      }
    }

    function renderBids(bids) {
      if (!bids.length) {
        elements.bidsList.innerHTML = '<div class="loading">No bids yet</div>';
        return;
      }
      elements.bidsList.innerHTML = bids.map((bid, index) => {
        const shortUser = bid.userId ? bid.userId.slice(0, 8) : '--';
        const time = bid.createdAt ? new Date(bid.createdAt).toLocaleTimeString() : '--';
        return \`
          <div class="bid-row">
            <div>
              <span class="rank">#\${index + 1}</span>
              <span>\${shortUser}</span>
            </div>
            <div class="meta">\${bid.amount} · \${time}</div>
          </div>
        \`;
      }).join('');
      elements.bidsUpdated.textContent = 'Updated ' + new Date().toLocaleTimeString();
    }

    async function placeBid() {
      if (!state.currentAuction) return;
      const amount = Number(elements.bidAmount.value);
      if (!amount || amount <= 0) {
        elements.bidAmount.focus();
        return;
      }
      try {
        const response = await apiFetch('/api/auctions/' + state.currentAuction._id + '/bids', {
          method: 'POST',
          body: JSON.stringify({ amount })
        });
        const data = await response.json();
        if (!response.ok) {
          alert(data.message || 'Bid failed');
          return;
        }
        elements.bidAmount.value = '';
        await loadBids();
        await refreshSnapshot();
        await loadBalance();
      } catch (error) {
        alert('Bid failed');
      }
    }

    async function loadBalance() {
      const userId = resolveUserId();
      if (!userId) {
        elements.balanceNote.textContent = 'Set a user id to view balance.';
        return;
      }
      try {
        const response = await apiFetch('/api/balance?currency=' + (state.currentAuction?.currency || 'USDT'));
        const balance = await response.json();
        elements.balanceAvailable.textContent = formatNumber(balance.available);
        elements.balanceHeld.textContent = formatNumber(balance.held);
        elements.balanceSpent.textContent = formatNumber(balance.spent);
        elements.balanceCurrent.textContent = formatNumber(balance.current);
        elements.walletCurrency.textContent = balance.currency || 'USDT';
        elements.balanceNote.textContent = 'Updated ' + new Date().toLocaleTimeString();
      } catch (error) {
        elements.balanceNote.textContent = 'Balance unavailable';
      }
    }

    async function createAuction() {
      const payload = {
        title: elements.createTitle.value || 'New auction',
        currency: elements.createCurrency.value || 'USDT',
        rounds: Number(elements.createRounds.value || 3),
        allocationSize: Number(elements.createAllocation.value || 5),
        roundDurationSeconds: Number(elements.createDuration.value || 300),
        startOffsetSeconds: Number(elements.createStartOffset.value || 0)
      };
      elements.createStatus.textContent = 'Creating...';
      try {
        const response = await apiFetch('/api/auctions', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok) {
          elements.createStatus.textContent = data.message || 'Failed to create auction';
          return;
        }
        elements.createStatus.textContent = 'Auction created: ' + data._id;
        await loadAuctions();
      } catch (error) {
        elements.createStatus.textContent = 'Failed to create auction';
      }
    }

    function formatNumber(value) {
      if (typeof value !== 'number') return '--';
      return value.toFixed(2);
    }

    function formatCountdown(endAt, serverTime) {
      if (!endAt) return '--';
      const end = new Date(endAt).getTime();
      const now = serverTime ? new Date(serverTime).getTime() : Date.now();
      const diff = Math.max(0, end - now);
      const minutes = Math.floor(diff / 60000);
      const seconds = Math.floor((diff % 60000) / 1000);
      return minutes + 'm ' + String(seconds).padStart(2, '0') + 's';
    }

    function clearTimers() {
      Object.values(state.timers).forEach((timer) => {
        if (timer) clearInterval(timer);
      });
      state.timers.snapshot = null;
      state.timers.bids = null;
      state.timers.list = null;
    }

    elements.refreshAuctions.addEventListener('click', loadAuctions);
    elements.bidSubmit.addEventListener('click', placeBid);
    elements.backBtn.addEventListener('click', () => {
      clearTimers();
      showScreen('list');
      loadAuctions();
    });
    elements.manualUserBtn.addEventListener('click', () => {
      const value = elements.manualUserInput.value.trim();
      if (!value) return;
      setUser({ id: value, name: 'Demo user' });
      elements.manualUserInput.value = '';
    });
    elements.refreshBalance.addEventListener('click', loadBalance);
    elements.createAuctionBtn.addEventListener('click', createAuction);

    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.target;
        if (target === 'list') {
          clearTimers();
          showScreen('list');
          loadAuctions();
          return;
        }
        if (target === 'wallet') {
          clearTimers();
          showScreen('list');
          document.getElementById('walletCard').scrollIntoView({ behavior: 'smooth' });
          return;
        }
        if (target === 'create') {
          clearTimers();
          showScreen('list');
          document.getElementById('createPanel').scrollIntoView({ behavior: 'smooth' });
        }
      });
    });

    const storedUserId = localStorage.getItem('demoUserId');
    if (storedUserId && !tg) {
      setUser({ id: storedUserId, name: 'Demo user' });
    }

    initTelegram();
    loadAuctions();
    startListTimer();
  </script>
</body>
</html>`;
}
