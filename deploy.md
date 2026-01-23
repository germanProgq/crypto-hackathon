# Deployment Guide (Docker Compose)

This project runs multiple Node.js services (auction-engine, ledger, crypto-gateway, signer, web, workers, bot). The easiest production deployment is Docker Compose with a single app image and separate service commands.

## Prerequisites

- Linux server with Docker Engine + Docker Compose plugin
- Open ports for the services you plan to expose (typically only 80/443 via a reverse proxy)
- A DNS name + TLS (recommended)

## Quick Start

1) Clone and enter the repo

2) Create a `.env` file with required secrets (example below)

3) Create a `docker-compose.prod.yml` (example below)

4) Build and start services:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

5) Check health:

```bash
curl http://localhost:4005/health/ready
```

## Minimal .env example

Adjust values for your environment.

```bash
# Core auth
CORE_API_TOKEN=replace-with-strong-token

# Crypto gateway
CRYPTO_SUPPORTED_CURRENCIES=USDT
CRYPTO_WALLET_STRATEGY=memo_tag
CRYPTO_MEMO_DEPOSIT_ADDRESS=USDT:DEMO_DEPOSIT_ADDRESS
CRYPTO_HOT_WALLET_ADDRESS=USDT:DEMO_HOT_WALLET
CRYPTO_USD_RATES=USDT:1
CRYPTO_SIGNER_TOKEN=replace-with-strong-token
CRYPTO_ADMIN_TOKEN=replace-with-strong-token
CRYPTO_SIGNER_URL=https://your-signer.example.com
CRYPTO_OBSERVER_URL=https://your-observer.example.com

# Signer service
SIGNER_API_TOKEN=replace-with-strong-token
SIGNER_PRIVATE_KEY=base64-ed25519-private-key
SIGNER_ALLOWED_IPS=*

# Web + bot
WEB_ALLOWED_ORIGINS=https://your-frontend.example.com
WEB_ALLOW_DEMO_USER=false
TELEGRAM_BOT_TOKEN=replace-with-telegram-token
TELEGRAM_API_BASE=https://api.telegram.org

# Optional
OPENAPI_ENABLED=false
LOG_LEVEL=info
```

## Production docker-compose (example)

Save as `docker-compose.prod.yml`.

```yaml
services:
  mongo:
    image: mongo:7.0
    command: ["mongod", "--replSet", "rs0", "--bind_ip_all"]
    ports:
      - "27017:27017"
    volumes:
      - mongo-data:/data/db

  mongo-init:
    image: mongo:7.0
    depends_on:
      mongo:
        condition: service_started
    entrypoint:
      - sh
      - -c
      - >
          until mongosh --host mongo --quiet --eval 'db.runCommand({ ping: 1 }).ok' >/dev/null 2>&1; do
            sleep 1;
          done;
          mongosh --host mongo --quiet --eval 'try { rs.status() } catch (e) { rs.initiate({_id:"rs0",members:[{_id:0,host:"mongo:27017"}]}); }';

  redis:
    image: redis:7.2-alpine
    ports:
      - "6379:6379"

  auction-engine:
    build:
      context: .
      target: runtime
    image: crypto-hack:latest
    environment:
      NODE_ENV: production
      SERVICE_NAME: auction-engine
      HTTP_PORT: "4001"
      MONGO_URI: mongodb://mongo:27017/crypto_hack?replicaSet=rs0&directConnection=true
      MONGO_DB: crypto_hack
      REDIS_URL: redis://redis:6379
      CORE_API_TOKEN: ${CORE_API_TOKEN}
      LOG_LEVEL: ${LOG_LEVEL:-info}
    command: ["node", "dist/src/services/auction-engine/index.js"]
    depends_on:
      - mongo-init
      - redis
    ports:
      - "4001:4001"

  ledger:
    image: crypto-hack:latest
    environment:
      NODE_ENV: production
      SERVICE_NAME: ledger
      HTTP_PORT: "4002"
      MONGO_URI: mongodb://mongo:27017/crypto_hack?replicaSet=rs0&directConnection=true
      MONGO_DB: crypto_hack
      REDIS_URL: redis://redis:6379
      CORE_API_TOKEN: ${CORE_API_TOKEN}
      LOG_LEVEL: ${LOG_LEVEL:-info}
    command: ["node", "dist/src/services/ledger/index.js"]
    depends_on:
      - mongo-init
      - redis
    ports:
      - "4002:4002"

  crypto-gateway:
    image: crypto-hack:latest
    environment:
      NODE_ENV: production
      SERVICE_NAME: crypto-gateway
      HTTP_PORT: "4003"
      MONGO_URI: mongodb://mongo:27017/crypto_hack?replicaSet=rs0&directConnection=true
      MONGO_DB: crypto_hack
      REDIS_URL: redis://redis:6379
      CORE_API_TOKEN: ${CORE_API_TOKEN}
      CRYPTO_SUPPORTED_CURRENCIES: ${CRYPTO_SUPPORTED_CURRENCIES}
      CRYPTO_WALLET_STRATEGY: ${CRYPTO_WALLET_STRATEGY}
      CRYPTO_MEMO_DEPOSIT_ADDRESS: ${CRYPTO_MEMO_DEPOSIT_ADDRESS}
      CRYPTO_HOT_WALLET_ADDRESS: ${CRYPTO_HOT_WALLET_ADDRESS}
      CRYPTO_SIGNER_URL: ${CRYPTO_SIGNER_URL}
      CRYPTO_SIGNER_TOKEN: ${CRYPTO_SIGNER_TOKEN}
      CRYPTO_ADMIN_TOKEN: ${CRYPTO_ADMIN_TOKEN}
      CRYPTO_USD_RATES: ${CRYPTO_USD_RATES}
      CRYPTO_OBSERVER_URL: ${CRYPTO_OBSERVER_URL}
      LOG_LEVEL: ${LOG_LEVEL:-info}
    command: ["node", "dist/src/services/crypto-gateway/index.js"]
    depends_on:
      - mongo-init
      - redis
    ports:
      - "4003:4003"

  signer:
    image: crypto-hack:latest
    environment:
      NODE_ENV: production
      SERVICE_NAME: signer
      HTTP_HOST: 0.0.0.0
      HTTP_PORT: "4007"
      SIGNER_API_TOKEN: ${SIGNER_API_TOKEN}
      SIGNER_PRIVATE_KEY: ${SIGNER_PRIVATE_KEY}
      SIGNER_ALLOWED_IPS: ${SIGNER_ALLOWED_IPS:-*}
      LOG_LEVEL: ${LOG_LEVEL:-info}
    command: ["node", "dist/src/services/signer/index.js"]
    ports:
      - "4007:4007"

  web:
    image: crypto-hack:latest
    environment:
      NODE_ENV: production
      SERVICE_NAME: web
      HTTP_PORT: "4005"
      MONGO_URI: mongodb://mongo:27017/crypto_hack?replicaSet=rs0&directConnection=true
      MONGO_DB: crypto_hack
      REDIS_URL: redis://redis:6379
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN}
      TELEGRAM_API_BASE: ${TELEGRAM_API_BASE}
      CRYPTO_SUPPORTED_CURRENCIES: ${CRYPTO_SUPPORTED_CURRENCIES}
      CRYPTO_WALLET_STRATEGY: ${CRYPTO_WALLET_STRATEGY}
      CRYPTO_MEMO_DEPOSIT_ADDRESS: ${CRYPTO_MEMO_DEPOSIT_ADDRESS}
      CRYPTO_SIGNER_URL: ${CRYPTO_SIGNER_URL}
      CRYPTO_SIGNER_TOKEN: ${CRYPTO_SIGNER_TOKEN}
      CRYPTO_OBSERVER_URL: ${CRYPTO_OBSERVER_URL}
      WEB_ALLOWED_ORIGINS: ${WEB_ALLOWED_ORIGINS}
      WEB_ALLOW_DEMO_USER: ${WEB_ALLOW_DEMO_USER:-false}
      OPENAPI_ENABLED: ${OPENAPI_ENABLED:-false}
      LOG_LEVEL: ${LOG_LEVEL:-info}
    command: ["node", "dist/src/services/web/index.js"]
    depends_on:
      - mongo-init
      - redis
    ports:
      - "4005:4005"

  workers:
    image: crypto-hack:latest
    environment:
      NODE_ENV: production
      SERVICE_NAME: workers
      HTTP_PORT: "4006"
      MONGO_URI: mongodb://mongo:27017/crypto_hack?replicaSet=rs0&directConnection=true
      MONGO_DB: crypto_hack
      REDIS_URL: redis://redis:6379
      LOG_LEVEL: ${LOG_LEVEL:-info}
    command: ["node", "dist/src/services/workers/index.js"]
    depends_on:
      - mongo-init
      - redis
    ports:
      - "4006:4006"

  bot:
    image: crypto-hack:latest
    environment:
      NODE_ENV: production
      SERVICE_NAME: bot
      HTTP_PORT: "4004"
      MONGO_URI: mongodb://mongo:27017/crypto_hack?replicaSet=rs0&directConnection=true
      MONGO_DB: crypto_hack
      REDIS_URL: redis://redis:6379
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN}
      TELEGRAM_API_BASE: ${TELEGRAM_API_BASE}
      LOG_LEVEL: ${LOG_LEVEL:-info}
    command: ["node", "dist/src/services/bot/index.js"]
    depends_on:
      - mongo-init
      - redis
    ports:
      - "4004:4004"

volumes:
  mongo-data:
```

## Notes

- For production, do not expose internal services directly to the public internet. Use a reverse proxy (nginx, Caddy) in front of the `web` service.
- `mock-rpc` is for development only. In production, point `CRYPTO_OBSERVER_URL` and `CRYPTO_SIGNER_URL` to real infrastructure.
- Disable OpenAPI docs in production with `OPENAPI_ENABLED=false` unless you want public docs.
- Health endpoints: `/health/live` and `/health/ready` on each service.

## Rollback

```bash
docker compose -f docker-compose.prod.yml down
```

