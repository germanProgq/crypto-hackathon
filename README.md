# Crypto Hack Auction Platform

Telegram-native, multi-round auctions with crypto balances. The system is built as a ledger-first, concurrency-safe engine that matches Telegram Gift Auction mechanics: one active bid per auction, deterministic ranking, and automatic bid carry-over across rounds.

## Key mechanics

- Multi-round allocation: each round selects winners, non-winners carry forward.
- Anti-sniping: bids in the final window extend the round with hard caps.
- Ledger-first balances: holds, captures, and releases are append-only entries.
- Idempotency: all money-moving operations use idempotency keys.

## Architecture

Services and ports (default docker-compose):

- Auction engine: `http://localhost:4001`
- Ledger: `http://localhost:4002`
- Crypto gateway: `http://localhost:4003`
- Bot: `http://localhost:4004`
- Web UI: `http://localhost:4005`
- Workers: `http://localhost:4006`
- Signer: `http://localhost:4007`

The web UI is a minimal operator and demo interface that lists auctions, shows auction state, allows bids, and shows balances.

## Setup

```bash
npm install
```

Local dev with Docker (all services):

```bash
docker compose up -d
```

Build:

```bash
npm run build
```

Tests:

```bash
npm test
```

## API examples

Auction engine:

```bash
curl -s -X POST http://localhost:4001/auctions \
  -H 'content-type: application/json' \
  -d '{"title":"Demo","currency":"USDT","startsAt":"2025-01-01T00:00:00Z","endsAt":"2025-01-01T00:10:00Z","rounds":[{"index":0,"allocationSize":3,"startAt":"2025-01-01T00:00:00Z","endAt":"2025-01-01T00:05:00Z","antiSniping":{"triggerWindowSeconds":10,"extensionSeconds":30,"maxExtensions":2}}]}'
```

```bash
curl -s -X POST http://localhost:4001/auctions/<auctionId>/bids \
  -H 'content-type: application/json' \
  -d '{"userId":"user-1","amount":120,"idempotencyKey":"bid-1"}'
```

Ledger:

```bash
curl -s -X POST http://localhost:4002/ledger/entries \
  -H 'content-type: application/json' \
  -d '{"userId":"user-1","amount":500,"currency":"USDT","idempotencyKey":"dep-1","entryType":"deposit_confirmed"}'
```

```bash
curl -s http://localhost:4002/ledger/user-1/balance?currency=USDT
```

Crypto gateway (admin token required for authorize/allowlist):

```bash
curl -s -X POST http://localhost:4003/crypto/withdrawals/request \
  -H 'content-type: application/json' \
  -d '{"userId":"user-1","currency":"USDT","amount":10,"destinationAddress":"DEMO","idempotencyKey":"wd-1"}'
```

```bash
curl -s -X POST http://localhost:4003/crypto/withdrawals/allowlist \
  -H 'content-type: application/json' \
  -H 'x-admin-token: dev-admin-token' \
  -d '{"userId":"user-1","currency":"USDT","address":"DEMO","label":"test"}'
```

## Load testing

Scripts are in `scripts/load/`. All scripts use HTTP and assume the services are running (including workers).

Run the full suite:

```bash
npm run load:all
```

Individual scripts:

```bash
npm run load:bot
npm run load:stress
npm run load:anti-sniping
npm run load:reconcile
```

Recommended for load testing:

- Increase rate limits for local testing by setting `RATE_LIMIT_IP_PER_SECOND` and `RATE_LIMIT_USER_PER_SECOND` in `docker-compose.yml`.
- Use unique IPs via `x-forwarded-for` (scripts already set this header).

## Load test results and reconciliation

Results from a local run are stored in `docs/load-testing.md`.

Summary (local run 2026-01-12):

- Bot simulation: 80 bids, p50 17.93ms, p95 129.46ms, errors 0.
- Stress test: 120 bids, p50 6.03ms, p95 981.31ms, errors 0.
- Anti-sniping: extensionCount 1, extensionMs 12000, request 24.18ms.
- Reconciliation: 20 users, issues 0.

## Assumptions and decisions

- One active bid per auction; upgrading a bid replaces the previous active bid.
- Non-winners carry forward; winners are removed from the active set.
- Ranking tie-breakers: amount desc, createdAt asc, bid id asc.
- Auction and round state transitions are handled by workers.

## Notes

- Web UI: `http://localhost:4005`
- Signer default token: `dev-signer-token`
- Crypto admin token: `dev-admin-token`
