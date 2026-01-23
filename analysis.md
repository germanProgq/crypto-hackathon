# Weaknesses Analysis

This document captures concrete weaknesses observed in the current codebase and why they matter. Each point references the relevant files so the team can verify and prioritize fixes.

## High impact

- **GraphQL auth bypass exposes user data.** The `/graphql` endpoint trusts an arbitrary `x-user-id` header and resolvers accept `userId` arguments directly. There is no call to `requireCoreAuth` or similar verification in `src/services/web/graphql.ts`, so any caller can fetch bids and balances for any user.
- **GraphiQL is always enabled.** The `/graphiql` route is registered unconditionally in `src/services/web/graphql.ts`. In production this exposes a ready-made interface for exploration and query execution, amplifying the impact of the auth bypass above.

## Correctness and integrity

- **GraphQL ObjectId handling is broken.** Several queries cast string IDs to `ObjectId` via TypeScript type assertions but never convert them. In Mongo, `_id` and `auctionId` are stored as `ObjectId`, so lookups like `findOne({ _id: id as ObjectId })` and `query._id = { $lt: args.cursor }` will not match, leading to empty results and broken pagination. Affects `auction`, `auctions`, `leaderboard`, `userBids`, and `roundState` in `src/services/web/graphql.ts`.
- **GraphQL balance math uses non-existent totals keys.** The GraphQL `balance` resolver reads totals using keys like `deposit`, `withdrawal`, `hold`, `capture`, `release`, and `refund`. Ledger totals are keyed by `LedgerEntryType` values such as `deposit_confirmed`, `hold_created`, `hold_released`, and `hold_captured` (`src/services/ledger/ledgerStore.ts`). As written, GraphQL balances will almost always be zero or wrong.
- **Webhook dispatcher uses string IDs against ObjectId collections.** `webhook_configs` is inserted with MongoDB ObjectIds, but the dispatcher stores `webhookId` as a string and later queries `findOne({ _id: delivery.webhookId as any })`. Update/delete paths do the same. This makes delivery processing and configuration updates silently fail for most records (`src/services/workers/webhookDispatcher.ts`).

## Security and abuse surface

- **Webhook SSRF exposure.** `registerWebhook` allows arbitrary URLs, and the dispatcher POSTs to them with no scheme/host validation or network restrictions (`src/services/workers/webhookDispatcher.ts`). This allows callers to force server-side requests to internal or sensitive hosts unless egress is locked down elsewhere.
- **Webhook secrets stored in plaintext.** Webhook secrets are stored directly in Mongo without encryption or hashing (`src/services/workers/webhookDispatcher.ts`). A database leak compromises all webhook signatures; consider envelope encryption or a KMS-backed secrets store.

## Suggested next steps

1. Require core auth on `/graphql` and derive userId from verified auth, not headers or query args.
2. Convert GraphQL string IDs to real `ObjectId` values and validate format.
3. Align GraphQL balance math with ledger entry types or reuse ledger’s `buildBalance` logic.
4. Normalize webhook ID handling by storing and querying with `ObjectId` values end-to-end.
5. Add outbound webhook URL validation (allowlist or block private ranges) and consider encrypting webhook secrets at rest.
