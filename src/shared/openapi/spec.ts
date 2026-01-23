// OpenAPI specification and Swagger UI registration for auction platform.
import type { FastifyInstance } from "fastify";

type SwaggerModule = typeof import("@fastify/swagger");
type SwaggerUiModule = typeof import("@fastify/swagger-ui");

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function shouldEnableOpenApi(): boolean {
  const override = parseOptionalBoolean(process.env.OPENAPI_ENABLED);
  if (override !== undefined) {
    return override;
  }
  if (process.env.NODE_ENV === "test" || process.env.VITEST === "true") {
    return false;
  }
  return true;
}

function isMissingDependency(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ERR_MODULE_NOT_FOUND" || error.message.includes("Cannot find package");
}

export async function registerOpenAPI(app: FastifyInstance): Promise<void> {
  if (!shouldEnableOpenApi()) {
    app.log.info("OpenAPI disabled");
    return;
  }

  let fastifySwagger: SwaggerModule["default"];
  let fastifySwaggerUi: SwaggerUiModule["default"];

  try {
    const [swaggerModule, swaggerUiModule] = await Promise.all([
      import("@fastify/swagger"),
      import("@fastify/swagger-ui")
    ]);
    fastifySwagger = swaggerModule.default;
    fastifySwaggerUi = swaggerUiModule.default;
  } catch (error) {
    if (isMissingDependency(error)) {
      app.log.warn({ err: error }, "OpenAPI skipped: swagger packages are not installed");
      return;
    }
    throw error;
  }

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Crypto Auction Platform API",
        description: `
Production-grade multi-round auction platform with:
- **Ledger-first financial accounting** - append-only transaction log with ACID guarantees
- **Cryptographic verification** - Merkle proofs and Ed25519 signatures for all settlements
- **ML-based anomaly detection** - real-time fraud detection for withdrawals
- **Three wallet strategies** - memo tags, HD derivation, deposit address pool
- **Vickrey cutoff pricing** - fair market pricing mechanism
- **Anti-sniping mechanism** - automatic round extensions on last-second bids
- **WebSocket turbo mode** - 30,000+ bids/second with sub-5ms latency
- **Redis fast path** - atomic operations for high-throughput bidding
- **Prometheus metrics** - production-ready observability stack
        `,
        version: "1.0.0",
        contact: {
          name: "API Support",
          url: "https://github.com/your-repo/crypto-auction"
        },
        license: {
          name: "MIT",
          url: "https://opensource.org/licenses/MIT"
        }
      },
      servers: [
        { url: "http://localhost:4001", description: "Auction Engine (Development)" },
        { url: "http://localhost:4002", description: "Ledger (Development)" },
        { url: "http://localhost:4003", description: "Crypto Gateway (Development)" },
        { url: "http://localhost:4005", description: "Web Service (Development)" }
      ],
      tags: [
        {
          name: "Auctions",
          description: "Auction lifecycle management - create, update, list, and manage multi-round auctions"
        },
        {
          name: "Bids",
          description: "Bid placement and management - direct bids and proxy auto-bidding"
        },
        {
          name: "Ledger",
          description: "Balance and transaction operations - deposits, withdrawals, holds, captures"
        },
        {
          name: "Crypto",
          description: "Cryptocurrency deposit and withdrawal operations with ML fraud detection"
        },
        {
          name: "Admin",
          description: "Administrative endpoints - settlement, reconciliation, system management"
        },
        {
          name: "Health",
          description: "Health check and readiness endpoints for monitoring"
        }
      ],
      components: {
        securitySchemes: {
          serviceToken: {
            type: "apiKey",
            in: "header",
            name: "x-service-token",
            description: "Service-to-service authentication token"
          },
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description: "JWT token for user authentication"
          }
        },
        schemas: {
          Error: {
            type: "object",
            properties: {
              error: { type: "string", description: "Error message" },
              code: { type: "string", description: "Machine-readable error code" }
            },
            required: ["error"]
          },
          Balance: {
            type: "object",
            properties: {
              available: { type: "number", description: "Available balance for new operations" },
              held: { type: "number", description: "Balance held for pending operations" },
              current: { type: "number", description: "Total balance (available + held)" }
            },
            required: ["available", "held", "current"]
          },
          Auction: {
            type: "object",
            properties: {
              _id: { type: "string", format: "objectid", description: "Auction ID" },
              title: { type: "string", description: "Auction title" },
              description: { type: "string", description: "Auction description" },
              currency: { type: "string", description: "Currency for bids (USDT, USD, etc)" },
              status: {
                type: "string",
                enum: ["pending", "active", "completed"],
                description: "Auction status"
              },
              winnersPerRound: { type: "integer", description: "Number of winners per round" },
              currentRoundIndex: { type: "integer", description: "Current active round index" },
              totalRounds: { type: "integer", description: "Total number of rounds" },
              startAt: { type: "string", format: "date-time", description: "Auction start time" },
              endAt: { type: "string", format: "date-time", description: "Auction end time" },
              createdAt: { type: "string", format: "date-time" },
              updatedAt: { type: "string", format: "date-time" }
            }
          },
          Bid: {
            type: "object",
            properties: {
              _id: { type: "string", format: "objectid", description: "Bid ID" },
              auctionId: { type: "string", format: "objectid", description: "Auction ID" },
              userId: { type: "string", description: "User who placed the bid" },
              amount: { type: "number", description: "Bid amount" },
              maxAmount: { type: "number", nullable: true, description: "Maximum auto-bid amount (proxy bidding)" },
              roundIndex: { type: "integer", description: "Round index when bid was placed" },
              status: {
                type: "string",
                enum: ["active", "won", "lost", "refunded"],
                description: "Bid status"
              },
              createdAt: { type: "string", format: "date-time" }
            }
          },
          LeaderboardEntry: {
            type: "object",
            properties: {
              rank: { type: "integer", description: "Current position in leaderboard (1-indexed)" },
              userId: { type: "string", description: "User ID" },
              amount: { type: "number", description: "Bid amount" },
              isCurrentUser: { type: "boolean", description: "Whether this is the requesting user" }
            }
          }
        }
      }
    }
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: "/api/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
      displayRequestDuration: true,
      filter: true,
      showExtensions: true,
      showCommonExtensions: true,
      tryItOutEnabled: true
    },
    staticCSP: false,
    transformSpecification: (swaggerObject) => {
      return swaggerObject;
    }
  });
}
