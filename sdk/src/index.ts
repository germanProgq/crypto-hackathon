// Crypto Auction Platform SDK
export { CryptoAuctionClient, type ClientConfig } from "./client.js";
export { CryptoAuctionWsClient, type WsClientConfig } from "./websocket.js";
export * from "./types.js";
export * from "./errors.js";

import { CryptoAuctionClient, type ClientConfig } from "./client.js";
import { CryptoAuctionWsClient, type WsClientConfig } from "./websocket.js";

export function createClient(config: ClientConfig) { return new CryptoAuctionClient(config); }
export function createWsClient(config: WsClientConfig) { return new CryptoAuctionWsClient(config); }
export default { createClient, createWsClient, CryptoAuctionClient, CryptoAuctionWsClient };
