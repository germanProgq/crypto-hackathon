// Web UI routes and static file serving.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import { createPublicKey, randomUUID, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ObjectId, type Collection, type WithId } from "mongodb";
import type { Locale } from "../../shared/config.js";
import { resolveLocale, type Catalog } from "../../shared/i18n/index.js";
import enCatalog from "../../shared/i18n/en.js";
import ruCatalog from "../../shared/i18n/ru.js";
import type { ServiceDependencies } from "../../shared/service.js";
import { canonicalize } from "../../shared/crypto/canonicalize.js";
import { buildMerkleRootFromPayloads } from "../../shared/crypto/merkle.js";
import type { RoundProofPayload, SignedRoundProof } from "../../shared/auctionProof.js";
import { runMongoTransaction } from "../../shared/storage/mongoTransaction.js";
import {
  mongoCollections,
  type AuctionWatchlistDocument,
  type AuctionDocument,
  type AuctionRoundStateDocument,
  type AuctionRoundStatus,
  type AuctionStatus,
  type BidDocument,
  type DeliveryRecordDocument,
  type RoundResultDocument
} from "../../shared/storage/mongoSchemas.js";
import {
  invalidateActiveAuctionListCache,
  readAuctionSnapshotFromRedis,
  readActiveAuctionListFromRedis,
  writeActiveAuctionListToRedis
} from "../auction-engine/auctionCache.js";
import { parseAuctionConfig } from "../auction-engine/auctionConfig.js";
import { buildAuctionDocument } from "../auction-engine/auctionCreation.js";
import { parseRankingMember } from "../auction-engine/bidRanking.js";
import { BidError, createBidService } from "../auction-engine/bidService.js";
import { ensureAuctionRoundProgress } from "../auction-engine/auctionProgress.js";
import { createRoundFinalizationService } from "../auction-engine/roundFinalizationService.js";
import { createAuctionRepository } from "../auction-engine/auctionStore.js";
import { CryptoGatewayError, createCryptoGatewayService } from "../crypto-gateway/cryptoGatewayService.js";
import { createLedgerRepository, LedgerError } from "../ledger/ledgerStore.js";
import {
  publishRealtimeEvent,
  realtimeEventChannel,
  toRealtimeSnapshot,
  type RealtimeAuctionSnapshot,
  type RealtimeEvent
} from "../../shared/realtime/events.js";
import {
  extractTelegramInitData,
  type TelegramWebUser,
  verifyTelegramInitData
} from "../../shared/auth/telegram.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const webCatalogs: Record<Locale, Catalog> = {
  en: enCatalog,
  ru: ruCatalog
};

type CreateAuctionBody = {
  title: string;
  description?: string;
  currency?: string;
  deliveryType?: AuctionDocument["deliveryType"];
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
  amount: number;
  maxAmount?: number;
  idempotencyKey?: string;
};

type WithdrawalRequestBody = {
  amount: number;
  currency?: string;
  destinationAddress: string;
  memo?: string;
  idempotencyKey?: string;
};

type DemoDepositBody = {
  amount: number;
  currency?: string;
  idempotencyKey?: string;
};

const createAuctionSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
    description: { type: "string" },
    currency: { type: "string", minLength: 1 },
    pricingMode: { type: "string", enum: ["first-price", "cutoff"] },
    minBid: { type: "number", minimum: 0 },
    minIncrement: { type: "number", minimum: 0 },
    deliveryType: { type: "string", enum: ["access_code", "telegram_role", "nft_mint"] },
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
    amount: { type: "number", exclusiveMinimum: 0 },
    maxAmount: { type: "number", exclusiveMinimum: 0 },
    idempotencyKey: { type: "string", minLength: 1 }
  },
  required: ["amount"],
  additionalProperties: false
} as const;

const withdrawalRequestSchema = {
  type: "object",
  properties: {
    amount: { type: "number", exclusiveMinimum: 0 },
    currency: { type: "string", minLength: 1 },
    destinationAddress: { type: "string", minLength: 1 },
    memo: { type: "string" },
    idempotencyKey: { type: "string", minLength: 1 }
  },
  required: ["amount", "destinationAddress"],
  additionalProperties: false
} as const;

const demoDepositSchema = {
  type: "object",
  properties: {
    amount: { type: "number", exclusiveMinimum: 0 },
    currency: { type: "string", minLength: 1 },
    idempotencyKey: { type: "string", minLength: 1 }
  },
  required: ["amount"],
  additionalProperties: false
} as const;

const watchlistSchema = {
  type: "object",
  properties: {
    auctionId: { type: "string", pattern: "^[a-fA-F0-9]{24}$" },
    notifyOutbid: { type: "boolean" }
  },
  required: ["auctionId"],
  additionalProperties: false
} as const;

type AuthenticatedUser = TelegramWebUser & {
  source: "telegram" | "demo";
};

type AuthResolution =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; status: number; code: string; message: string };

type ActiveAuctionPayload = {
  _id: string;
  title: string;
  description?: string;
  status: AuctionStatus;
  currency: string;
  pricingMode: AuctionDocument["pricingMode"];
  minBid: number;
  minIncrement: number;
  deliveryType?: AuctionDocument["deliveryType"] | null;
  startsAt: Date;
  endsAt: Date;
  currentRoundIndex: number | null;
  roundStatus: AuctionRoundStatus | null;
  roundEffectiveEndAt: Date | null;
  roundLastBidAt: Date | null;
  lastBidAmount: number | null;
  rounds: Array<{
    index: number;
    allocationSize: number;
    startAt: Date;
    endAt: Date;
  }>;
};

type ActiveBidPayload = {
  id: string;
  auctionId: string;
  amount: number;
  maxAmount?: number | null;
  createdAt: Date;
  roundIndex: number | null;
  roundsCount: number | null;
  auctionTitle: string;
  auctionStatus: AuctionStatus;
  currency: string;
};

type ReplayBidPayload = {
  bidId: string;
  userId: string;
  amount: number;
  maxAmount: number | null;
  createdAt: string;
  origin: BidDocument["origin"] | null;
};

type ReplayPayload = {
  auction: {
    id: string;
    title: string;
    currency: string;
    deliveryType?: AuctionDocument["deliveryType"] | null;
  };
  round: {
    index: number;
    allocationSize: number;
    startAt: string;
    endAt: string;
    antiSniping: AuctionDocument["rounds"][number]["antiSniping"];
  };
  state: {
    effectiveEndAt: string | null;
    extensionCount: number | null;
    lastBidAt: string | null;
  };
  bids: ReplayBidPayload[];
  winners: RoundResultDocument["winners"] | null;
  proof: SignedRoundProof | null;
  merkleRoot: string | null;
  merkleCount: number | null;
};

type SocketMessage = string | Buffer | ArrayBuffer | Buffer[];

type RealtimeSocket = {
  on(event: "message", listener: (data: SocketMessage) => void): void;
  on(event: "close" | "error", listener: () => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

type RealtimeClient = {
  id: string;
  socket: RealtimeSocket;
  userId: string | null;
  auctionIds: Set<string>;
};

export async function registerWebRoutes(
  app: FastifyInstance,
  deps: ServiceDependencies
): Promise<void> {
  const auctionRepository = createAuctionRepository(deps.mongo);
  const ledgerRepository = createLedgerRepository(deps.mongo, {
    retentionDays: deps.config.dataRetention.ledgerDays,
    redis: deps.redis,
    logger: deps.logger
  });
  const cryptoGatewayService = createCryptoGatewayService(deps);
  const bidService = createBidService(deps);
  const roundFinalizationService = createRoundFinalizationService(deps);
  const bids = deps.mongo.db.collection<BidDocument>(mongoCollections.bids);
  const roundStates = deps.mongo.db.collection<AuctionRoundStateDocument>(
    mongoCollections.auctionRoundStates
  );
  const roundResults = deps.mongo.db.collection<RoundResultDocument>(mongoCollections.roundResults);
  const watchlist = deps.mongo.db.collection<AuctionWatchlistDocument>(
    mongoCollections.auctionWatchlist
  );
  const deliveryRecords = deps.mongo.db.collection<DeliveryRecordDocument>(
    mongoCollections.deliveryRecords
  );

  const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

  await app.register(websocket);

  const realtimeClients = new Map<string, RealtimeClient>();
  const userSubscriptions = new Map<string, Set<string>>();
  const auctionSubscriptions = new Map<string, Set<string>>();
  const pendingAuctionBids = new Map<string, NodeJS.Timeout>();
  const pendingActiveBids = new Map<string, NodeJS.Timeout>();
  const pendingBalanceUpdates = new Map<string, NodeJS.Timeout>();
  let pendingAuctionsTimer: NodeJS.Timeout | null = null;
  const auctionsResyncIntervalMs = 15000;
  const snapshotResyncIntervalMs = 5000;
  const bidsResyncIntervalMs = 8000;
  const activeBidsResyncIntervalMs = 20000;
  let auctionsResyncTimer: NodeJS.Timeout | null = null;
  let snapshotResyncTimer: NodeJS.Timeout | null = null;
  let bidsResyncTimer: NodeJS.Timeout | null = null;
  let activeBidsResyncTimer: NodeJS.Timeout | null = null;
  let snapshotResyncInFlight = false;
  let bidsResyncInFlight = false;
  let activeBidsResyncInFlight = false;
  const allowFinalizationFallback = deps.config.env !== "production";
  const finalizationFallbackThrottle = new Map<string, number>();
  const finalizationFallbackThrottleMs = 4000;

  function shouldRunFinalizationFallback(auth: AuthenticatedUser): boolean {
    return allowFinalizationFallback || auth.source === "demo";
  }

  async function maybeFinalizeUserAuctions(userId: string, scanLimit: number): Promise<void> {
    const nowMs = Date.now();
    const nextAllowed = finalizationFallbackThrottle.get(userId) ?? 0;
    if (nowMs < nextAllowed) {
      return;
    }
    finalizationFallbackThrottle.set(userId, nowMs + finalizationFallbackThrottleMs);

    const limit = Number.isFinite(scanLimit)
      ? Math.max(1, Math.min(100, Math.floor(scanLimit)))
      : 25;
    const candidates = await bids
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .project<Pick<BidDocument, "auctionId">>({ auctionId: 1 })
      .toArray();
    if (candidates.length === 0) {
      return;
    }

    const auctionIdTexts = new Set(
      candidates
        .map((bid) => bid.auctionId?.toHexString())
        .filter((value): value is string => typeof value === "string" && value.length > 0)
    );
    if (auctionIdTexts.size === 0) {
      return;
    }
    const auctionIds = Array.from(auctionIdTexts).map((value) => new ObjectId(value));

    for (const auctionId of auctionIds) {
      try {
        await ensureAuctionRoundProgress(deps, auctionRepository, auctionId);
      } catch (error) {
        deps.logger.warn(
          { err: error, auctionId: auctionId.toHexString() },
          "Failed to sync auction rounds for demo finalization"
        );
      }
    }

    const pendingRounds = await roundStates
      .find({
        auctionId: { $in: auctionIds },
        status: "closed",
        settlementCompletedAt: { $exists: false }
      })
      .sort({ closedAt: 1, effectiveEndAt: 1 })
      .limit(20)
      .toArray();

    for (const roundState of pendingRounds) {
      try {
        await roundFinalizationService.finalizeRound(
          roundState.auctionId,
          roundState.roundIndex
        );
      } catch (error) {
        deps.logger.warn(
          {
            err: error,
            auctionId: roundState.auctionId.toHexString(),
            roundIndex: roundState.roundIndex
          },
          "Failed to finalize round in demo fallback"
        );
      }
    }
  }

  let realtimeSubscriber: ReturnType<typeof deps.redis.duplicate> | null = null;
  try {
    realtimeSubscriber = deps.redis.duplicate();
    realtimeSubscriber.on("error", (error) => {
      deps.logger.warn({ err: error }, "Realtime Redis error");
    });
    await realtimeSubscriber.connect();
    await realtimeSubscriber.subscribe(realtimeEventChannel);
    realtimeSubscriber.on("message", (channel, payload) => {
      if (channel !== realtimeEventChannel) {
        return;
      }
      const event = parseRealtimeEvent(payload);
      if (!event) {
        return;
      }
      handleRealtimeEvent(event);
    });
  } catch (error) {
    deps.logger.warn(
      { err: error },
      "Realtime Redis subscription unavailable; falling back to polling"
    );
    if (realtimeSubscriber) {
      try {
        await realtimeSubscriber.quit();
      } catch {
        // ignore cleanup errors
      }
    }
    realtimeSubscriber = null;
  }

  startRealtimeResyncTimers();

  app.addHook("onClose", async () => {
    if (pendingAuctionsTimer) {
      clearTimeout(pendingAuctionsTimer);
      pendingAuctionsTimer = null;
    }
    if (auctionsResyncTimer) {
      clearInterval(auctionsResyncTimer);
      auctionsResyncTimer = null;
    }
    if (snapshotResyncTimer) {
      clearInterval(snapshotResyncTimer);
      snapshotResyncTimer = null;
    }
    if (bidsResyncTimer) {
      clearInterval(bidsResyncTimer);
      bidsResyncTimer = null;
    }
    if (activeBidsResyncTimer) {
      clearInterval(activeBidsResyncTimer);
      activeBidsResyncTimer = null;
    }
    for (const timer of pendingAuctionBids.values()) {
      clearTimeout(timer);
    }
    pendingAuctionBids.clear();
    for (const timer of pendingActiveBids.values()) {
      clearTimeout(timer);
    }
    pendingActiveBids.clear();
    for (const client of realtimeClients.values()) {
      try {
        client.socket.close();
      } catch {
        // ignore close errors
      }
    }
    realtimeClients.clear();
    userSubscriptions.clear();
    auctionSubscriptions.clear();
    if (realtimeSubscriber) {
      await realtimeSubscriber.quit();
    }
  });

  app.get("/ws", { websocket: true }, (connection, request) => {
    const socket = resolveRealtimeSocket(connection);
    if (!socket) {
      return;
    }
    const origin = getRequestOrigin(request);
    if (origin) {
      const allowed = resolveAllowedOrigins(request, deps);
      if (!isOriginAllowed(origin, allowed)) {
        socket.close(1008, "Origin not allowed");
        return;
      }
    }

    const client: RealtimeClient = {
      id: randomUUID(),
      socket,
      userId: null,
      auctionIds: new Set()
    };

    realtimeClients.set(client.id, client);
    void sendActiveAuctionsToClient(client);

    socket.on("message", (data: SocketMessage) => {
      handleRealtimeMessage(client, data);
    });
    socket.on("close", () => {
      cleanupRealtimeClient(client);
    });
    socket.on("error", () => {
      cleanupRealtimeClient(client);
    });
  });

  function resolveRealtimeSocket(connection: unknown): RealtimeSocket | null {
    if (isRealtimeSocket(connection)) {
      return connection;
    }
    if (connection && typeof connection === "object" && "socket" in connection) {
      const maybeSocket = (connection as { socket?: unknown }).socket;
      if (isRealtimeSocket(maybeSocket)) {
        return maybeSocket;
      }
    }
    return null;
  }

  function isRealtimeSocket(value: unknown): value is RealtimeSocket {
    if (!value || typeof value !== "object") {
      return false;
    }
    const socket = value as RealtimeSocket;
    return typeof socket.on === "function"
      && typeof socket.send === "function"
      && typeof socket.close === "function";
  }

  function handleRealtimeMessage(client: RealtimeClient, data: SocketMessage): void {
    const message = parseRealtimeMessage(data);
    if (!message || typeof message.type !== "string") {
      return;
    }
    if (message.type === "ping") {
      sendRealtimePayload(client, { type: "pong" });
      return;
    }
    if (message.type === "auth") {
      const resolved = resolveAuthFromRealtimePayload(message, deps);
      if (!resolved.ok) {
        sendRealtimePayload(client, {
          type: "auth",
          ok: false,
          code: resolved.code,
          message: resolved.message
        });
        return;
      }
      attachRealtimeUser(client, resolved.user.id);
      sendRealtimePayload(client, {
        type: "auth",
        ok: true,
        user: {
          id: resolved.user.id,
          displayName: resolved.user.displayName,
          username: resolved.user.username,
          firstName: resolved.user.firstName,
          lastName: resolved.user.lastName,
          languageCode: resolved.user.languageCode,
          source: resolved.user.source
        }
      });
      void sendActiveBidsToUser(resolved.user.id);
      return;
    }
    if (message.type === "subscribe") {
      const auctionIds = normalizeAuctionIds(message.auctionIds ?? message.auctionId);
      if (auctionIds.length === 0) {
        return;
      }
      for (const auctionId of auctionIds) {
        attachAuctionSubscription(client, auctionId);
      }
      return;
    }
    if (message.type === "unsubscribe") {
      const auctionIds = normalizeAuctionIds(message.auctionIds ?? message.auctionId);
      if (auctionIds.length === 0) {
        return;
      }
      for (const auctionId of auctionIds) {
        detachAuctionSubscription(client, auctionId);
      }
      return;
    }
  }

  function parseRealtimeMessage(data: SocketMessage): Record<string, unknown> | null {
    if (typeof data === "string") {
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    }
    if (data instanceof Buffer) {
      try {
        return JSON.parse(data.toString("utf-8"));
      } catch {
        return null;
      }
    }
    if (data instanceof ArrayBuffer) {
      try {
        return JSON.parse(Buffer.from(data).toString("utf-8"));
      } catch {
        return null;
      }
    }
    if (Array.isArray(data) && data.every(Buffer.isBuffer)) {
      try {
        return JSON.parse(Buffer.concat(data).toString("utf-8"));
      } catch {
        return null;
      }
    }
    return null;
  }

  function parseRealtimeEvent(payload: string): RealtimeEvent | null {
    try {
      const parsed = JSON.parse(payload);
      if (!parsed || typeof parsed.type !== "string") {
        return null;
      }
      return parsed as RealtimeEvent;
    } catch {
      return null;
    }
  }

  function handleRealtimeEvent(event: RealtimeEvent): void {
    if (event.type === "auction.list.updated") {
      scheduleAuctionsBroadcast();
      return;
    }
    if (event.type === "auction.snapshot.updated") {
      broadcastAuctionSnapshot(event.auctionId, event.snapshot);
      return;
    }
    if (event.type === "auction.bids.updated") {
      scheduleAuctionBidsBroadcast(event.auctionId);
      return;
    }
    if (event.type === "bids.active.updated") {
      for (const userId of event.userIds) {
        scheduleActiveBidsBroadcast(userId);
      }
      return;
    }
    if (event.type === "balance.updated") {
      for (const userId of event.userIds) {
        scheduleBalanceBroadcast(userId, event.currency);
      }
    }
  }

  function scheduleAuctionsBroadcast(): void {
    if (pendingAuctionsTimer) {
      return;
    }
    pendingAuctionsTimer = setTimeout(() => {
      pendingAuctionsTimer = null;
      void broadcastActiveAuctions();
    }, 150);
  }

  function scheduleAuctionBidsBroadcast(auctionId: string): void {
    if (pendingAuctionBids.has(auctionId)) {
      return;
    }
    const timer = setTimeout(() => {
      pendingAuctionBids.delete(auctionId);
      void broadcastAuctionBids(auctionId);
    }, 150);
    pendingAuctionBids.set(auctionId, timer);
  }

  function scheduleActiveBidsBroadcast(userId: string): void {
    if (pendingActiveBids.has(userId)) {
      return;
    }
    const timer = setTimeout(() => {
      pendingActiveBids.delete(userId);
      void sendActiveBidsToUser(userId);
    }, 150);
    pendingActiveBids.set(userId, timer);
  }

  function scheduleBalanceBroadcast(userId: string, currency?: string): void {
    if (pendingBalanceUpdates.has(userId)) {
      return;
    }
    const timer = setTimeout(() => {
      pendingBalanceUpdates.delete(userId);
      void sendBalanceUpdateToUser(userId, currency);
    }, 150);
    pendingBalanceUpdates.set(userId, timer);
  }

  async function sendActiveAuctionsToClient(client: RealtimeClient): Promise<void> {
    try {
      const auctions = await loadActiveAuctions(deps, auctionRepository);
      sendRealtimePayload(client, { type: "auctions", data: auctions });
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to push auctions to client");
    }
  }

  async function broadcastActiveAuctions(): Promise<void> {
    if (realtimeClients.size === 0) {
      return;
    }
    try {
      const auctions = await loadActiveAuctions(deps, auctionRepository);
      broadcastRealtimePayload({ type: "auctions", data: auctions });
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to broadcast auctions");
    }
  }

  async function sendActiveBidsToUser(userId: string): Promise<void> {
    const clientIds = userSubscriptions.get(userId);
    if (!clientIds || clientIds.size === 0) {
      return;
    }
    try {
      const bidsPayload = await loadActiveBidsForUser(deps, bids, userId, 20);
      sendRealtimePayloadToClients(clientIds, { type: "active_bids", data: bidsPayload });
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to broadcast active bids");
    }
  }

  async function sendBalanceUpdateToUser(userId: string, currency?: string): Promise<void> {
    const clientIds = userSubscriptions.get(userId);
    if (!clientIds || clientIds.size === 0) {
      return;
    }
    sendRealtimePayloadToClients(clientIds, {
      type: "balance_updated",
      currency: currency ?? null
    });
  }

  function broadcastAuctionSnapshot(
    auctionId: string,
    snapshot: RealtimeAuctionSnapshot
  ): void {
    const clientIds = auctionSubscriptions.get(auctionId);
    if (!clientIds || clientIds.size === 0) {
      return;
    }
    sendRealtimePayloadToClients(clientIds, { type: "auction_snapshot", data: snapshot });
  }

  async function broadcastAuctionSnapshotFromSource(auctionId: string): Promise<void> {
    try {
      const snapshot = await loadAuctionSnapshotPayload(deps, auctionRepository, auctionId);
      if (!snapshot) {
        return;
      }
      broadcastAuctionSnapshot(auctionId, snapshot);
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to resync auction snapshot");
    }
  }

  async function broadcastAuctionBids(auctionId: string): Promise<void> {
    const clientIds = auctionSubscriptions.get(auctionId);
    if (!clientIds || clientIds.size === 0) {
      return;
    }
    try {
      const bidsPayload = await loadAuctionBidsPayload(deps, bids, auctionId, 15);
      sendRealtimePayloadToClients(clientIds, {
        type: "auction_bids",
        auctionId,
        data: bidsPayload
      });
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to broadcast auction bids");
    }
  }

  async function resyncAuctionSnapshots(): Promise<void> {
    if (auctionSubscriptions.size === 0) {
      return;
    }
    for (const auctionId of auctionSubscriptions.keys()) {
      await broadcastAuctionSnapshotFromSource(auctionId);
    }
  }

  async function resyncAuctionBids(): Promise<void> {
    if (auctionSubscriptions.size === 0) {
      return;
    }
    for (const auctionId of auctionSubscriptions.keys()) {
      await broadcastAuctionBids(auctionId);
    }
  }

  async function resyncActiveBids(): Promise<void> {
    if (userSubscriptions.size === 0) {
      return;
    }
    for (const userId of userSubscriptions.keys()) {
      await sendActiveBidsToUser(userId);
    }
  }

  function startRealtimeResyncTimers(): void {
    if (!auctionsResyncTimer) {
      auctionsResyncTimer = setInterval(() => {
        void broadcastActiveAuctions();
      }, auctionsResyncIntervalMs);
    }

    if (!snapshotResyncTimer) {
      snapshotResyncTimer = setInterval(() => {
        if (snapshotResyncInFlight) {
          return;
        }
        snapshotResyncInFlight = true;
        void resyncAuctionSnapshots().finally(() => {
          snapshotResyncInFlight = false;
        });
      }, snapshotResyncIntervalMs);
    }

    if (!bidsResyncTimer) {
      bidsResyncTimer = setInterval(() => {
        if (bidsResyncInFlight) {
          return;
        }
        bidsResyncInFlight = true;
        void resyncAuctionBids().finally(() => {
          bidsResyncInFlight = false;
        });
      }, bidsResyncIntervalMs);
    }

    if (!activeBidsResyncTimer) {
      activeBidsResyncTimer = setInterval(() => {
        if (activeBidsResyncInFlight) {
          return;
        }
        activeBidsResyncInFlight = true;
        void resyncActiveBids().finally(() => {
          activeBidsResyncInFlight = false;
        });
      }, activeBidsResyncIntervalMs);
    }
  }

  async function sendAuctionSnapshotToClient(
    client: RealtimeClient,
    auctionId: string
  ): Promise<void> {
    try {
      const snapshot = await loadAuctionSnapshotPayload(deps, auctionRepository, auctionId);
      if (!snapshot) {
        return;
      }
      sendRealtimePayload(client, { type: "auction_snapshot", data: snapshot });
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to push auction snapshot");
    }
  }

  async function sendAuctionBidsToClient(
    client: RealtimeClient,
    auctionId: string
  ): Promise<void> {
    try {
      const bidsPayload = await loadAuctionBidsPayload(deps, bids, auctionId, 15);
      sendRealtimePayload(client, { type: "auction_bids", auctionId, data: bidsPayload });
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to push auction bids");
    }
  }

  function sendRealtimePayload(client: RealtimeClient, payload: unknown): void {
    try {
      client.socket.send(JSON.stringify(payload));
    } catch {
      cleanupRealtimeClient(client);
    }
  }

  function sendRealtimePayloadToClients(
    clientIds: Iterable<string>,
    payload: unknown
  ): void {
    for (const clientId of clientIds) {
      const client = realtimeClients.get(clientId);
      if (!client) {
        continue;
      }
      sendRealtimePayload(client, payload);
    }
  }

  function broadcastRealtimePayload(payload: unknown): void {
    for (const client of realtimeClients.values()) {
      sendRealtimePayload(client, payload);
    }
  }

  function attachRealtimeUser(client: RealtimeClient, userId: string): void {
    if (client.userId === userId) {
      return;
    }
    if (client.userId) {
      detachRealtimeUser(client);
    }
    client.userId = userId;
    const set = userSubscriptions.get(userId) ?? new Set<string>();
    set.add(client.id);
    userSubscriptions.set(userId, set);
  }

  function detachRealtimeUser(client: RealtimeClient): void {
    if (!client.userId) {
      return;
    }
    const set = userSubscriptions.get(client.userId);
    if (set) {
      set.delete(client.id);
      if (set.size === 0) {
        userSubscriptions.delete(client.userId);
      }
    }
    client.userId = null;
  }

  function attachAuctionSubscription(client: RealtimeClient, auctionId: string): void {
    if (!ObjectId.isValid(auctionId)) {
      return;
    }
    if (client.auctionIds.has(auctionId)) {
      return;
    }
    client.auctionIds.add(auctionId);
    const set = auctionSubscriptions.get(auctionId) ?? new Set<string>();
    set.add(client.id);
    auctionSubscriptions.set(auctionId, set);
    void sendAuctionSnapshotToClient(client, auctionId);
    void sendAuctionBidsToClient(client, auctionId);
  }

  function detachAuctionSubscription(client: RealtimeClient, auctionId: string): void {
    if (!client.auctionIds.has(auctionId)) {
      return;
    }
    client.auctionIds.delete(auctionId);
    const set = auctionSubscriptions.get(auctionId);
    if (set) {
      set.delete(client.id);
      if (set.size === 0) {
        auctionSubscriptions.delete(auctionId);
      }
    }
  }

  function cleanupRealtimeClient(client: RealtimeClient): void {
    if (!realtimeClients.has(client.id)) {
      return;
    }
    realtimeClients.delete(client.id);
    detachRealtimeUser(client);
    for (const auctionId of client.auctionIds) {
      const set = auctionSubscriptions.get(auctionId);
      if (set) {
        set.delete(client.id);
        if (set.size === 0) {
          auctionSubscriptions.delete(auctionId);
        }
      }
    }
    client.auctionIds.clear();
    try {
      client.socket.close();
    } catch {
      // ignore close errors
    }
  }

  function normalizeAuctionIds(value: unknown): string[] {
    if (!value) {
      return [];
    }
    if (typeof value === "string") {
      return value.trim().length > 0 ? [value.trim()] : [];
    }
    if (Array.isArray(value)) {
      return value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    }
    return [];
  }

  app.addHook("onRequest", async (request, reply) => {
    const origin = getHeaderValue(request.headers, "origin");
    if (!origin) {
      return;
    }

    const allowedOrigins = resolveAllowedOrigins(request, deps);
    if (!isOriginAllowed(origin, allowedOrigins)) {
      reply.code(403).send({ error: "cors_rejected", message: "Origin not allowed." });
      return;
    }

    const allowOrigin = allowedOrigins.includes("*") ? "*" : origin;
    reply.header("Access-Control-Allow-Origin", allowOrigin);
    reply.header("Vary", "Origin");
    reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    reply.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Requested-With, X-Telegram-Init-Data, X-Telegram-Web-App-Data, X-Demo-User-Id"
    );
    reply.header("Access-Control-Max-Age", "600");

    if (request.method === "OPTIONS") {
      reply.code(204).send();
      return;
    }
  });

  app.addHook("preHandler", async (request, reply) => {
    if (request.method === "OPTIONS") {
      return;
    }
    if (!unsafeMethods.has(request.method)) {
      return;
    }
    const origin = getRequestOrigin(request);
    const allowedOrigins = resolveAllowedOrigins(request, deps);
    if (!origin) {
      if (allowedOrigins.includes("*")) {
        return;
      }
      reply.code(403).send({ error: "csrf_failed", message: "Origin required." });
      return;
    }
    if (!isOriginAllowed(origin, allowedOrigins)) {
      reply.code(403).send({ error: "csrf_failed", message: "Origin not allowed." });
      return;
    }
  });

  app.get("/", async (request, reply) => {
    const html = await loadHtml("index.html", request, deps);
    return reply.type("text/html").send(html);
  });

  app.get("/api/session", async (request) => {
    const resolved = resolveAuth(request, deps);
    if (!resolved.ok) {
      return { user: null };
    }
    const auth = resolved.user;
    return {
      user: {
        id: auth.id,
        displayName: auth.displayName,
        username: auth.username,
        firstName: auth.firstName,
        lastName: auth.lastName,
        languageCode: auth.languageCode,
        source: auth.source
      }
    };
  });

  app.get("/api/auctions", async () => {
    return loadActiveAuctions(deps, auctionRepository);
  });

  app.get("/api/bids/active", async (request, reply) => {
    const auth = requireAuth(request, reply, deps);
    if (!auth) {
      return;
    }
    const query = request.query as { limit?: string };
    const limit = normalizeLimit(query.limit);
    if (shouldRunFinalizationFallback(auth)) {
      await maybeFinalizeUserAuctions(auth.id, limit * 4);
    }
    return loadActiveBidsForUser(deps, bids, auth.id, limit);
  });

  app.get("/api/bids/history", async (request, reply) => {
    const auth = requireAuth(request, reply, deps);
    if (!auth) {
      return;
    }
    const query = request.query as { limit?: string };
    const limit = normalizeLimit(query.limit);
    if (shouldRunFinalizationFallback(auth)) {
      await maybeFinalizeUserAuctions(auth.id, limit * 4);
    }
    return loadBidHistoryForUser(deps, bids, auth.id, limit);
  });

  app.get("/api/watchlist", async (request, reply) => {
    const auth = requireAuth(request, reply, deps);
    if (!auth) {
      return;
    }
    const entries = await watchlist
      .find({ userId: auth.id })
      .sort({ updatedAt: -1 })
      .toArray();
    const auctionIds = entries.map((entry) => entry.auctionId);
    const auctions = await deps.mongo.db
      .collection<AuctionDocument>(mongoCollections.auctions)
      .find({ _id: { $in: auctionIds } })
      .project({ title: 1, status: 1, currency: 1, deliveryType: 1 })
      .toArray();
    const auctionMap = new Map(
      auctions.map((auction) => [auction._id.toHexString(), auction])
    );
    return entries.map((entry) => {
      const auction = auctionMap.get(entry.auctionId.toHexString());
      return {
        auctionId: entry.auctionId.toHexString(),
        notifyOutbid: entry.notifyOutbid ?? true,
        updatedAt: entry.updatedAt,
        auctionTitle: auction?.title ?? "Auction",
        auctionStatus: auction?.status ?? "draft",
        currency: auction?.currency ?? "USDT",
        deliveryType: auction?.deliveryType ?? null
      };
    });
  });

  app.post(
    "/api/watchlist",
    { schema: { body: watchlistSchema } },
    async (request, reply) => {
      const auth = requireAuth(request, reply, deps);
      if (!auth) {
        return;
      }
      const body = request.body as { auctionId: string; notifyOutbid?: boolean };
      if (!ObjectId.isValid(body.auctionId)) {
        return reply.code(400).send({ error: "invalid_request", message: "Invalid auction id." });
      }
      const now = new Date();
      await watchlist.updateOne(
        { userId: auth.id, auctionId: new ObjectId(body.auctionId) },
        {
          $setOnInsert: { userId: auth.id, auctionId: new ObjectId(body.auctionId), createdAt: now },
          $set: { updatedAt: now, notifyOutbid: body.notifyOutbid ?? true }
        },
        { upsert: true }
      );
      return { ok: true };
    }
  );

  app.delete("/api/watchlist/:auctionId", async (request, reply) => {
    const auth = requireAuth(request, reply, deps);
    if (!auth) {
      return;
    }
    const params = request.params as { auctionId: string };
    if (!ObjectId.isValid(params.auctionId)) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid auction id." });
    }
    await watchlist.deleteOne({
      userId: auth.id,
      auctionId: new ObjectId(params.auctionId)
    });
    return { ok: true };
  });

  app.get("/api/deliveries", async (request, reply) => {
    const auth = requireAuth(request, reply, deps);
    if (!auth) {
      return;
    }
    const deliveries = await deliveryRecords
      .find({ userId: auth.id })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
    return deliveries.map((delivery) => ({
      auctionId: delivery.auctionId.toHexString(),
      roundIndex: delivery.roundIndex,
      deliveryRef: delivery.deliveryRef,
      deliveryType: delivery.deliveryType ?? null,
      deliveryPayload: delivery.deliveryPayload ?? null,
      status: delivery.status ?? null,
      deliveredAt: delivery.deliveredAt ?? null,
      createdAt: delivery.createdAt
    }));
  });

  app.get("/api/auctions/:auctionId/rounds/:roundIndex/replay", async (request, reply) => {
    const params = request.params as { auctionId: string; roundIndex: string };
    const parsed = parseRoundParams(params);
    if (!parsed) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid round params." });
    }
    const replay = await loadRoundReplayPayload(
      deps,
      auctionRepository,
      bids,
      roundResults,
      parsed.auctionId,
      parsed.roundIndex
    );
    if (!replay) {
      return reply.code(404).send({ error: "not_found", message: "Round not found." });
    }
    return { replay };
  });

  app.get("/api/auctions/:auctionId/rounds/:roundIndex/proof", async (request, reply) => {
    const params = request.params as { auctionId: string; roundIndex: string };
    const parsed = parseRoundParams(params);
    if (!parsed) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid round params." });
    }
    const result = await roundResults.findOne({
      auctionId: parsed.auctionId,
      roundIndex: parsed.roundIndex
    });
    if (!result) {
      return reply.code(404).send({ error: "not_found", message: "Round proof missing." });
    }
    return {
      auctionId: parsed.auctionId.toHexString(),
      roundIndex: parsed.roundIndex,
      winners: result.winners,
      merkleRoot: result.merkleRoot ?? null,
      merkleCount: result.merkleCount ?? null,
      proof: result.proof ?? null
    };
  });

  app.get("/api/auctions/:auctionId/rounds/:roundIndex/verify", async (request, reply) => {
    const params = request.params as { auctionId: string; roundIndex: string };
    const parsed = parseRoundParams(params);
    if (!parsed) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid round params." });
    }
    const result = await roundResults.findOne({
      auctionId: parsed.auctionId,
      roundIndex: parsed.roundIndex
    });
    if (!result) {
      return reply.code(404).send({ error: "not_found", message: "Round proof missing." });
    }
    const verification = await verifyRoundProof(
      auctionRepository,
      bids,
      result,
      parsed.auctionId,
      parsed.roundIndex
    );
    return verification;
  });

  app.post(
    "/api/auctions",
    { schema: { body: createAuctionSchema } },
    async (request, reply) => {
      const auth = requireAuth(request, reply, deps);
      if (!auth) {
        return;
      }
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
      const endsAt = rounds[rounds.length - 1]?.endAt ?? startAt;
      let config;
      try {
        config = parseAuctionConfig({
          title: body.title,
          description: body.description,
          currency: body.currency ?? "USDT",
          pricingMode: body.pricingMode,
          minBid: body.minBid,
          minIncrement: body.minIncrement,
          deliveryType: body.deliveryType,
          startsAt: startAt,
          endsAt,
          rounds
        }, {
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

      const auctions = deps.mongo.db.collection<AuctionDocument>(mongoCollections.auctions);
      const created = await runMongoTransaction(deps.mongo, async (session) => {
        await auctions.insertOne(auction, { session });
        await auctionRepository.ensureRoundStates(auction, session);
        return auction;
      });
      let stored = created;
      try {
        await ensureAuctionRoundProgress(deps, auctionRepository, created._id, now);
        const refreshed = await auctionRepository.getAuctionById(created._id);
        if (refreshed) {
          stored = refreshed;
        }
      } catch (error) {
        deps.logger.warn({ err: error }, "Failed to sync auction rounds after creation");
      }

      try {
        await invalidateActiveAuctionListCache(deps.redis);
      } catch (error) {
        deps.logger.warn({ err: error }, "Failed to invalidate auction list cache");
      }
      try {
        await publishRealtimeEvent(deps.redis, {
          type: "auction.list.updated",
          auctionId: stored._id.toHexString(),
          reason: "created"
        });
      } catch (error) {
        deps.logger.warn({ err: error }, "Failed to publish auction list update");
      }

      return reply.code(201).send({ _id: stored._id.toHexString(), status: stored.status });
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
      pricingMode: auction.pricingMode ?? "first-price",
      minBid: Number.isFinite(auction.minBid) ? auction.minBid : 0,
      minIncrement: Number.isFinite(auction.minIncrement) ? auction.minIncrement : 0,
      deliveryType: auction.deliveryType ?? null,
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
    const snapshot = await loadAuctionSnapshotPayload(deps, auctionRepository, auctionId);
    if (!snapshot) {
      return reply.code(404).send({ error: "not_found", message: "Auction not found." });
    }
    return snapshot;
  });

  app.get("/api/auctions/:auctionId/bids", async (request, reply) => {
    const params = request.params as { auctionId: string };
    const query = request.query as { limit?: string };
    if (!ObjectId.isValid(params.auctionId)) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid auction id." });
    }
    const limit = normalizeLimit(query.limit);
    return loadAuctionBidsPayload(deps, bids, params.auctionId, limit);
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
      const auth = requireAuth(request, reply, deps);
      if (!auth) {
        return;
      }
      const userId = auth.id;

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
          maxAmount: body.maxAmount,
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
            maxAmount: result.bid.maxAmount ?? null,
            createdAt: result.bid.createdAt,
            idempotencyKey: result.bid.idempotencyKey,
            active: result.bid.active,
            origin: result.bid.origin ?? null
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

  app.get("/api/crypto/deposit-address", async (request, reply) => {
    const query = request.query as { currency?: string };
    const auth = requireAuth(request, reply, deps);
    if (!auth) {
      return;
    }
    const currency = query.currency?.trim() || "USDT";
    try {
      const destination = await cryptoGatewayService.getDepositDestination(auth.id, currency);
      return {
        currency: destination.currency,
        address: destination.address,
        memo: destination.memo ?? null,
        strategy: destination.strategy
      };
    } catch (error) {
      return handleCryptoError(reply, error);
    }
  });

  app.post(
    "/api/demo/deposit",
    { schema: { body: demoDepositSchema } },
    async (request, reply) => {
      const auth = requireAuth(request, reply, deps);
      if (!auth) {
        return;
      }
      if (!deps.config.web.allowDemoUser || auth.source !== "demo") {
        return reply
          .code(403)
          .send({ error: "forbidden", message: "Demo deposits are only available for demo users." });
      }
      const body = request.body as DemoDepositBody;
      const amount = body.amount;
      if (!Number.isFinite(amount) || amount <= 0) {
        return reply
          .code(400)
          .send({ error: "invalid_request", message: "Amount must be a positive number." });
      }
      const currency = body.currency?.trim() || "USDT";
      const idempotencyKey = body.idempotencyKey?.trim() || `demo-deposit:${randomUUID()}`;

      const userAgentHeader = request.headers["user-agent"];
      const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader;
      const audit = {
        source: "web",
        ip: request.ip,
        userAgent:
          typeof userAgent === "string" && userAgent.trim().length > 0 ? userAgent : undefined
      };

      try {
        const result = await ledgerRepository.createEntry({
          userId: auth.id,
          entryType: "deposit_confirmed",
          amount,
          currency,
          idempotencyKey,
          metadata: { source: "demo" },
          audit
        });
        void publishRealtimeEvent(deps.redis, {
          type: "balance.updated",
          userIds: [auth.id],
          currency
        });
        return reply.send({
          entryId: result.entry._id.toHexString(),
          balance: result.balance
        });
      } catch (error) {
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

  app.post(
    "/api/crypto/withdrawals",
    { schema: { body: withdrawalRequestSchema } },
    async (request, reply) => {
      const auth = requireAuth(request, reply, deps);
      if (!auth) {
        return;
      }
      const body = request.body as WithdrawalRequestBody;
      const destinationAddress = body.destinationAddress?.trim() ?? "";
      if (destinationAddress.length === 0) {
        return reply
          .code(400)
          .send({ error: "invalid_request", message: "Destination address is required." });
      }
      const amount = body.amount;
      if (!Number.isFinite(amount) || amount <= 0) {
        return reply
          .code(400)
          .send({ error: "invalid_request", message: "Withdrawal amount must be positive." });
      }
      const currency = body.currency?.trim() || "USDT";
      const memo = body.memo?.trim();

      try {
        const result = await cryptoGatewayService.requestWithdrawal({
          userId: auth.id,
          currency,
          amount,
          destinationAddress,
          memo: memo && memo.length > 0 ? memo : undefined,
          idempotencyKey: body.idempotencyKey?.trim() || randomUUID()
        });
        return reply.send({
          withdrawal: serializeCryptoWithdrawal(result.withdrawal),
          balance: result.balance,
          decision: result.decision,
          flags: result.flags,
          violations: result.violations
        });
      } catch (error) {
        return handleCryptoError(reply, error);
      }
    }
  );

  app.get("/api/balance", async (request, reply) => {
    const query = request.query as { currency?: string };
    const auth = requireAuth(request, reply, deps);
    if (!auth) {
      return;
    }
    const userId = auth.id;
    const currency = query.currency || "USDT";
    if (shouldRunFinalizationFallback(auth)) {
      await maybeFinalizeUserAuctions(userId, 80);
    }
    const balance = await ledgerRepository.getBalance(userId, currency);
    return balance;
  });

  app.get("/api/balance/:userId", async (request, reply) => {
    const params = request.params as { userId: string };
    const query = request.query as { currency?: string };
    const auth = requireAuth(request, reply, deps);
    if (!auth) {
      return;
    }
    if (params.userId !== auth.id) {
      return reply.code(403).send({ error: "forbidden", message: "Access denied." });
    }
    const currency = query.currency || "USDT";
    if (shouldRunFinalizationFallback(auth)) {
      await maybeFinalizeUserAuctions(params.userId, 80);
    }
    const balance = await ledgerRepository.getBalance(params.userId, currency);
    return balance;
  });

  app.get("/api/profile/:userId", async (request, reply) => {
    const params = request.params as { userId: string };
    const userId = params.userId;

    if (!userId) {
      return reply.code(400).send({ error: "invalid_request", message: "User id required." });
    }

    try {
      // Get user auctions (created by this user)
      const auctions = deps.mongo.db.collection<AuctionDocument>(mongoCollections.auctions);
      const userAuctions = await auctions
        .find({ createdBy: userId })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray();

      // Get user bids count
      const bidsCount = await bids.countDocuments({ userId });

      // Get user balance
      const balance = await ledgerRepository.getBalance(userId, "USDT");

      const publicAuction = (auction: WithId<AuctionDocument>) => ({
        _id: auction._id.toHexString(),
        title: auction.title,
        description: auction.description,
        status: auction.status,
        currency: auction.currency,
        startsAt: auction.startsAt,
        endsAt: auction.endsAt,
        createdAt: auction.createdAt,
        rounds: auction.rounds.map((round) => ({
          index: round.index,
          allocationSize: round.allocationSize,
          startAt: round.startAt,
          endAt: round.endAt
        }))
      });

      const participationIds = (await bids.distinct("auctionId", { userId }))
        .map((value) => coerceObjectId(value))
        .filter((value): value is ObjectId => value !== null);

      const participatedAuctionDocs = participationIds.length
        ? await auctions
            .find({ _id: { $in: participationIds } })
            .sort({ createdAt: -1 })
            .limit(50)
            .toArray()
        : [];

      const participationStats = participationIds.length
        ? await bids
            .aggregate<{
              _id: ObjectId;
              bidsCount: number;
              lastBidAt: Date | null;
            }>([
              { $match: { userId, auctionId: { $in: participationIds } } },
              {
                $group: {
                  _id: "$auctionId",
                  bidsCount: { $sum: 1 },
                  lastBidAt: { $max: "$createdAt" }
                }
              }
            ])
            .toArray()
        : [];

      const statsByAuction = new Map<string, { bidsCount: number; lastBidAt: Date | null }>();
      for (const stat of participationStats) {
        statsByAuction.set(stat._id.toHexString(), {
          bidsCount: stat.bidsCount,
          lastBidAt: stat.lastBidAt ?? null
        });
      }

      const participationResults = participationIds.length
        ? await roundResults
            .find({
              auctionId: { $in: participationIds },
              "winners.userId": userId
            })
            .toArray()
        : [];

      const placementByAuction = new Map<string, number>();
      for (const result of participationResults) {
        const auctionId = result.auctionId.toHexString();
        for (const winner of result.winners) {
          if (winner.userId !== userId) {
            continue;
          }
          const current = placementByAuction.get(auctionId);
          if (current === undefined || winner.rank < current) {
            placementByAuction.set(auctionId, winner.rank);
          }
        }
      }

      const participatedAuctions = participatedAuctionDocs.map((auction) => {
        const base = publicAuction(auction);
        const stats = statsByAuction.get(base._id);
        return {
          ...base,
          bidsCount: stats?.bidsCount ?? 0,
          lastBidAt: stats?.lastBidAt ?? null,
          placement: placementByAuction.get(base._id) ?? null
        };
      });

      const activeAuctions = participatedAuctions.filter((auction) => auction.status === "live");

      return {
        userId,
        auctionsCreated: userAuctions.length,
        bidsPlaced: bidsCount,
        balance,
        auctions: userAuctions.map(publicAuction),
        activeAuctions,
        participatedAuctions
      };
    } catch (error) {
      return reply.code(500).send({ error: "internal_error", message: "Failed to load profile." });
    }
  });
}

function serializeCryptoWithdrawal(
  withdrawal: { _id: { toHexString: () => string } } & Record<string, unknown>
) {
  return {
    ...withdrawal,
    _id: withdrawal._id.toHexString()
  };
}

function handleCryptoError(reply: FastifyReply, error: unknown) {
  if (error instanceof CryptoGatewayError) {
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

function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: ServiceDependencies
): AuthenticatedUser | null {
  const resolved = resolveAuth(request, deps);
  if (resolved.ok) {
    return resolved.user;
  }
  reply.code(resolved.status).send({ error: resolved.code, message: resolved.message });
  return null;
}

function resolveAuth(request: FastifyRequest, deps: ServiceDependencies): AuthResolution {
  const initData = extractTelegramInitData(request.headers);
  if (initData) {
    if (!deps.config.telegram.botToken) {
      return {
        ok: false,
        status: 500,
        code: "telegram_not_configured",
        message: "Telegram bot token is not configured."
      };
    }
    const verified = verifyTelegramInitData(
      initData,
      deps.config.telegram.botToken,
      deps.config.telegram.webAppMaxAgeSeconds
    );
    if (!verified) {
      return {
        ok: false,
        status: 401,
        code: "telegram_invalid",
        message: "Invalid Telegram init data."
      };
    }
    return {
      ok: true,
      user: {
        ...verified.user,
        source: "telegram"
      }
    };
  }

  const allowDemoUser = deps.config.web.allowDemoUser;
  if (allowDemoUser) {
    const demoUserId =
      normalizeDemoUserId(getHeaderValue(request.headers, "x-demo-user-id")) ?? "demo";
    return {
      ok: true,
      user: {
        id: demoUserId,
        displayName: "Demo user",
        source: "demo"
      }
    };
  }

  return {
    ok: false,
    status: 401,
    code: "auth_required",
    message: "Telegram init data required."
  };
}

function resolveAuthFromRealtimePayload(
  payload: { initData?: unknown; demoUserId?: unknown },
  deps: ServiceDependencies
): AuthResolution {
  const initData = typeof payload.initData === "string" ? payload.initData.trim() : "";
  if (initData) {
    if (!deps.config.telegram.botToken) {
      return {
        ok: false,
        status: 500,
        code: "telegram_not_configured",
        message: "Telegram bot token is not configured."
      };
    }
    const verified = verifyTelegramInitData(
      initData,
      deps.config.telegram.botToken,
      deps.config.telegram.webAppMaxAgeSeconds
    );
    if (!verified) {
      return {
        ok: false,
        status: 401,
        code: "telegram_invalid",
        message: "Invalid Telegram init data."
      };
    }
    return {
      ok: true,
      user: {
        ...verified.user,
        source: "telegram"
      }
    };
  }

  const allowDemoUser = deps.config.web.allowDemoUser;
  if (allowDemoUser) {
    const demoUserId =
      normalizeDemoUserId(typeof payload.demoUserId === "string" ? payload.demoUserId : null) ??
      "demo";
    return {
      ok: true,
      user: {
        id: demoUserId,
        displayName: "Demo user",
        source: "demo"
      }
    };
  }

  return {
    ok: false,
    status: 401,
    code: "auth_required",
    message: "Telegram init data required."
  };
}

function normalizeDemoUserId(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) {
    return null;
  }
  return trimmed;
}

function getHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  key: string
): string | null {
  const value = headers[key];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function getRequestOrigin(request: FastifyRequest): string | null {
  const origin = getHeaderValue(request.headers, "origin");
  if (origin) {
    return origin.replace(/\/+$/, "");
  }
  const referer = getHeaderValue(request.headers, "referer");
  if (!referer) {
    return null;
  }
  try {
    return new URL(referer).origin.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function resolveAllowedOrigins(request: FastifyRequest, deps: ServiceDependencies): string[] {
  if (deps.config.web.allowedOrigins.length > 0) {
    return deps.config.web.allowedOrigins;
  }
  const host =
    getHeaderValue(request.headers, "x-forwarded-host") ??
    getHeaderValue(request.headers, "host");
  if (!host) {
    return [];
  }
  const forwardedProto = getHeaderValue(request.headers, "x-forwarded-proto");
  const protocol = normalizeOriginProtocol(forwardedProto ?? request.protocol ?? "http");
  return [`${protocol}://${host}`];
}

function normalizeOriginProtocol(value: string): string {
  if (value === "ws") {
    return "http";
  }
  if (value === "wss") {
    return "https";
  }
  return value;
}

function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  if (allowedOrigins.includes("*")) {
    return true;
  }
  const cleaned = origin.replace(/\/+$/, "");
  return allowedOrigins.some((allowed) => allowed === cleaned);
}

function coerceObjectId(value: unknown): ObjectId | null {
  if (value instanceof ObjectId) {
    return value;
  }
  if (typeof value === "string" && ObjectId.isValid(value)) {
    return new ObjectId(value);
  }
  return null;
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

async function loadActiveAuctions(
  deps: ServiceDependencies,
  auctionRepository: ReturnType<typeof createAuctionRepository>
): Promise<ActiveAuctionPayload[]> {
  try {
    const cached = await readActiveAuctionListFromRedis(deps.redis);
    if (cached !== null) {
      return cached as ActiveAuctionPayload[];
    }
  } catch (error) {
    deps.logger.warn({ err: error }, "Failed to read auction list cache");
  }

  const auctions = await auctionRepository.listActiveAuctions();
  const payload: ActiveAuctionPayload[] = auctions.map((auction) => ({
    _id: auction._id.toHexString(),
    title: auction.title,
    description: auction.description,
    status: auction.status,
    currency: auction.currency,
    pricingMode: auction.pricingMode ?? "first-price",
    minBid: Number.isFinite(auction.minBid) ? auction.minBid : 0,
    minIncrement: Number.isFinite(auction.minIncrement) ? auction.minIncrement : 0,
    deliveryType: auction.deliveryType ?? null,
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
}

async function loadActiveBidsForUser(
  deps: ServiceDependencies,
  bids: Collection<BidDocument>,
  userId: string,
  limit: number
): Promise<ActiveBidPayload[]> {
  const bidDocs = await bids
    .find({ userId, active: true })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();

  if (bidDocs.length === 0) {
    return [];
  }

  const auctionIds = bidDocs.map((bid) => bid.auctionId);
  const auctionDocs = await deps.mongo.db
    .collection<AuctionDocument>(mongoCollections.auctions)
    .find({ _id: { $in: auctionIds } })
    .project({ title: 1, status: 1, currency: 1, rounds: 1, currentRoundIndex: 1 })
    .toArray();
  const auctionMap = new Map(
    auctionDocs.map((auction) => [auction._id.toHexString(), auction])
  );

  return bidDocs.map((bid) => {
    const auction = auctionMap.get(bid.auctionId.toHexString());
    return {
      id: bid._id.toHexString(),
      auctionId: bid.auctionId.toHexString(),
      amount: bid.amount,
      maxAmount: bid.maxAmount ?? null,
      createdAt: bid.createdAt,
      roundIndex: bid.roundIndex ?? auction?.currentRoundIndex ?? null,
      roundsCount: auction?.rounds?.length ?? null,
      auctionTitle: auction?.title ?? "Auction",
      auctionStatus: auction?.status ?? "draft",
      currency: auction?.currency ?? "USDT"
    };
  });
}

async function loadBidHistoryForUser(
  deps: ServiceDependencies,
  bids: Collection<BidDocument>,
  userId: string,
  limit: number
): Promise<ActiveBidPayload[]> {
  const scanLimit = Math.max(limit, Math.min(200, limit * 4));
  const bidDocs = await bids
    .find({ userId })
    .sort({ createdAt: -1 })
    .limit(scanLimit)
    .toArray();

  if (bidDocs.length === 0) {
    return [];
  }

  const auctionIds = bidDocs.map((bid) => bid.auctionId);
  const auctionDocs = await deps.mongo.db
    .collection<AuctionDocument>(mongoCollections.auctions)
    .find({ _id: { $in: auctionIds } })
    .project({ title: 1, status: 1, currency: 1, rounds: 1, currentRoundIndex: 1 })
    .toArray();
  const auctionMap = new Map(
    auctionDocs.map((auction) => [auction._id.toHexString(), auction])
  );

  const history: ActiveBidPayload[] = [];
  for (const bid of bidDocs) {
    const auction = auctionMap.get(bid.auctionId.toHexString());
    if (!auction || auction.status !== "closed") {
      continue;
    }
    history.push({
      id: bid._id.toHexString(),
      auctionId: bid.auctionId.toHexString(),
      amount: bid.amount,
      maxAmount: bid.maxAmount ?? null,
      createdAt: bid.createdAt,
      roundIndex: bid.roundIndex ?? auction.currentRoundIndex ?? null,
      roundsCount: auction.rounds?.length ?? null,
      auctionTitle: auction.title ?? "Auction",
      auctionStatus: auction.status ?? "draft",
      currency: auction.currency ?? "USDT"
    });
    if (history.length >= limit) {
      break;
    }
  }

  return history;
}

async function loadAuctionSnapshotPayload(
  deps: ServiceDependencies,
  auctionRepository: ReturnType<typeof createAuctionRepository>,
  auctionId: string
): Promise<RealtimeAuctionSnapshot | null> {
  const now = new Date();
  const auctionObjectId = new ObjectId(auctionId);
  try {
    await ensureAuctionRoundProgress(deps, auctionRepository, auctionObjectId, now);
  } catch (error) {
    deps.logger.warn({ err: error, auctionId }, "Failed to catch up auction snapshot");
  }

  const cached = await readAuctionSnapshotFromRedis(deps.redis, auctionId);
  if (cached) {
    return toRealtimeSnapshot({ ...cached, serverTime: now });
  }

  const auction = await auctionRepository.getAuctionById(auctionObjectId);
  if (!auction) {
    return null;
  }

  if (
    auction.currentRoundIndex !== undefined &&
    auction.roundStatus !== undefined &&
    auction.roundEffectiveEndAt !== undefined
  ) {
    return toRealtimeSnapshot({
      auctionId,
      status: auction.status,
      title: auction.title,
      currency: auction.currency,
      currentRoundIndex: auction.currentRoundIndex ?? null,
      roundStatus: auction.roundStatus ?? null,
      roundEffectiveEndAt: auction.roundEffectiveEndAt ?? null,
      roundLastBidAt: auction.roundLastBidAt ?? null,
      lastBidAmount: auction.lastBidAmount ?? null,
      updatedAt: auction.updatedAt ?? now,
      serverTime: now
    });
  }

  const roundState = await auctionRepository.getLiveRoundState(auctionObjectId);
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

  return toRealtimeSnapshot({
    auctionId,
    status: auction.status,
    title: auction.title,
    currency: auction.currency,
    currentRoundIndex: roundState?.roundIndex ?? null,
    roundStatus: roundState?.status ?? null,
    roundEffectiveEndAt: roundState?.effectiveEndAt ?? null,
    roundLastBidAt: roundState?.lastBidAt ?? null,
    lastBidAmount: null,
    updatedAt: roundState?.updatedAt ?? auction.updatedAt ?? now,
    serverTime: now
  });
}

async function loadAuctionBidsPayload(
  deps: ServiceDependencies,
  bids: Collection<BidDocument>,
  auctionId: string,
  limit: number
): Promise<Array<{ _id: string; userId: string; amount: number; createdAt: Date }>> {
  const rankingKey = `auction:${auctionId}:ranking`;
  let members: string[] = [];
  try {
    members = await deps.redis.zrevrange(rankingKey, 0, limit - 1);
  } catch (error) {
    deps.logger.warn({ err: error }, "Failed to read auction bids from Redis");
    members = [];
  }
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
}

function parseRoundParams(params: {
  auctionId?: string;
  roundIndex?: string;
}): { auctionId: ObjectId; roundIndex: number } | null {
  if (!params.auctionId || !ObjectId.isValid(params.auctionId)) {
    return null;
  }
  const roundIndex = Number(params.roundIndex);
  if (!Number.isInteger(roundIndex) || roundIndex < 0) {
    return null;
  }
  return { auctionId: new ObjectId(params.auctionId), roundIndex };
}

async function loadRoundReplayPayload(
  deps: ServiceDependencies,
  auctionRepository: ReturnType<typeof createAuctionRepository>,
  bids: Collection<BidDocument>,
  roundResults: Collection<RoundResultDocument>,
  auctionId: ObjectId,
  roundIndex: number
): Promise<ReplayPayload | null> {
  const auction = await auctionRepository.getAuctionById(auctionId);
  if (!auction) {
    return null;
  }
  const roundConfig = auction.rounds.find((round) => round.index === roundIndex);
  if (!roundConfig) {
    return null;
  }
  const roundState = await auctionRepository.getRoundState(auctionId, roundIndex);
  const result = await roundResults.findOne({ auctionId, roundIndex });
  const bidDocs = await bids
    .find({ auctionId, roundIndex })
    .sort({ createdAt: 1, _id: 1 })
    .project<Pick<WithId<BidDocument>, "_id" | "userId" | "amount" | "maxAmount" | "createdAt" | "origin">>({
      _id: 1,
      userId: 1,
      amount: 1,
      maxAmount: 1,
      createdAt: 1,
      origin: 1
    })
    .toArray();
  const bidPayloads: ReplayBidPayload[] = bidDocs.map((bid) => ({
    bidId: bid._id.toHexString(),
    userId: bid.userId,
    amount: bid.amount,
    maxAmount: bid.maxAmount ?? null,
    createdAt: bid.createdAt.toISOString(),
    origin: bid.origin ?? null
  }));

  return {
    auction: {
      id: auction._id.toHexString(),
      title: auction.title,
      currency: auction.currency,
      deliveryType: auction.deliveryType ?? null
    },
    round: {
      index: roundIndex,
      allocationSize: roundConfig.allocationSize,
      startAt: roundConfig.startAt.toISOString(),
      endAt: roundConfig.endAt.toISOString(),
      antiSniping: roundConfig.antiSniping
    },
    state: {
      effectiveEndAt: roundState?.effectiveEndAt?.toISOString() ?? null,
      extensionCount: roundState?.extensionCount ?? null,
      lastBidAt: roundState?.lastBidAt?.toISOString() ?? null
    },
    bids: bidPayloads,
    winners: result?.winners ?? null,
    proof: (result?.proof as SignedRoundProof | undefined) ?? null,
    merkleRoot: result?.merkleRoot ?? null,
    merkleCount: result?.merkleCount ?? null
  };
}

async function verifyRoundProof(
  auctionRepository: ReturnType<typeof createAuctionRepository>,
  bids: Collection<BidDocument>,
  roundResult: WithId<RoundResultDocument>,
  auctionId: ObjectId,
  roundIndex: number
): Promise<Record<string, unknown>> {
  const proofPayload = await buildRoundProofPayload(
    auctionRepository,
    bids,
    roundResult,
    auctionId,
    roundIndex
  );
  if (!proofPayload) {
    return { ok: false, reason: "missing_round_context" };
  }

  const signedProof = roundResult.proof as SignedRoundProof | undefined;
  const signedPayload = signedProof?.payload ?? proofPayload.payload;
  const payloadMatch =
    signedProof?.payload ? canonicalize(signedProof.payload) === canonicalize(proofPayload.payload) : true;

  const expectedRoot = proofPayload.payload.bidsRoot;
  const storedRoot = roundResult.merkleRoot ?? signedProof?.payload?.bidsRoot ?? null;
  const merkleRootMatch = storedRoot ? storedRoot === expectedRoot : false;

  const winnersMatch =
    canonicalize(roundResult.winners.map((winner) => ({
      userId: winner.userId,
      bidId: winner.bidId.toHexString(),
      amount: winner.amount,
      rank: winner.rank
    }))) === canonicalize(proofPayload.payload.winners);

  let signatureValid = false;
  if (signedProof?.signature && signedProof.publicKey) {
    try {
      const publicKey = createPublicKey({
        key: Buffer.from(signedProof.publicKey, "base64"),
        format: "der",
        type: "spki"
      });
      signatureValid = verify(
        null,
        Buffer.from(canonicalize(signedPayload), "utf8"),
        publicKey,
        Buffer.from(signedProof.signature, "base64")
      );
    } catch {
      signatureValid = false;
    }
  }

  return {
    ok: payloadMatch && merkleRootMatch && winnersMatch && signatureValid,
    payloadMatch,
    merkleRootMatch,
    winnersMatch,
    signatureValid,
    merkleRoot: expectedRoot,
    bidsCount: proofPayload.payload.bidsCount
  };
}

async function buildRoundProofPayload(
  auctionRepository: ReturnType<typeof createAuctionRepository>,
  bids: Collection<BidDocument>,
  roundResult: WithId<RoundResultDocument>,
  auctionId: ObjectId,
  roundIndex: number
): Promise<{ payload: RoundProofPayload } | null> {
  const auction = await auctionRepository.getAuctionById(auctionId);
  if (!auction) {
    return null;
  }
  const roundConfig = auction.rounds.find((round) => round.index === roundIndex);
  if (!roundConfig) {
    return null;
  }
  const roundState = await auctionRepository.getRoundState(auctionId, roundIndex);
  const bidDocs = await bids
    .find({ auctionId, roundIndex })
    .sort({ createdAt: 1, _id: 1 })
    .project<Pick<WithId<BidDocument>, "_id" | "userId" | "amount" | "maxAmount" | "createdAt" | "origin">>({
      _id: 1,
      userId: 1,
      amount: 1,
      maxAmount: 1,
      createdAt: 1,
      origin: 1
    })
    .toArray();
  const bidPayloads = bidDocs.map((bid) => ({
    bidId: bid._id.toHexString(),
    userId: bid.userId,
    amount: bid.amount,
    maxAmount: bid.maxAmount ?? null,
    createdAt: bid.createdAt.toISOString(),
    origin: bid.origin ?? "manual"
  }));
  const { root } = buildMerkleRootFromPayloads(bidPayloads);

  const payload: RoundProofPayload = {
    auctionId: auction._id.toHexString(),
    roundIndex,
    allocationSize: roundConfig.allocationSize,
    roundStartAt: roundConfig.startAt.toISOString(),
    roundEndAt: roundConfig.endAt.toISOString(),
    effectiveEndAt: roundState?.effectiveEndAt?.toISOString() ?? null,
    extensionCount: roundState?.extensionCount ?? null,
    antiSniping: {
      triggerWindowSeconds: roundConfig.antiSniping.triggerWindowSeconds,
      extensionSeconds: roundConfig.antiSniping.extensionSeconds,
      maxExtensions: roundConfig.antiSniping.maxExtensions
    },
    bidsRoot: root,
    bidsCount: bidPayloads.length,
    winners: roundResult.winners.map((winner) => ({
      userId: winner.userId,
      bidId: winner.bidId.toHexString(),
      amount: winner.amount,
      rank: winner.rank
    })),
    finalizedAt: (roundResult.finalizedAt ?? roundResult.createdAt ?? new Date()).toISOString()
  };

  return { payload };
}

type WebI18nPayload = {
  locale: Locale;
  defaultLocale: Locale;
  supportedLocales: Locale[];
  catalogs: Record<Locale, Catalog>;
};

type WebConfigPayload = {
  allowDemoUser: boolean;
};

async function loadHtml(
  filename: string,
  request: FastifyRequest,
  deps: ServiceDependencies
): Promise<string> {
  let html = "";
  try {
    const filePath = join(__dirname, "static", filename);
    html = await readFile(filePath, "utf-8");
  } catch {
    html = getDefaultHtml();
  }

  const locale = resolveWebLocale(request, deps);
  const withI18n = injectI18n(html, {
    locale,
    defaultLocale: deps.config.i18n.defaultLocale,
    supportedLocales: deps.config.i18n.supportedLocales,
    catalogs: webCatalogs
  });
  return injectWebConfig(withI18n, {
    allowDemoUser: deps.config.web.allowDemoUser
  });
}

function resolveWebLocale(request: FastifyRequest, deps: ServiceDependencies): Locale {
  const query = request.query as { lang?: string };
  const headerValue = request.headers["accept-language"];
  const acceptLanguage = Array.isArray(headerValue) ? headerValue.join(",") : headerValue;
  const candidate = (typeof query.lang === "string" && query.lang.length > 0
    ? query.lang
    : acceptLanguage) ?? undefined;

  return resolveLocale(candidate, deps.config.i18n.defaultLocale, deps.config.i18n.supportedLocales);
}

function injectI18n(html: string, payload: WebI18nPayload): string {
  const serialized = JSON.stringify(payload).replace(/</g, "\\u003c");
  if (html.includes("__I18N_PAYLOAD__")) {
    return html.replace("__I18N_PAYLOAD__", serialized);
  }
  const scriptTag = `<script id="i18n-data" type="application/json">${serialized}</script>`;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${scriptTag}\n</head>`);
  }
  return `${scriptTag}\n${html}`;
}

function injectWebConfig(html: string, payload: WebConfigPayload): string {
  const serialized = JSON.stringify(payload).replace(/</g, "\\u003c");
  if (html.includes("__WEB_CONFIG__")) {
    return html.replace("__WEB_CONFIG__", serialized);
  }
  const scriptTag = `<script id="web-config" type="application/json">${serialized}</script>`;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${scriptTag}\n</head>`);
  }
  return `${scriptTag}\n${html}`;
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
      authSource: 'none',
      timers: {
        snapshot: null,
        bids: null,
        list: null
      }
    };
    const realtimeState = {
      socket: null,
      reconnectDelay: 1000,
      reconnectTimer: null,
      queue: [],
      watchingAuctionId: null
    };

    const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
    const webConfig = (() => {
      const element = document.getElementById('web-config');
      if (!element) return {};
      try {
        return JSON.parse(element.textContent || '{}');
      } catch (error) {
        console.warn('Failed to parse web config', error);
        return {};
      }
    })();
    const allowDemoUser = Boolean(webConfig.allowDemoUser);

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

    function getTelegramInitData() {
      if (!tg || typeof tg.initData !== 'string') return '';
      return tg.initData;
    }

    function getDemoUserId() {
      if (!allowDemoUser) return null;
      const stored = localStorage.getItem('demoUserId');
      if (stored && stored.trim().length > 0) {
        return stored.trim();
      }
      return 'demo';
    }

    function apiFetch(url, options = {}) {
      const headers = Object.assign(
        { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        options.headers || {}
      );
      const initData = getTelegramInitData();
      if (initData) {
        headers['x-telegram-init-data'] = initData;
      } else if (allowDemoUser) {
        const demoUserId = getDemoUserId();
        if (demoUserId) {
          headers['x-demo-user-id'] = demoUserId;
        }
      }
      return fetch(url, Object.assign({}, options, { headers }));
    }

    function getWebsocketUrl() {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      return protocol + '://' + window.location.host + '/ws';
    }

    function connectRealtime() {
      if (realtimeState.reconnectTimer) {
        clearTimeout(realtimeState.reconnectTimer);
        realtimeState.reconnectTimer = null;
      }
      const url = getWebsocketUrl();
      let socket;
      try {
        socket = new WebSocket(url);
      } catch (error) {
        scheduleRealtimeReconnect();
        return;
      }
      realtimeState.socket = socket;
      socket.addEventListener('open', () => {
        realtimeState.reconnectDelay = 1000;
        flushRealtimeQueue();
        sendRealtimeAuth();
        if (state.timers.list) {
          clearInterval(state.timers.list);
          state.timers.list = null;
        }
        if (state.timers.snapshot) {
          clearInterval(state.timers.snapshot);
          state.timers.snapshot = null;
        }
        if (state.timers.bids) {
          clearInterval(state.timers.bids);
          state.timers.bids = null;
        }
        if (state.currentAuction && state.currentAuction._id) {
          watchAuction(state.currentAuction._id);
        }
      });
      socket.addEventListener('message', (event) => {
        handleRealtimeMessage(event.data);
      });
      socket.addEventListener('close', () => {
        realtimeState.socket = null;
        scheduleRealtimeReconnect();
      });
      socket.addEventListener('error', () => {
        if (socket.readyState !== WebSocket.CLOSED) {
          socket.close();
        }
      });
    }

    function scheduleRealtimeReconnect() {
      if (realtimeState.reconnectTimer) return;
      const delay = realtimeState.reconnectDelay;
      realtimeState.reconnectTimer = setTimeout(() => {
        realtimeState.reconnectTimer = null;
        connectRealtime();
      }, delay);
      realtimeState.reconnectDelay = Math.min(realtimeState.reconnectDelay * 1.6, 30000);
    }

    function sendRealtime(payload) {
      const message = JSON.stringify(payload);
      const socket = realtimeState.socket;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(message);
        return;
      }
      realtimeState.queue.push(message);
    }

    function flushRealtimeQueue() {
      const socket = realtimeState.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      while (realtimeState.queue.length > 0) {
        const message = realtimeState.queue.shift();
        if (message) {
          socket.send(message);
        }
      }
    }

    function sendRealtimeAuth() {
      sendRealtime({
        type: 'auth',
        initData: getTelegramInitData(),
        demoUserId: allowDemoUser ? getDemoUserId() : null
      });
    }

    function watchAuction(auctionId) {
      if (!auctionId) return;
      realtimeState.watchingAuctionId = auctionId;
      sendRealtime({ type: 'subscribe', auctionId: auctionId });
    }

    function unwatchAuction() {
      if (!realtimeState.watchingAuctionId) return;
      sendRealtime({ type: 'unsubscribe', auctionId: realtimeState.watchingAuctionId });
      realtimeState.watchingAuctionId = null;
    }

    function isRealtimeConnected() {
      return Boolean(
        realtimeState.socket && realtimeState.socket.readyState === WebSocket.OPEN
      );
    }

    function handleRealtimeMessage(raw) {
      let message;
      try {
        message = JSON.parse(raw);
      } catch (error) {
        return;
      }
      if (!message || typeof message.type !== 'string') {
        return;
      }
      if (message.type === 'auctions') {
        if (Array.isArray(message.data)) {
          state.auctions = message.data;
          renderAuctions(state.auctions);
        }
        return;
      }
      if (message.type === 'auction_snapshot') {
        if (
          state.currentAuction &&
          message.data &&
          message.data.auctionId === state.currentAuction._id
        ) {
          applySnapshot(message.data);
        }
        return;
      }
      if (message.type === 'auction_bids') {
        if (state.currentAuction && message.auctionId === state.currentAuction._id) {
          renderBids(Array.isArray(message.data) ? message.data : []);
        }
        return;
      }
      if (message.type === 'error') {
        console.warn('Realtime error:', message.message || message.code || message);
      }
    }

    async function fetchSession() {
      try {
        const response = await apiFetch('/api/session');
        if (!response.ok) return null;
        const data = await response.json();
        return data && data.user ? data.user : null;
      } catch (error) {
        console.warn('Failed to load session', error);
        return null;
      }
    }

    async function loadUser() {
      const session = await fetchSession();
      if (session && session.id) {
        setUser(
          {
            id: String(session.id),
            name: session.displayName || session.username || 'Telegram user'
          },
          session.source === 'demo' ? 'demo' : 'telegram'
        );
        return;
      }
      if (allowDemoUser) {
        const demoUserId = getDemoUserId();
        if (demoUserId) {
          setUser({ id: demoUserId, name: 'Demo user' }, 'demo');
          return;
        }
      }
      clearUser();
    }

    function clearUser() {
      state.currentUser = null;
      state.authSource = 'none';
      elements.userAvatar.textContent = 'TG';
      elements.userName.textContent = 'Guest';
      elements.userId.textContent = allowDemoUser
        ? 'Connect via Telegram or set demo user'
        : 'Connect via Telegram';
      elements.userStatus.textContent = 'Guest';
      elements.bidUserBadge.textContent = 'Guest';
      elements.manualUserPanel.style.display = allowDemoUser ? 'grid' : 'none';
      sendRealtimeAuth();
    }

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
      } catch (error) {
        console.warn('Telegram init failed', error);
      }
    }

    function setUser(user, source) {
      state.currentUser = user;
      state.authSource = source;
      const initials = user.name ? user.name.slice(0, 2).toUpperCase() : 'TG';
      elements.userAvatar.textContent = initials;
      elements.userName.textContent = user.name || 'Telegram user';
      elements.userId.textContent = 'ID ' + user.id;
      elements.userStatus.textContent =
        source === 'telegram' ? 'Telegram' : source === 'demo' ? 'Demo' : 'Guest';
      elements.bidUserBadge.textContent = user.name || 'User ' + user.id;
      elements.manualUserPanel.style.display =
        allowDemoUser && source !== 'telegram' ? 'grid' : 'none';
      if (source === 'demo') {
        localStorage.setItem('demoUserId', user.id);
      }
      sendRealtimeAuth();
      loadBalance();
    }

    function startListTimer() {
      if (isRealtimeConnected()) return;
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
      watchAuction(auctionId);
      if (!isRealtimeConnected()) {
        state.timers.snapshot = setInterval(refreshSnapshot, 4000);
        state.timers.bids = setInterval(loadBids, 4500);
      }
    }

    function updateStatusChip(element, status) {
      element.className = 'chip';
      if (status === 'live') element.classList.add('subtle');
    }

    function applySnapshot(snapshot) {
      if (!snapshot) return;
      const roundIndex = snapshot.currentRoundIndex !== null ? snapshot.currentRoundIndex + 1 : '--';
      elements.detailRound.textContent = roundIndex;
      elements.detailLastBid.textContent = snapshot.lastBidAmount
        ? snapshot.lastBidAmount + ' ' + (snapshot.currency || '')
        : '--';
      const endsIn = formatCountdown(snapshot.roundEffectiveEndAt, snapshot.serverTime);
      elements.detailEnds.textContent = endsIn;
    }

    async function refreshSnapshot() {
      if (!state.currentAuction) return;
      try {
        const response = await apiFetch('/api/auctions/' + state.currentAuction._id + '/snapshot');
        const snapshot = await response.json();
        applySnapshot(snapshot);
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
      if (!state.currentUser) {
        elements.balanceNote.textContent = allowDemoUser
          ? 'Connect via Telegram or set a demo user.'
          : 'Connect via Telegram to view balance.';
        return;
      }
      try {
        const response = await apiFetch('/api/balance?currency=' + (state.currentAuction?.currency || 'USDT'));
        if (!response.ok) {
          elements.balanceNote.textContent = response.status === 401
            ? 'Authentication required.'
            : 'Balance unavailable';
          return;
        }
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
      unwatchAuction();
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
      if (!allowDemoUser) return;
      setUser({ id: value, name: 'Demo user' }, 'demo');
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

    initTelegram();
    connectRealtime();
    clearUser();
    loadUser().then(() => {
      loadAuctions();
      startListTimer();
    });
  </script>
</body>
</html>`;
}
