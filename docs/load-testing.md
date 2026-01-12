# Load testing

This document captures the load suite commands and run results.

## Environment

- Docker compose services running on localhost
- Rate limits at defaults (no overrides)

## Bot simulation

Command:

```bash
node scripts/load/bot-sim.js --run-id=bot-20260112220402 --users=20 --bids=4 --concurrency=8 --user-prefix=bot
```

Result:

- auctionId: 696546274dae8bcbe4257f7c
- bids: 80
- latency: count=80 min=7.56ms mean=29.26ms p50=17.93ms p95=129.46ms p99=213.80ms max=213.80ms
- status: ok=80 error=0

## Stress test

Command:

```bash
node scripts/load/stress-bids.js --run-id=stress-20260112220402 --bids=120 --users=120 --concurrency=30 --user-prefix=stress
```

Result:

- auctionId: 6965463b4dae8bcbe4257f7d
- bids: 120
- latency: count=120 min=3.48ms mean=227.66ms p50=6.03ms p95=981.31ms p99=1065.71ms max=1077.54ms
- status: ok=120 error=0

## Anti-sniping

Command:

```bash
node scripts/load/anti-sniping.js --run-id=anti-20260112220402
```

Result:

- auctionId: 696546454dae8bcbe4257f7e
- extended: true
- extensionCount: 1
- extensionMs: 12000
- latency: count=1 min=24.18ms mean=24.18ms p50=24.18ms p95=24.18ms p99=24.18ms max=24.18ms

## Reconciliation

Command:

```bash
node scripts/load/reconcile.js --run-id=bot-20260112220402 --user-prefix=bot --count=20
```

Result:

- users: 20
- issues: 0
- latency: count=20 min=3.00ms mean=12.70ms p50=14.00ms p95=28.00ms p99=28.00ms max=28.00ms
