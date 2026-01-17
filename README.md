# Crypto Hack Auction Platform

Telegram-native, multi-round auctions with crypto balances and settlement. The system is built as a
ledger-first, concurrency-safe engine that mirrors Telegram Gift Auction mechanics: one active bid
per auction, deterministic ranking, and automatic bid carry-over across rounds.

## Contents
- Overview
- Core mechanics
- Architecture
- Services and ports
- Data stores and external dependencies
- Key flows
- Auth and security
- Rate limiting and safety controls
- Caching and realtime
- Data retention
- Configuration (env)
- Running locally
- Mocking external crypto services
- Observability
- Load testing
- Troubleshooting
- Reference docs

## Overview
This repo ships a full auction stack composed of multiple Node services. The auction engine and
ledger are designed to be deterministic and idempotent. The crypto gateway bridges deposits and
withdrawals to external observers and signers. A minimal web UI and Telegram bot expose the
experience to users.

The codebase favors explicit validation, strict schemas, and careful concurrency controls:
- All money-moving operations are append-only ledger entries.
- All client-visible state is derived from canonical Mongo records and cached safely in Redis.
- All state transitions are idempotent and safe to retry.

## Core mechanics
- Multi-round allocation: each round selects winners, non-winners carry forward.
- Anti-sniping: bids in the final window extend the round with hard caps.
- Ledger-first balances: holds, captures, and releases are append-only entries.
- Idempotency: all money-moving operations use idempotency keys.
- Deterministic ranking: amount desc, createdAt asc, bid id asc.

## Architecture
The system is split into specialized services so that each domain can scale independently and so
that failures are isolated.

### Services and responsibilities
- Auction engine: auction CRUD, bids, round snapshots, ranking caches.
- Ledger: balances, holds, and withdrawal ledger entries.
- Crypto gateway: deposit attribution, withdrawal lifecycle, safety checks, and broadcasting.
- Workers: auction round progression and settlement finalization loops.
- Web: web UI, HTTP API, and realtime WebSocket updates.
- Bot: Telegram bot handlers and notification delivery.
- Signer: signs withdrawal payloads (local keys or KMS).
- Mock RPC: network mock for observer + signer endpoints.

## Services and ports (default docker-compose)
- Auction engine: http://localhost:4001
- Ledger: http://localhost:4002
- Crypto gateway: http://localhost:4003
- Bot: http://localhost:4004
- Web UI: http://localhost:4005
- Workers: http://localhost:4006
- Signer: http://localhost:4007
- Mock RPC: http://localhost:9000

## Data stores and external dependencies
Data stores:
- MongoDB: canonical source of truth for auctions, bids, ledger entries, withdrawals, and
  notifications.
- Redis: realtime pub/sub, rate limiting, locks, ranking caches, and short-lived snapshots.

External dependencies:
- Telegram: WebApp init data for user auth, bot API for notifications.
- Crypto observer: external service for inbound transaction observations.
- Crypto signer: external or internal service that signs withdrawal payloads.

## Key flows

### Auction creation
- The auction engine validates the full auction configuration, including timing rules.
- Auctions are stored in MongoDB and round state documents are created.
- Realtime events are published to update web clients.

### Bid placement
- Bid request validates auth, amount, and idempotency key.
- Bid service uses Redis rate limits and a distributed lock to prevent race conditions.
- A hold is placed in the ledger for the bid amount.
- Bid is stored and ranking is updated in Redis sorted sets.
- Realtime event is emitted for auction bids and active bids per user.

### Round progression and settlement (workers)
- Auction round scheduler moves rounds from scheduled to live to closed based on time and
  anti-sniping rules.
- Round finalizer settles a closed round by:
  - Capturing holds for winners.
  - Releasing holds for non-winners.
  - Storing round results.
  - Publishing realtime events.

### Deposits (crypto gateway)
- Observer client lists transactions for watched addresses.
- Wallet strategy maps observed transactions to users via:
  - address_pool, memo_tag, or address_per_user strategy.
- Confirmations are tracked until the required threshold is met.
- Ledger entry is created for confirmed deposits.

### Withdrawals (crypto gateway)
- Request is validated, idempotent, and safety-checked.
- Safety checks include allowlists, cooldowns, per-hour/day limits, and anomaly detection.
- Admin approval is required for withdrawals that are not auto-authorized.
- Approved withdrawals are signed, broadcast, and confirmed.
- Ledger entries are created for request, broadcast, and confirm stages.

### Realtime updates
- Realtime events are published to Redis pub/sub.
- Web service fans out updates to WebSocket clients.
- If pub/sub is unavailable, the web service falls back to periodic resyncs.

## Auth and security
Core auth (auction-engine, ledger, crypto-gateway):
- Service token: `x-service-token: <CORE_API_TOKEN>` or `Authorization: Bearer <CORE_API_TOKEN>`.
- Telegram init data: `x-telegram-init-data`, `x-telegram-web-app-data`, or `Authorization: TMA`.
- Demo user (non-production only): `x-demo-user-id: <userId>`.

Admin auth (crypto-gateway admin endpoints):
- `x-admin-token: <CRYPTO_ADMIN_TOKEN>`.

Signer auth:
- `x-signer-token: <SIGNER_API_TOKEN>`.
- IP allowlist enforced by `SIGNER_ALLOWED_IPS` (defaults to private networks).

Web CSRF/CORS:
- Unsafe methods require a valid `Origin` header and must match `WEB_ALLOWED_ORIGINS`.
- Disallowed origins return `403` with `csrf_failed` or `cors_rejected`.

## Rate limiting and safety controls
Bidding rate limits:
- Per-user, per-user-per-auction, and per-IP limits are enforced.
- Redis is used for shared limits; a local fallback is used when Redis is unavailable.

Withdrawal safety checks:
- Allowlist requirement (optional).
- Cooldown between withdrawals per user.
- Max withdrawals per hour and per day.
- Daily amount limits.
- Anomaly detection using historical averages.

## Caching and realtime
- Auction list cache is stored in Redis with short TTL.
- Auction snapshot and round state caches use Redis + in-process TTL caches.
- Bid ranking is stored in Redis sorted sets for fast leaderboard reads.
- Web realtime uses pub/sub with periodic resyncs as a safety net.

## Data retention
Retention is controlled via TTL fields and background cleanup:
- Bids: `RETENTION_BIDS_DAYS` (default 90).
- Ledger entries: `RETENTION_LEDGER_DAYS` (default 365).
- Notification queue: `RETENTION_NOTIFICATIONS_DAYS` (default 30).

## Configuration (env)
The config is validated at startup; missing required values cause a hard error.

### Core service settings
- `NODE_ENV`: development | test | production (default development)
- `SERVICE_NAME`: name of the service
- `HTTP_HOST`: host to bind (default 0.0.0.0)
- `HTTP_PORT`: port to bind
- `LOG_LEVEL`: fatal | error | warn | info | debug | trace (default info)

### Storage
- `MONGO_URI`: MongoDB connection string
- `MONGO_DB`: database name
- `MONGO_POOL_MAX`: connection pool size
- `REDIS_URL`: Redis connection string
- `REDIS_PREFIX`: Redis key prefix

### Auth tokens
- `CORE_API_TOKEN`: required for auction-engine, ledger, crypto-gateway
- `CRYPTO_ADMIN_TOKEN`: admin actions in crypto gateway
- `SIGNER_API_TOKEN`: signer auth token
- `CRYPTO_SIGNER_TOKEN`: token used by crypto gateway when calling signer

### Rate limits
- `RATE_LIMIT_USER_PER_SECOND`: per-user (default 5)
- `RATE_LIMIT_AUCTION_USER_PER_SECOND`: per-user-per-auction (default 3)
- `RATE_LIMIT_IP_PER_SECOND`: per-IP (default 20)

### Retention
- `RETENTION_BIDS_DAYS`: TTL for bids
- `RETENTION_LEDGER_DAYS`: TTL for ledger entries
- `RETENTION_NOTIFICATIONS_DAYS`: TTL for notification queue

### I18n
- `I18N_DEFAULT_LOCALE`: default locale (en or ru)
- `I18N_SUPPORTED_LOCALES`: comma-separated locale list

### Telegram
- `TELEGRAM_BOT_TOKEN`: bot token (required for Telegram auth)
- `TELEGRAM_API_BASE`: Telegram API base URL
- `TELEGRAM_WEBAPP_MAX_AGE_SECONDS`: max age for init data

### Web
- `WEB_ALLOWED_ORIGINS`: comma-separated list of allowed origins
- `WEB_ALLOW_DEMO_USER`: enable demo auth in non-production

### Crypto general
- `CRYPTO_SUPPORTED_CURRENCIES`: comma-separated currency list
- `CRYPTO_WALLET_STRATEGY`: address_pool | memo_tag | address_per_user
- `CRYPTO_OBSERVER_URL`: observer base URL, empty or `mock`
- `CRYPTO_SIGNER_URL`: signer base URL, empty or `mock`
- `CRYPTO_SIGNER_TOKEN`: token required by signer
- `CRYPTO_ADMIN_TOKEN`: admin token for allowlist and authorization
- `CRYPTO_USD_RATES`: currency rates, e.g. `USDT:1,BTC:65000`

### Crypto deposit
- `CRYPTO_DEPOSIT_CONFIRMATIONS`: required confirmations (default 6)
- `CRYPTO_DEPOSIT_POLL_INTERVAL_MS`: polling interval
- `CRYPTO_DEPOSIT_ADDRESS_POOL`: comma list of `CUR:ADDRESS` entries
- `CRYPTO_MEMO_DEPOSIT_ADDRESS`: `CUR:ADDRESS` for memo_tag
- `CRYPTO_HD_MASTER_PUBLIC_KEY`: `CUR:XPUB` for address_per_user
- `CRYPTO_HD_DERIVATION_PATH_PREFIX`: derivation prefix (default m/0)

### Crypto withdrawal
- `CRYPTO_HOT_WALLET_ADDRESS`: `CUR:ADDRESS` entries
- `CRYPTO_WITHDRAWAL_CONFIRMATIONS`: confirmations required (default 6)
- `CRYPTO_WITHDRAWAL_POLL_INTERVAL_MS`: confirm polling interval
- `CRYPTO_WITHDRAWAL_BROADCAST_INTERVAL_MS`: broadcast polling interval
- `CRYPTO_WITHDRAWAL_MIN_AMOUNT`: minimum withdrawal
- `CRYPTO_WITHDRAWAL_MAX_AMOUNT`: maximum withdrawal
- `CRYPTO_WITHDRAWAL_DAILY_LIMIT`: per-user daily limit
- `CRYPTO_WITHDRAWAL_COOLDOWN_SECONDS`: per-user cooldown
- `CRYPTO_WITHDRAWAL_ALLOWLIST_REQUIRED`: require allowlist
- `CRYPTO_WITHDRAWAL_AUTO_AUTHORIZE_MAX_AMOUNT`: auto-approve threshold
- `CRYPTO_WITHDRAWAL_ANOMALY_MULTIPLIER`: anomaly detection multiplier
- `CRYPTO_WITHDRAWAL_MAX_REQUESTS_PER_HOUR`: rate limit
- `CRYPTO_WITHDRAWAL_MAX_REQUESTS_PER_DAY`: rate limit

### Signer
- `SIGNER_ALLOWED_IPS`: comma-separated allowlist (defaults to private ranges)
- `SIGNER_PRIVATE_KEY`: base64 key for local signing
- `SIGNER_PRIVATE_KEYS`: additional keys for multisig
- `SIGNER_MULTISIG_THRESHOLD`: required signatures
- `SIGNER_KMS_URL`: optional KMS endpoint
- `SIGNER_KMS_KEY_ID`: KMS key identifier
- `SIGNER_KMS_TOKEN`: KMS auth token

## Running locally
Prerequisites:
- Node.js 20
- Docker

Install deps:
```bash
npm install
```

Start all services with Docker:
```bash
docker compose up -d
```

Build and tests:
```bash
npm run build
npm test
```

Optional local dev without Docker (run services individually):
```bash
npm run dev:auction-engine
npm run dev:ledger
npm run dev:crypto-gateway
npm run dev:workers
npm run dev:web
npm run dev:bot
npm run dev:signer
npm run dev:mock-rpc
```

### Minimal local .env example
```
CORE_API_TOKEN=dev-core-token
CRYPTO_ADMIN_TOKEN=dev-admin-token
SIGNER_API_TOKEN=dev-signer-token
CRYPTO_SIGNER_TOKEN=dev-signer-token
CRYPTO_SUPPORTED_CURRENCIES=USDT
CRYPTO_USD_RATES=USDT:1
CRYPTO_WALLET_STRATEGY=memo_tag
CRYPTO_MEMO_DEPOSIT_ADDRESS=USDT:DEMO_DEPOSIT_ADDRESS
CRYPTO_HOT_WALLET_ADDRESS=USDT:DEMO_HOT_WALLET
CRYPTO_OBSERVER_URL=mock
CRYPTO_SIGNER_URL=mock
WEB_ALLOW_DEMO_USER=true
```

## Mocking external crypto services
In-process mocks:
- Set `CRYPTO_OBSERVER_URL=mock` and/or `CRYPTO_SIGNER_URL=mock`.
- Withdrawals auto-confirm.
- Deposits are disabled without a real observer.

Networked mock (Mock RPC service):
- Run `mock-rpc` service and set:
  - `CRYPTO_OBSERVER_URL=http://mock-rpc:9000`
  - `CRYPTO_SIGNER_URL=http://mock-rpc:9000`
- Mint a deposit:
```
POST http://localhost:9000/mock/observer/mint
{ "currency": "USDT", "address": "ADDR1", "amount": 1 }
```
- Advance confirmations:
```
POST http://localhost:9000/mock/observer/mine
{ "blocks": 1 }
```

## Observability
Every service exposes:
- `GET /health/live`
- `GET /health/ready` (includes Redis and Mongo checks where applicable)
- `GET /metrics` (Prometheus)

Logs are JSON structured and include service name and environment.

## Load testing
Scripts are in `scripts/load/` and require all services to be running.

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

Interactive performance CLI:
```bash
npm run load:perf
```

## Troubleshooting
- `CORE_API_TOKEN must be set for core services.`
  - Set `CORE_API_TOKEN` in your environment or `.env`.
- `CRYPTO_USD_RATES must include rates for: ...`
  - Set `CRYPTO_USD_RATES`, e.g. `USDT:1`.
- `Deposit address pool exhausted.`
  - Provide `CRYPTO_DEPOSIT_ADDRESS_POOL` or switch to `memo_tag` or `address_per_user`.
- `CRYPTO_SIGNER_TOKEN must be set for crypto-gateway.`
  - Set `CRYPTO_SIGNER_TOKEN` (and `SIGNER_API_TOKEN` for signer).
- `Signer token required` or `IP not allowed.`
  - Check `SIGNER_API_TOKEN` and `SIGNER_ALLOWED_IPS`.
- Observer connection refused.
  - Verify `CRYPTO_OBSERVER_URL` or switch to `mock`/`mock-rpc`.

## Reference docs
- Full API and WebSocket request reference: `requests.md`
- Load testing notes: `docs/load-testing.md`
