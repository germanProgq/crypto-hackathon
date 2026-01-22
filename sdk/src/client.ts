// HTTP Client for Crypto Auction Platform API
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
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.token = config.token;
    this.serviceToken = config.serviceToken;
    this.timeout = config.timeout ?? 30000;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
      if (this.serviceToken) headers["x-service-token"] = this.serviceToken;

      const response = await fetch(`${this.baseUrl}${path}`, {
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
    return this.request("GET", `/auctions?${query}`);
  }

  async getAuction(id: string): Promise<{ auction: Auction }> {
    return this.request("GET", `/auctions/${id}`);
  }

  async placeBid(auctionId: string, data: Omit<PlaceBidRequest, "auctionId">): Promise<PlaceBidResponse> {
    return this.request("POST", `/auctions/${auctionId}/bids`, data);
  }

  async getLeaderboard(auctionId: string, limit = 10): Promise<{ entries: LeaderboardEntry[] }> {
    return this.request("GET", `/auctions/${auctionId}/leaderboard?limit=${limit}`);
  }

  async getBalance(userId: string, currency: string): Promise<{ balance: Balance }> {
    return this.request("GET", `/balance/${userId}/${currency}`);
  }

  async healthCheck(): Promise<{ status: string }> {
    return this.request("GET", "/health/live");
  }
}
