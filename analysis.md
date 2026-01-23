# Weaknesses Analysis

This document captures concrete weaknesses observed in the current codebase and why they matter. Each point references the relevant files so the team can verify and prioritize fixes.

## High impact

- ~~**GraphQL auth bypass exposes user data.**~~ ✅ **FIXED**: The `/graphql` endpoint now requires `requireCoreAuth` and derives `userId` from verified auth context. Users can only access their own bids and balances.
- ~~**GraphiQL is always enabled.**~~ ✅ **FIXED**: GraphiQL is now only enabled when `config.env !== "production"`.

## Correctness and integrity

- ~~**GraphQL ObjectId handling is broken.**~~ ✅ **FIXED**: Added `parseObjectId()` helper that validates and converts string IDs to proper `ObjectId` instances. All resolvers now use this helper.
- ~~**GraphQL balance math uses non-existent totals keys.**~~ ✅ **FIXED**: Balance resolver now uses correct `LedgerEntryType` keys: `deposit_confirmed`, `hold_created`, `hold_released`, `hold_captured`, `withdrawal_requested`, `withdrawal_confirmed`, `withdrawal_failed`.
- ~~**Webhook dispatcher uses string IDs against ObjectId collections.**~~ ✅ **FIXED**: `WebhookDelivery.webhookId` is now typed as `ObjectId`. All CRUD operations use proper ObjectId conversion with `ObjectId.isValid()` validation.

## Security and abuse surface

- ~~**Webhook SSRF exposure.**~~ ✅ **FIXED**: Added `isPrivateOrBlockedUrl()` validation that blocks:
  - Private IP ranges (10.x, 172.16-31.x, 192.168.x, 127.x)
  - IPv6 private/link-local addresses
  - localhost, *.local, *.internal hostnames
  - Cloud metadata endpoints (169.254.169.254)
- ~~**Webhook secrets stored in plaintext.**~~ ✅ **FIXED**: Secrets are now hashed with HMAC-SHA256 before storage. The plaintext secret is only returned once during webhook registration.

## Remaining considerations

1. **KMS integration for webhook secrets** - Current implementation uses local hashing. For higher security, consider integrating with AWS KMS, HashiCorp Vault, or similar.
2. **Rate limiting on GraphQL** - Consider adding query complexity limits or rate limiting per user.
3. **Audit logging** - Consider logging all auth failures and sensitive operations for security monitoring.
