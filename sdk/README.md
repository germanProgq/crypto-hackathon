# @crypto-auction/sdk

TypeScript SDK for Crypto Auction Platform API.

## Installation

```bash
npm install @crypto-auction/sdk
```

## Quick Start

```typescript
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
ws.onBidPlaced((event) => console.log(`New bid: ${event.amount}`));
const bidResult = await ws.placeBid({ auctionId: 'auction-id', amount: 150 });
```

## License

MIT
