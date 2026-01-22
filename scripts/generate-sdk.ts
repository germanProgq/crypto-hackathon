#!/usr/bin/env tsx
/**
 * TypeScript SDK Generator
 * Generates a client SDK from the OpenAPI specification
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";

const SDK_DIR = resolve(import.meta.dirname ?? ".", "../sdk");
const SRC_DIR = resolve(SDK_DIR, "src");

// Ensure directories exist
if (!existsSync(SDK_DIR)) mkdirSync(SDK_DIR, { recursive: true });
if (!existsSync(SRC_DIR)) mkdirSync(SRC_DIR, { recursive: true });

// Generate package.json
writeFileSync(resolve(SDK_DIR, "package.json"), JSON.stringify({
  name: "@crypto-auction/sdk",
  version: "1.0.0",
  description: "TypeScript SDK for Crypto Auction Platform API",
  main: "dist/index.js",
  module: "dist/index.mjs",
  types: "dist/index.d.ts",
  scripts: { build: "tsc", clean: "rm -rf dist" },
  devDependencies: { typescript: "^5.4.0" },
  license: "MIT"
}, null, 2));

// Generate types.ts
writeFileSync(resolve(SRC_DIR, "types.ts"), `// Auto-generated types for Crypto Auction Platform SDK

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
`);

// Generate errors.ts
writeFileSync(resolve(SRC_DIR, "errors.ts"), `// Custom error classes for SDK

export class ApiError extends Error {
  constructor(public code: string, message: string, public statusCode = 500) {
    super(message);
    this.name = "ApiError";
  }
}

export class NetworkError extends Error {
  constructor(message: string, public cause?: Error) {
    super(message);
    this.name = "NetworkError";
  }
}

export class BidError extends ApiError {
  constructor(code: string, message: string) {
    super(code, message, 409);
    this.name = "BidError";
  }
}

export class TimeoutError extends Error {
  constructor(message = "Request timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}
`);

// Generate client.ts
writeFileSync(resolve(SRC_DIR, "client.ts"), `// HTTP Client for Crypto Auction Platform API
import type { Auction, Balance, Bid, PlaceBidRequest, PlaceBidResponse, LeaderboardEntry } from "./types.js";
import { ApiError, NetworkError } from "./errors.js";

export interface ClientConfig {
  baseUrl: string;
  token?: string;
  serviceToken?: string;
  timeout?: number;
}

export class CryptoAuctionClient {
  private baseUrl: string;
  private token?: string;
  private serviceToken?: string;
  private timeout: number;

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\\/$/, "");
    this.token = config.token;
    this.serviceToken = config.serviceToken;
    this.timeout = config.timeout ?? 30000;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.token) headers["Authorization"] = \`Bearer \${this.token}\`;
      if (this.serviceToken) headers["x-service-token"] = this.serviceToken;

      const response = await fetch(\`\${this.baseUrl}\${path}\`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        throw new ApiError(errorBody.code ?? "error", errorBody.error ?? "Request failed", response.status);
      }

      return response.json() as Promise<T>;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof ApiError) throw error;
      throw new NetworkError("Network request failed", error instanceof Error ? error : undefined);
    }
  }

  async listAuctions(params?: { status?: string; limit?: number }): Promise<{ auctions: Auction[] }> {
    const query = new URLSearchParams();
    if (params?.status) query.set("status", params.status);
    if (params?.limit) query.set("limit", params.limit.toString());
    return this.request("GET", \`/auctions?\${query}\`);
  }

  async getAuction(id: string): Promise<{ auction: Auction }> {
    return this.request("GET", \`/auctions/\${id}\`);
  }

  async placeBid(auctionId: string, data: Omit<PlaceBidRequest, "auctionId">): Promise<PlaceBidResponse> {
    return this.request("POST", \`/auctions/\${auctionId}/bids\`, data);
  }

  async getLeaderboard(auctionId: string, limit = 10): Promise<{ entries: LeaderboardEntry[] }> {
    return this.request("GET", \`/auctions/\${auctionId}/leaderboard?limit=\${limit}\`);
  }

  async getBalance(userId: string, currency: string): Promise<{ balance: Balance }> {
    return this.request("GET", \`/balance/\${userId}/\${currency}\`);
  }

  async healthCheck(): Promise<{ status: string }> {
    return this.request("GET", "/health/live");
  }
}
`);

// Generate websocket.ts
writeFileSync(resolve(SRC_DIR, "websocket.ts"), `// WebSocket Client for real-time updates
import type { WsBidPlaced } from "./types.js";
import { TimeoutError } from "./errors.js";

export interface WsClientConfig {
  url: string;
  token: string;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

type EventHandler<T> = (event: T) => void;

export class CryptoAuctionWsClient {
  private ws: WebSocket | null = null;
  private eventHandlers = new Map<string, Set<EventHandler<any>>>();
  private pendingRequests = new Map<string, { resolve: Function; reject: Function; timeout: NodeJS.Timeout }>();
  private rooms = new Set<string>();
  private config: WsClientConfig;

  constructor(config: WsClientConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.config.url);
      url.searchParams.set("token", this.config.token);
      this.ws = new WebSocket(url.toString());
      this.ws.onopen = () => { this.config.onConnect?.(); resolve(); };
      this.ws.onmessage = (e) => this.handleMessage(JSON.parse(e.data));
      this.ws.onclose = () => this.config.onDisconnect?.();
      this.ws.onerror = reject;
    });
  }

  disconnect(): void {
    this.ws?.close(1000, "client_disconnect");
  }

  async placeBid(params: { auctionId: string; amount: number; idempotencyKey?: string }): Promise<{ bidId: string; rank: number }> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pendingRequests.delete(requestId); reject(new TimeoutError()); }, 5000);
      this.pendingRequests.set(requestId, { resolve, reject, timeout });
      this.send({ type: "place_bid", requestId, ...params, idempotencyKey: params.idempotencyKey ?? crypto.randomUUID() });
    });
  }

  subscribeToAuction(auctionId: string): void {
    this.rooms.add(\`auction:\${auctionId}\`);
    this.send({ type: "join_room", room: \`auction:\${auctionId}\` });
  }

  onBidPlaced(callback: EventHandler<WsBidPlaced>): () => void {
    return this.on("bid_placed", callback);
  }

  on<T>(eventType: string, handler: EventHandler<T>): () => void {
    if (!this.eventHandlers.has(eventType)) this.eventHandlers.set(eventType, new Set());
    this.eventHandlers.get(eventType)!.add(handler);
    return () => this.eventHandlers.get(eventType)?.delete(handler);
  }

  private handleMessage(data: any): void {
    if (data.type === "bid_result" && data.requestId) {
      const pending = this.pendingRequests.get(data.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(data.requestId);
        data.success ? pending.resolve(data) : pending.reject(new Error(data.error));
        return;
      }
    }
    this.eventHandlers.get(data.type)?.forEach(h => h(data));
  }

  private send(data: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data));
  }
}
`);

// Generate index.ts
writeFileSync(resolve(SRC_DIR, "index.ts"), `// Crypto Auction Platform SDK
export { CryptoAuctionClient, type ClientConfig } from "./client.js";
export { CryptoAuctionWsClient, type WsClientConfig } from "./websocket.js";
export * from "./types.js";
export * from "./errors.js";

import { CryptoAuctionClient, type ClientConfig } from "./client.js";
import { CryptoAuctionWsClient, type WsClientConfig } from "./websocket.js";

export function createClient(config: ClientConfig) { return new CryptoAuctionClient(config); }
export function createWsClient(config: WsClientConfig) { return new CryptoAuctionWsClient(config); }
export default { createClient, createWsClient, CryptoAuctionClient, CryptoAuctionWsClient };
`);

// Generate tsconfig.json
writeFileSync(resolve(SDK_DIR, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    declaration: true,
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    outDir: "./dist"
  },
  include: ["src/**/*"],
  exclude: ["node_modules", "dist"]
}, null, 2));

// Generate README.md
writeFileSync(resolve(SDK_DIR, "README.md"), `# @crypto-auction/sdk

TypeScript SDK for Crypto Auction Platform API.

## Installation

\`\`\`bash
npm install @crypto-auction/sdk
\`\`\`

## Quick Start

\`\`\`typescript
import { createClient, createWsClient } from '@crypto-auction/sdk';

// HTTP Client
const client = createClient({
  baseUrl: 'http://localhost:4001',
  serviceToken: 'your-token'
});

const { auctions } = await client.listAuctions({ status: 'live' });
const result = await client.placeBid('auction-id', { amount: 100, idempotencyKey: crypto.randomUUID() });

// WebSocket Client (30K+ RPS)
const ws = createWsClient({ url: 'ws://localhost:4005/ws', token: 'your-jwt' });
await ws.connect();
ws.subscribeToAuction('auction-id');
ws.onBidPlaced((event) => console.log(\`New bid: \${event.amount}\`));
const bidResult = await ws.placeBid({ auctionId: 'auction-id', amount: 150 });
\`\`\`

## License

MIT
`);

console.log("✅ SDK generated successfully in ./sdk/");
console.log("   Run 'cd sdk && npm install && npm run build' to build");
