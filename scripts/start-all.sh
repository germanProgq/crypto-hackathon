#!/bin/bash

# Script to start all services for crypto-hackathon project

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

echo "🚀 Starting crypto-hackathon project..."

# Check if MongoDB is running
if ! nc -z localhost 27017 2>/dev/null; then
    echo "📦 Starting MongoDB..."
    export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
    docker compose up -d mongo mongo-init redis || {
        echo "⚠️  Failed to start databases via Docker. Please ensure Docker Desktop is running."
        echo "   You can also start MongoDB and Redis manually."
        exit 1
    }
    
    echo "⏳ Waiting for MongoDB to be ready..."
    sleep 5
else
    echo "✅ MongoDB is already running"
fi

# Check if Redis is running
if ! nc -z localhost 6379 2>/dev/null; then
    echo "📦 Starting Redis..."
    export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
    docker compose up -d redis || {
        echo "⚠️  Failed to start Redis via Docker."
        exit 1
    }
    sleep 2
else
    echo "✅ Redis is already running"
fi

echo ""
echo "🎯 Starting services..."
echo ""

# Start services in background
npm run dev:observer > /tmp/crypto-hack-observer.log 2>&1 &
OBSERVER_PID=$!
echo "✅ Observer service started (PID: $OBSERVER_PID)"

npm run dev:auction-engine > /tmp/crypto-hack-auction-engine.log 2>&1 &
AUCTION_ENGINE_PID=$!
echo "✅ Auction Engine started (PID: $AUCTION_ENGINE_PID)"

npm run dev:ledger > /tmp/crypto-hack-ledger.log 2>&1 &
LEDGER_PID=$!
echo "✅ Ledger started (PID: $LEDGER_PID)"

npm run dev:crypto-gateway > /tmp/crypto-hack-crypto-gateway.log 2>&1 &
CRYPTO_GATEWAY_PID=$!
echo "✅ Crypto Gateway started (PID: $CRYPTO_GATEWAY_PID)"

npm run dev:signer > /tmp/crypto-hack-signer.log 2>&1 &
SIGNER_PID=$!
echo "✅ Signer started (PID: $SIGNER_PID)"

npm run dev:workers > /tmp/crypto-hack-workers.log 2>&1 &
WORKERS_PID=$!
echo "✅ Workers started (PID: $WORKERS_PID)"

npm run dev:web > /tmp/crypto-hack-web.log 2>&1 &
WEB_PID=$!
echo "✅ Web service started (PID: $WEB_PID)"

# Save PIDs to file for easy stopping
echo "$OBSERVER_PID $AUCTION_ENGINE_PID $LEDGER_PID $CRYPTO_GATEWAY_PID $SIGNER_PID $WORKERS_PID $WEB_PID" > /tmp/crypto-hack-pids.txt

echo ""
echo "✨ All services started!"
echo ""
echo "📊 Service URLs:"
echo "   - Auction Engine API: https://localhost:4001"
echo "   - Ledger API: https://localhost:4002"
echo "   - Crypto Gateway API: https://localhost:4003"
echo "   - Web UI: https://localhost:4005"
echo "   - Workers: https://localhost:4006"
echo "   - Signer: https://localhost:4007"
echo "   - Observer: http://localhost:9000"
echo ""
echo "📝 Logs:"
echo "   - Observer: tail -f /tmp/crypto-hack-observer.log"
echo "   - Auction Engine: tail -f /tmp/crypto-hack-auction-engine.log"
echo "   - Ledger: tail -f /tmp/crypto-hack-ledger.log"
echo "   - Crypto Gateway: tail -f /tmp/crypto-hack-crypto-gateway.log"
echo "   - Signer: tail -f /tmp/crypto-hack-signer.log"
echo "   - Workers: tail -f /tmp/crypto-hack-workers.log"
echo "   - Web: tail -f /tmp/crypto-hack-web.log"
echo ""
echo "🛑 To stop all services: kill \$(cat /tmp/crypto-hack-pids.txt)"
