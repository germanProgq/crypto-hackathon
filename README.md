# crypto-hackathon

A Telegram bot and backend for running multi-round crypto auctions of Telegram gifts.
People bid through the bot, the auction engine ranks bids and settles rounds, and a
crypto gateway handles deposits and withdrawals.

This was built for a hackathon, so treat it as a prototype. It is not audited and is
not meant to custody real funds.

## How it is put together

The code is split into several small Node.js services under `src/services/`:

- `auction-engine` runs the rounds, bidding, and settlement.
- `ledger` keeps an append-only record of every money-moving operation.
- `crypto-gateway` handles deposits and withdrawals through an external signer and RPC.
- `signer` signs outgoing transactions.
- `bot` is the Telegram bot interface.
- `web` serves the web UI, a live metrics dashboard, GraphQL, and Swagger docs.
- `workers` run background jobs.
- `mock-rpc` and `observer` support local development and testing.

Canonical state lives in MongoDB and is cached in Redis. State transitions are designed
to be idempotent so a retried request does not double-charge.

## Stack

Node.js 20+, TypeScript, Fastify, MongoDB, Redis. Tests run with Vitest.

## Running it locally

Requirements: Node.js 20+, Docker and Docker Compose, Git.

```bash
git clone https://github.com/germanProgq/crypto-hackathon.git
cd crypto-hackathon
npm install
```

Create a `.env` file. Use your own values for anything sensitive (for example a real
Telegram bot token when you want the bot to connect):

```bash
cat > .env << 'EOF'
CORE_API_TOKEN=change-me
MONGODB_URI=mongodb://localhost:27017/crypto-auction?directConnection=true
REDIS_URL=redis://localhost:6379
NODE_ENV=development
WEB_ALLOW_DEMO_USER=true
EOF
```

Start the infrastructure and the services:

```bash
docker compose up -d mongo redis

npm run dev:auction-engine &
npm run dev:ledger &
npm run dev:web &
npm run dev:workers &
```

Then open the web UI at http://localhost:4005.

Useful URLs once things are running:

| URL | What it is |
|-----|------------|
| http://localhost:4005 | Web UI |
| http://localhost:4005/live-metrics | Metrics dashboard |
| http://localhost:4005/graphiql | GraphQL IDE |
| http://localhost:4001/api/docs | Swagger UI |

## Build and test

```bash
npm run build         # TypeScript compile
npm test              # Vitest
npm run sdk:generate  # Generate the TypeScript SDK from the OpenAPI spec
```

Load and stress scripts live under `scripts/load/` and are exposed through
`npm run load:*`.

## More docs

See `MECHANICS.md` for auction mechanics, `deploy.md` for deployment notes, and
`analysis.md` for design analysis.
