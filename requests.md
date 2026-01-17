# Request Reference

This document lists all HTTP and WebSocket requests exposed by the services in this repo, including
inputs, outputs, auth requirements, and common error cases.

## Service map (default Docker ports)
- Auction engine: http://127.0.0.1:4001
- Ledger: http://127.0.0.1:4002
- Crypto gateway: http://127.0.0.1:4003
- Bot: http://127.0.0.1:4004
- Web: http://127.0.0.1:4005
- Workers: http://127.0.0.1:4006
- Signer: http://127.0.0.1:4007
- Mock RPC: http://127.0.0.1:9000

## Conventions
- JSON requests/responses use `Content-Type: application/json`.
- All timestamps are ISO 8601 strings in responses.
- Object IDs are 24 hex character strings unless otherwise noted.
- Error responses generally look like:
  - `{ "error": "code", "message": "Human readable message" }`
- Idempotency:
  - Many write operations take `idempotencyKey`. If a request is retried with the same key and the
    same payload, the previous result is returned. A different payload with the same key returns 409.

## Authentication
Core auth (auction-engine, ledger, crypto-gateway):
- Service token:
  - `x-service-token: <CORE_API_TOKEN>` or `Authorization: Bearer <CORE_API_TOKEN>`
- User token (Telegram):
  - `x-telegram-init-data: <initData>` or `x-telegram-web-app-data: <initData>` or
    `Authorization: TMA <initData>`
- Demo user (non-production only, when enabled):
  - `x-demo-user-id: <userId>`

Crypto admin auth (crypto-gateway admin endpoints):
- `x-admin-token: <CRYPTO_ADMIN_TOKEN>`

Signer auth:
- `x-signer-token: <SIGNER_API_TOKEN>`
- IP allowlist enforced (see `SIGNER_ALLOWED_IPS`).

Web CSRF/CORS:
- Unsafe methods (POST/PUT/PATCH/DELETE) require `Origin` to be present and allowed.
- Requests with missing/invalid Origin return `403` with `error: "csrf_failed"` or `cors_rejected`.

## Common endpoints (all services)
### GET /health/live
Response 200:
```
{ "status": "ok", "service": "service-name", "timestamp": "2026-01-01T00:00:00.000Z" }
```

### GET /health/ready
Response 200 (or 503 if any dependency fails):
```
{
  "status": "ok" | "degraded",
  "service": "service-name",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "checks": [ { "name": "mongo|redis|...", "ok": true, "detail": "..." } ]
}
```

### GET /metrics
Prometheus metrics text.

---

## Auction Engine (4001)
Auth:
- Read endpoints: core auth (service token or user auth).
- Create auctions: service token required.

### GET /auctions
Query:
- `status`: `active | upcoming | closed` (default `active`)
- `limit`: integer 1..100
- `cursor`: `"<ISO time>|<objectId>"`

Response 200:
```
{
  "items": [AuctionSummary],
  "nextCursor": "2026-01-01T00:00:00.000Z|<objectId>" | null
}
```

### POST /auctions
Auth: service token required.

Body (strict):
```
{
  "title": "string",
  "description": "string?",
  "currency": "string",
  "startsAt": "ISO date or number",
  "endsAt": "ISO date or number",
  "rounds": [
    {
      "index": 0,
      "allocationSize": 5,
      "startAt": "ISO date or number",
      "endAt": "ISO date or number",
      "antiSniping": {
        "triggerWindowSeconds": 10,
        "extensionSeconds": 15,
        "maxExtensions": 3
      }
    }
  ]
}
```

Response 201:
```
{ "auction": Auction }
```

### GET /auctions/:auctionId
Auth: core auth required.

Response 200:
```
{ "auction": Auction }
```

### GET /auctions/:auctionId/snapshot
Auth: core auth required.

Response 200:
```
{ "snapshot": AuctionSnapshot }
```

### GET /auctions/:auctionId/rounds/:roundIndex/state
Auth: core auth required.

Response 200:
```
{ "state": RoundStateResponse }
```

### POST /auctions/:auctionId/bids
Auth: core auth required.

Body (strict):
```
{
  "userId": "string?",          // only for service auth
  "amount": 123.45,
  "idempotencyKey": "string",
  "metadata": { "any": "object" },
  "audit": {
    "requestId": "string?",
    "source": "string?",
    "ip": "string?",
    "userAgent": "string?",
    "actorId": "string?"
  }
}
```

Response 200:
```
{
  "bid": Bid,
  "balance": LedgerBalance,
  "roundState": RoundState,
  "extended": true|false,
  "idempotent": true|false
}
```

### Auction Engine schemas
AuctionSummary:
- `_id`: string
- `title`: string
- `description`: string | null
- `status`: `draft | live | closed`
- `currency`: string
- `startsAt`: ISO string
- `endsAt`: ISO string
- `roundCount`: number
- `currentRoundIndex`: number | null
- `roundStatus`: `scheduled | live | closed` | null
- `roundEffectiveEndAt`: ISO string | null
- `roundLastBidAt`: ISO string | null
- `lastBidAmount`: number | null

Auction:
- `_id`: string
- `title`: string
- `description`: string | null
- `status`: `draft | live | closed`
- `currency`: string
- `startsAt`: ISO string
- `endsAt`: ISO string
- `rounds`: array of `AuctionRoundConfig`
- `currentRoundIndex`: number | null
- `roundStatus`: `scheduled | live | closed` | null
- `roundEffectiveEndAt`: ISO string | null
- `roundLastBidAt`: ISO string | null
- `lastBidAmount`: number | null
- `createdAt`: ISO string
- `updatedAt`: ISO string

AuctionRoundConfig:
- `index`: number
- `allocationSize`: number
- `startAt`: ISO string
- `endAt`: ISO string
- `antiSniping.triggerWindowSeconds`: number
- `antiSniping.extensionSeconds`: number
- `antiSniping.maxExtensions`: number

AuctionSnapshot:
- `auctionId`: string
- `status`: `draft | live | closed`
- `title`: string
- `currency`: string
- `currentRoundIndex`: number | null
- `roundStatus`: `scheduled | live | closed` | null
- `roundEffectiveEndAt`: ISO string | null
- `roundLastBidAt`: ISO string | null
- `updatedAt`: ISO string
- `lastBidAmount`: number | null

RoundState (bid response):
- `status`: `scheduled | live | closed`
- `roundIndex`: number
- `scheduledStartAt`: ISO string
- `scheduledEndAt`: ISO string
- `effectiveEndAt`: ISO string
- `extensionCount`: number
- `lastBidAt`: ISO string | null

RoundStateDetail (round state endpoint):
- All fields from `RoundState`, plus:
- `startedAt`: ISO string | null
- `closedAt`: ISO string | null
- `allocationSize`: number

RoundStateResponse:
- All fields from `RoundStateDetail`, plus:
- `timers.now`: ISO string
- `timers.untilStartMs`: number
- `timers.untilScheduledEndMs`: number
- `timers.untilEffectiveEndMs`: number

Bid:
- `_id`: string
- `auctionId`: string
- `roundIndex`: number | null
- `userId`: string
- `amount`: number
- `createdAt`: ISO string
- `idempotencyKey`: string
- `active`: boolean

### Auction Engine error codes
- `invalid_request`, `auction_not_found`, `round_not_found`
- Bid errors: `auction_not_found`, `auction_not_live`, `round_not_found`, `round_not_live`,
  `bid_too_low`, `round_locked`, `rate_limited`, `idempotency_conflict`, `invalid_request`
- Ledger errors may surface on bid placement (see Ledger section).

---

## Ledger (4002)
Auth:
- GET endpoints: core auth.
- POST endpoints: service token required.

### GET /ledger/:userId/balance
Query:
- `currency` (required)

Response 200:
```
LedgerBalance
```

### GET /ledger/:userId/history
Query:
- `currency` (required)
- `limit` (optional, default 50, max 200)
- `before` (optional ISO date)

Response 200:
```
[LedgerEntry]
```

### GET /ledger/:userId/reconcile
Query:
- `currency` (required)

Response 200:
```
LedgerReconciliation
```

### POST /ledger/entries
Body:
```
{
  "userId": "string",
  "entryType": "deposit_confirmed|withdrawal_requested|withdrawal_broadcasted|withdrawal_confirmed|withdrawal_failed",
  "amount": 123.45,
  "currency": "string",
  "idempotencyKey": "string",
  "withdrawalId": "string?",
  "metadata": { "any": "object" },
  "audit": { "requestId": "...?", "source": "...?", "ip": "...?", "userAgent": "...?", "actorId": "...?" }
}
```

Response 200:
```
{ "entry": LedgerEntry, "balance": LedgerBalance }
```

### POST /ledger/holds
Body:
```
{
  "userId": "string",
  "amount": 123.45,
  "currency": "string",
  "holdId": "string",
  "idempotencyKey": "string",
  "metadata": { "any": "object" },
  "audit": { ... }
}
```

Response 200:
```
{ "entry": LedgerEntry, "balance": LedgerBalance }
```

### POST /ledger/holds/release
Same body as `/ledger/holds`.

Response 200:
```
{ "entry": LedgerEntry, "balance": LedgerBalance }
```

### POST /ledger/holds/capture
Same body as `/ledger/holds`.

Response 200:
```
{ "entry": LedgerEntry, "balance": LedgerBalance }
```

### POST /ledger/withdrawals/request
Body:
```
{
  "userId": "string",
  "amount": 123.45,
  "currency": "string",
  "withdrawalId": "string",
  "idempotencyKey": "string",
  "metadata": { "any": "object" },
  "audit": { ... }
}
```

Response 200:
```
{ "entry": LedgerEntry, "balance": LedgerBalance }
```

### POST /ledger/withdrawals/broadcast
Same body as `/ledger/withdrawals/request`.

Response 200:
```
{ "entry": LedgerEntry }
```

### POST /ledger/withdrawals/confirm
Same body as `/ledger/withdrawals/request`.

Response 200:
```
{ "entry": LedgerEntry, "balance": LedgerBalance }
```

### POST /ledger/withdrawals/fail
Same body as `/ledger/withdrawals/request`.

Response 200:
```
{ "entry": LedgerEntry, "balance": LedgerBalance }
```

### Ledger schemas
LedgerBalance:
- `userId`: string
- `currency`: string
- `available`: number
- `held`: number
- `spent`: number
- `current`: number
- `asOf`: ISO string

LedgerEntry:
- `_id`: string
- `userId`: string
- `entryType`: `deposit_confirmed | hold_created | hold_released | hold_captured |
  withdrawal_requested | withdrawal_broadcasted | withdrawal_confirmed | withdrawal_failed`
- `amount`: number
- `currency`: string
- `createdAt`: ISO string
- `idempotencyKey`: string
- `expiresAt`: ISO string | null
- `metadata`: object | null
- `audit`: object | null

LedgerReconciliation:
- `userId`: string
- `currency`: string
- `totals`: object keyed by entryType
- `balance`: LedgerBalance
- `expectedCurrent`: number
- `balanceMatches`: boolean
- `issues`: string[]

### Ledger error codes
- `invalid_request`, `invalid_amount`, `insufficient_funds`, `idempotency_conflict`
- `hold_exists`, `hold_not_found`, `hold_resolved`
- `withdrawal_exists`, `withdrawal_not_found`, `withdrawal_resolved`

---

## Crypto Gateway (4003)
Auth:
- Core auth for user routes.
- Admin token required for admin routes.

### GET /crypto/:userId/deposit-address
Auth: core auth required.
Query:
- `currency` (required)

Response 200:
```
DepositDestination
```

### POST /crypto/withdrawals/request
Auth: core auth required.

Body:
```
{
  "userId": "string?",             // only for service auth
  "currency": "string",
  "amount": 123.45,
  "destinationAddress": "string",
  "memo": "string?",
  "idempotencyKey": "string"
}
```

Response 200:
```
{
  "withdrawal": CryptoWithdrawal,
  "balance": LedgerBalance,
  "decision": "approve|review|reject",
  "flags": [ "string" ],
  "violations": [ "string" ]
}
```

### POST /crypto/withdrawals/:withdrawalId/authorize
Auth: admin token required.

Body:
```
{ "actorId": "string?" }
```

Response 200:
```
{ "withdrawal": CryptoWithdrawal }
```

### GET /crypto/withdrawals/:withdrawalId
Auth: admin token required.

Response 200:
```
{ "withdrawal": CryptoWithdrawal }
```

### POST /crypto/withdrawals/allowlist
Auth: admin token required.

Body:
```
{
  "userId": "string",
  "currency": "string",
  "address": "string",
  "label": "string?"
}
```

Response 200:
```
{ "allowlist": CryptoWithdrawalAllowlist }
```

### Crypto Gateway schemas
DepositDestination:
- `userId`: string
- `currency`: string
- `address`: string
- `memo`: string | null
- `strategy`: `address_pool | memo_tag | address_per_user`

CryptoWithdrawal:
- `_id`: string
- `userId`: string
- `currency`: string
- `amount`: number
- `destinationAddress`: string
- `memo`: string | null
- `status`: `requested | authorized | broadcasted | confirmed | failed`
- `idempotencyKey`: string
- `requestedAt`: ISO string
- `authorizedAt`: ISO string | null
- `broadcastedAt`: ISO string | null
- `confirmedAt`: ISO string | null
- `failedAt`: ISO string | null
- `txId`: string | null
- `nextPollAt`: ISO string | null
- `flags`: string[] | null
- `reviewRequired`: boolean | null
- `failureReason`: string | null
- `authorizedBy`: string | null
- `createdAt`: ISO string
- `updatedAt`: ISO string

CryptoWithdrawalAllowlist:
- `_id`: string
- `userId`: string
- `currency`: string
- `address`: string
- `label`: string | null
- `createdAt`: ISO string
- `updatedAt`: ISO string

### Crypto Gateway error codes
- `invalid_request`, `unsupported_currency`, `withdrawal_not_found`, `withdrawal_conflict`,
  `idempotency_conflict`
- Ledger errors may surface on withdrawal creation (see Ledger section).

---

## Web (4005)
Auth: Telegram init data or demo user header.

### GET /
Returns HTML. Optional `?lang=<locale>` controls locale selection.

### GET /api/session
Response 200:
```
{ "user": WebUser | null }
```

### GET /api/auctions
Response 200:
```
[ActiveAuctionPayload]
```

### GET /api/bids/active
Auth required.
Query:
- `limit` (optional, default 20, max 50)

Response 200:
```
[ActiveBidPayload]
```

### POST /api/auctions
Auth required. Origin required.

Body (strict):
```
{
  "title": "string",
  "description": "string?",
  "currency": "string?",
  "rounds": 3,
  "allocationSize": 5,
  "roundDurationSeconds": 300,
  "startOffsetSeconds": 0,
  "antiSniping": {
    "triggerWindowSeconds": 10,
    "extensionSeconds": 15,
    "maxExtensions": 3
  }
}
```

Response 201:
```
{ "_id": "<auctionId>", "status": "draft|live" }
```

### GET /api/auctions/:auctionId
Response 200:
```
{
  "_id": "<auctionId>",
  "title": "string",
  "description": "string|undefined",
  "status": "draft|live|closed",
  "currency": "string",
  "startsAt": "ISO",
  "endsAt": "ISO",
  "rounds": [ { "index": number, "allocationSize": number, "startAt": "ISO", "endAt": "ISO" } ]
}
```

### GET /api/auctions/:auctionId/snapshot
Response 200:
```
RealtimeAuctionSnapshot
```

### GET /api/auctions/:auctionId/bids
Query:
- `limit` (optional, default 20, max 50)

Response 200:
```
[ { "_id": "string", "userId": "string", "amount": number, "createdAt": "ISO" } ]
```

### POST /api/auctions/:auctionId/bids
Auth required. Origin required.

Body (strict):
```
{ "amount": 123.45, "idempotencyKey": "string?" }
```

Response 200:
```
{
  "bid": Bid,
  "balance": LedgerBalance,
  "roundState": RoundState,
  "extended": true|false,
  "idempotent": true|false
}
```

### GET /api/crypto/deposit-address
Auth required.
Query:
- `currency` (optional, default "USDT")

Response 200:
```
{ "currency": "string", "address": "string", "memo": "string|null", "strategy": "address_pool|memo_tag|address_per_user" }
```

### POST /api/crypto/withdrawals
Auth required. Origin required.

Body (strict):
```
{
  "amount": 123.45,
  "currency": "string?",
  "destinationAddress": "string",
  "memo": "string?",
  "idempotencyKey": "string?"
}
```

Response 200:
```
{
  "withdrawal": CryptoWithdrawal,
  "balance": LedgerBalance,
  "decision": "approve|review|reject",
  "flags": [ "string" ],
  "violations": [ "string" ]
}
```

### GET /api/balance
Auth required.
Query:
- `currency` (optional, default "USDT")

Response 200:
```
LedgerBalance
```

### GET /api/balance/:userId
Auth required. Must match the authenticated user.
Query:
- `currency` (optional, default "USDT")

Response 200:
```
LedgerBalance
```

### GET /api/profile/:userId
No auth required.

Response 200:
```
{
  "userId": "string",
  "auctionsCreated": number,
  "bidsPlaced": number,
  "balance": LedgerBalance,
  "auctions": [PublicAuction],
  "activeAuctions": [ParticipationAuction],
  "participatedAuctions": [ParticipationAuction]
}
```

PublicAuction:
- `_id`, `title`, `description`, `status`, `currency`, `startsAt`, `endsAt`, `createdAt`
- `rounds`: [ { index, allocationSize, startAt, endAt } ]

ParticipationAuction = PublicAuction plus:
- `bidsCount`: number
- `lastBidAt`: ISO string | null
- `placement`: number | null

### WebSocket /ws
Client -> server messages (JSON):
- `{ "type": "ping" }`
- `{ "type": "auth", "initData": "<telegram init data>" }`
- `{ "type": "auth", "demoUserId": "string" }` (demo mode only)
- `{ "type": "subscribe", "auctionId": "<id>" }` or `{ "type": "subscribe", "auctionIds": ["<id>"] }`
- `{ "type": "unsubscribe", "auctionId": "<id>" }` or `{ "type": "unsubscribe", "auctionIds": ["<id>"] }`

Server -> client messages (JSON):
- `{ "type": "pong" }`
- `{ "type": "auth", "ok": true, "user": WebUser }`
- `{ "type": "auth", "ok": false, "code": "auth_required|telegram_invalid|telegram_not_configured", "message": "..." }`
- `{ "type": "auctions", "data": [ActiveAuctionPayload] }`
- `{ "type": "auction_snapshot", "data": RealtimeAuctionSnapshot }`
- `{ "type": "auction_bids", "auctionId": "<id>", "data": [ { _id, userId, amount, createdAt } ] }`
- `{ "type": "active_bids", "data": [ActiveBidPayload] }`

WebUser:
- `id`, `displayName`, `username`, `firstName`, `lastName`, `languageCode`, `source`

ActiveAuctionPayload:
- Same fields as `AuctionSummary`, plus `rounds` (index, allocationSize, startAt, endAt).

ActiveBidPayload:
- `id`, `auctionId`, `amount`, `createdAt`, `roundIndex`, `roundsCount`,
  `auctionTitle`, `auctionStatus`, `currency`

RealtimeAuctionSnapshot:
- `auctionId`, `status`, `title`, `currency`, `currentRoundIndex`, `roundStatus`,
  `roundEffectiveEndAt`, `roundLastBidAt`, `lastBidAmount`, `updatedAt`, `serverTime`

---

## Signer (4007)
Auth: `x-signer-token` and IP allowlist.

### POST /signer/sign
Body:
```
{
  "withdrawalId": "string",
  "currency": "string",
  "amount": 123.45,
  "fromAddress": "string",
  "toAddress": "string",
  "requestedAt": "ISO string",
  "memo": "string?"
}
```

Response 200:
```
{
  "signedPayload": {
    "payload": { ... },
    "signature": "base64",
    "publicKey": "base64",
    "algorithm": "ed25519",
    "signedAt": "ISO",
    "cosignatures": [ { "signature": "base64", "publicKey": "base64", "algorithm": "ed25519" } ]?
  }
}
```

Errors:
- 403 forbidden (token missing/invalid or IP not allowed)
- 400 invalid_request (bad payload or requestedAt)

---

## Mock RPC (9000)
Used for external mock observer/signer flows.

### GET /observer/transactions
Query:
- `currency`: string (optional, uppercased)
- `addresses`: comma-separated list (optional)
- `after`: integer cursor (optional, default 0)
- `limit`: integer 1..200 (optional, default 100)

Response 200:
```
{
  "nextCursor": "number" | null,
  "transactions": [
    {
      "txId": "string",
      "currency": "string",
      "address": "string",
      "memo": "string?",
      "amount": number,
      "confirmations": number,
      "observedAt": "ISO",
      "blockHeight": number?
    }
  ]
}
```

### GET /observer/transactions/:txId
Query:
- `currency`: string (optional)

Response 200:
```
{ txId, currency, address, memo?, amount, confirmations, observedAt, blockHeight? }
```
404 if not found or currency mismatch.

### POST /observer/transactions/broadcast
Body:
```
{
  "currency": "string",
  "signedPayload": SignedPayload,
  "clientReference": "string?"
}
```

Response 200:
```
{ "txId": "string" }
```
Errors:
- 400 invalid_request
- 400 invalid_signature (only when `MOCK_RPC_STRICT_SIGNATURES=true`)

### POST /signer/sign
Body:
```
WithdrawalSigningPayload
```
Response 200:
```
{ "signedPayload": SignedPayload }
```

### POST /mock/observer/mint
Body:
```
{
  "currency": "string",
  "address": "string",
  "memo": "string?",
  "amount": number,
  "txId": "string?",
  "observedAt": "ISO?",
  "blockHeight": number?
}
```

Response 200:
```
{ "txId": "string" }
```

### POST /mock/observer/mine
Body:
```
{ "blocks": number? }
```

Response 200:
```
{ "blockHeight": number }
```

### POST /mock/observer/reset
Response 200:
```
{ "ok": true }
```

### Mock RPC schemas
WithdrawalSigningPayload:
- `withdrawalId`, `currency`, `amount`, `fromAddress`, `toAddress`, `requestedAt`, `memo?`

SignedPayload:
- `payload`: WithdrawalSigningPayload
- `signature`: base64
- `publicKey`: base64
- `algorithm`: `ed25519`
- `signedAt`: ISO string
- `cosignatures`: array of `{ signature, publicKey, algorithm }` (optional)

---

## Bot (4004) and Workers (4006)
No custom HTTP routes. Only the common endpoints:
- GET /health/live
- GET /health/ready
- GET /metrics
