// WebSocket Client for real-time updates
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
    this.rooms.add(`auction:${auctionId}`);
    this.send({ type: "join_room", room: `auction:${auctionId}` });
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
