// GraphQL API layer for Crypto Auction Platform
import type { FastifyInstance } from "fastify";
import type { Db, ObjectId, WithId } from "mongodb";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { mongoCollections, type AuctionDocument, type BidDocument, type LedgerAccountDocument } from "../../shared/storage/mongoSchemas.js";

interface GraphQLDeps {
  db: Db;
  redis: Redis;
  logger: Logger;
}

// GraphQL Schema
const typeDefs = `
  scalar DateTime
  scalar ObjectID

  enum AuctionStatus {
    draft
    live
    closed
  }

  enum RoundStatus {
    scheduled
    live
    closed
  }

  enum PricingMode {
    first_price
    cutoff
  }

  type Query {
    # Auctions
    auction(id: ObjectID!): Auction
    auctions(status: AuctionStatus, limit: Int, cursor: String): AuctionConnection!
    
    # Bids
    userBids(userId: String!, auctionId: ObjectID): [Bid!]!
    leaderboard(auctionId: ObjectID!, roundIndex: Int, limit: Int): [LeaderboardEntry!]!
    
    # Balance
    balance(userId: String!, currency: String!): Balance
    
    # Rounds
    roundState(auctionId: ObjectID!, roundIndex: Int!): RoundState
  }

  type Mutation {
    # Bids
    placeBid(input: PlaceBidInput!): PlaceBidResult!
    
    # Watchlist
    watchAuction(auctionId: ObjectID!): Boolean!
    unwatchAuction(auctionId: ObjectID!): Boolean!
  }

  type Subscription {
    # Real-time bid updates
    bidPlaced(auctionId: ObjectID!): BidUpdate!
    
    # Balance changes
    balanceChanged(userId: String!): BalanceUpdate!
    
    # Round status changes
    roundStatusChanged(auctionId: ObjectID!): RoundStatusUpdate!
    
    # Leaderboard updates
    leaderboardUpdated(auctionId: ObjectID!): LeaderboardUpdate!
  }

  # ============ Types ============

  type Auction {
    id: ObjectID!
    title: String!
    description: String
    currency: String!
    status: AuctionStatus!
    pricingMode: PricingMode
    minBid: Float!
    minIncrement: Float!
    startsAt: DateTime!
    endsAt: DateTime!
    currentRoundIndex: Int
    roundStatus: RoundStatus
    rounds: [Round!]!
    totalBids: Int!
    topBid: Float
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type Round {
    index: Int!
    allocationSize: Int!
    startAt: DateTime!
    endAt: DateTime!
    antiSniping: AntiSnipingConfig!
  }

  type AntiSnipingConfig {
    triggerWindowSeconds: Int!
    extensionSeconds: Int!
    maxExtensions: Int!
  }

  type RoundState {
    status: RoundStatus!
    roundIndex: Int!
    scheduledStartAt: DateTime!
    scheduledEndAt: DateTime!
    effectiveEndAt: DateTime!
    extensionCount: Int!
    maxExtensions: Int!
    remainingSeconds: Int!
  }

  type Bid {
    id: ObjectID!
    auctionId: ObjectID!
    userId: String!
    amount: Float!
    maxAmount: Float
    roundIndex: Int!
    active: Boolean!
    createdAt: DateTime!
  }

  type LeaderboardEntry {
    rank: Int!
    userId: String!
    amount: Float!
    bidId: ObjectID!
    isCurrentUser: Boolean
  }

  type Balance {
    available: Float!
    held: Float!
    current: Float!
    spent: Float!
    currency: String!
  }

  type AuctionConnection {
    edges: [AuctionEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type AuctionEdge {
    node: Auction!
    cursor: String!
  }

  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }

  # ============ Inputs ============

  input PlaceBidInput {
    auctionId: ObjectID!
    amount: Float!
    maxAmount: Float
    idempotencyKey: String!
  }

  # ============ Results ============

  type PlaceBidResult {
    success: Boolean!
    bid: Bid
    balance: Balance
    rank: Int
    error: String
    code: String
  }

  # ============ Subscriptions ============

  type BidUpdate {
    auctionId: ObjectID!
    userId: String!
    amount: Float!
    rank: Int!
    timestamp: DateTime!
  }

  type BalanceUpdate {
    userId: String!
    currency: String!
    available: Float!
    held: Float!
    current: Float!
    changeType: String!
  }

  type RoundStatusUpdate {
    auctionId: ObjectID!
    roundIndex: Int!
    previousStatus: RoundStatus!
    newStatus: RoundStatus!
    effectiveEndAt: DateTime
  }

  type LeaderboardUpdate {
    auctionId: ObjectID!
    roundIndex: Int!
    entries: [LeaderboardEntry!]!
  }
`;

// Type definitions for resolver context
interface GraphQLContext {
  userId?: string;
  deps: GraphQLDeps;
}

export function registerGraphQL(app: FastifyInstance, deps: GraphQLDeps) {
  const auctions = deps.db.collection<AuctionDocument>(mongoCollections.auctions);
  const bids = deps.db.collection<BidDocument>(mongoCollections.bids);
  const accounts = deps.db.collection<LedgerAccountDocument>(mongoCollections.ledgerAccounts);

  // Resolvers
  const resolvers = {
    Query: {
      auction: async (_: unknown, { id }: { id: string }) => {
        const auction = await auctions.findOne({ _id: id as unknown as ObjectId });
        return auction ? transformAuction(auction) : null;
      },

      auctions: async (_: unknown, args: { status?: string; limit?: number; cursor?: string }) => {
        const limit = Math.min(args.limit ?? 20, 100);
        const query: Record<string, unknown> = {};
        
        if (args.status) {
          query.status = args.status;
        }
        
        if (args.cursor) {
          query._id = { $lt: args.cursor };
        }

        const results = await auctions
          .find(query)
          .sort({ _id: -1 })
          .limit(limit + 1)
          .toArray();

        const hasNextPage = results.length > limit;
        const edges = results.slice(0, limit).map(auction => ({
          node: transformAuction(auction),
          cursor: auction._id.toHexString()
        }));

        const totalCount = await auctions.countDocuments(args.status ? { status: args.status as AuctionDocument["status"] } : {});

        return {
          edges,
          pageInfo: {
            hasNextPage,
            endCursor: edges.length > 0 ? edges[edges.length - 1]?.cursor ?? null : null
          },
          totalCount
        };
      },

      userBids: async (_: unknown, { userId, auctionId }: { userId: string; auctionId?: string }) => {
        const query: Record<string, unknown> = { userId };
        if (auctionId) {
          query.auctionId = auctionId;
        }
        
        const results = await bids.find(query).sort({ createdAt: -1 }).limit(100).toArray();
        return results.map(transformBid);
      },

      leaderboard: async (_: unknown, args: { auctionId: string; roundIndex?: number; limit?: number }) => {
        const limit = Math.min(args.limit ?? 10, 100);
        
        const pipeline = [
          { $match: { auctionId: args.auctionId as unknown as ObjectId, active: true } },
          { $sort: { amount: -1, createdAt: 1 } as const },
          { $limit: limit },
          { $project: { userId: 1, amount: 1, _id: 1 } }
        ];

        const results = await bids.aggregate(pipeline).toArray();
        
        return results.map((entry, index) => ({
          rank: index + 1,
          userId: entry.userId,
          amount: entry.amount,
          bidId: entry._id.toHexString()
        }));
      },

      balance: async (_: unknown, { userId, currency }: { userId: string; currency: string }) => {
        const account = await accounts.findOne({ userId, currency });
        
        if (!account || !account.totals) {
          return {
            available: 0,
            held: 0,
            current: 0,
            spent: 0,
            currency
          };
        }

        const totals = account.totals as Record<string, number> | undefined;
        const deposits = totals?.deposit ?? 0;
        const withdrawals = totals?.withdrawal ?? 0;
        const held = totals?.hold ?? 0;
        const captured = totals?.capture ?? 0;
        const released = totals?.release ?? 0;
        const refunds = totals?.refund ?? 0;
        
        const available = deposits - withdrawals - held + released + refunds - captured;
        const current = deposits - withdrawals - captured + refunds;

        return {
          available,
          held: held - released,
          current,
          spent: captured,
          currency
        };
      },

      roundState: async (_: unknown, args: { auctionId: string; roundIndex: number }) => {
        const auction = await auctions.findOne({ _id: args.auctionId as unknown as ObjectId });
        
        if (!auction) return null;

        const round = auction.rounds[args.roundIndex];
        if (!round) return null;

        const now = new Date();
        const effectiveEndAt = auction.roundEffectiveEndAt ?? round.endAt;
        const remainingMs = Math.max(0, effectiveEndAt.getTime() - now.getTime());

        return {
          status: auction.roundStatus ?? "scheduled",
          roundIndex: args.roundIndex,
          scheduledStartAt: round.startAt.toISOString(),
          scheduledEndAt: round.endAt.toISOString(),
          effectiveEndAt: effectiveEndAt.toISOString(),
          extensionCount: 0, // Would need to track in round state
          maxExtensions: round.antiSniping.maxExtensions,
          remainingSeconds: Math.ceil(remainingMs / 1000)
        };
      }
    },

    Mutation: {
      placeBid: async (_: unknown, { input }: { input: { auctionId: string; amount: number; maxAmount?: number; idempotencyKey: string } }, context: GraphQLContext) => {
        // This would call the actual bid service
        // For now, return a placeholder
        return {
          success: false,
          error: "GraphQL bidding not implemented - use REST API or WebSocket",
          code: "not_implemented"
        };
      },

      watchAuction: async (_: unknown, { auctionId }: { auctionId: string }, context: GraphQLContext) => {
        if (!context.userId) return false;
        // Would add to watchlist
        return true;
      },

      unwatchAuction: async (_: unknown, { auctionId }: { auctionId: string }, context: GraphQLContext) => {
        if (!context.userId) return false;
        // Would remove from watchlist
        return true;
      }
    }
  };

  // Register a simple GraphQL endpoint (without full Mercurius for simplicity)
  app.post("/graphql", async (request, reply) => {
    const { query, variables, operationName } = request.body as {
      query: string;
      variables?: Record<string, unknown>;
      operationName?: string;
    };

    // Simple query parser (production would use graphql-js or mercurius)
    const context: GraphQLContext = {
      userId: (request.headers["x-user-id"] as string) ?? undefined,
      deps
    };

    try {
      // Parse and execute (simplified - real impl would use graphql-js)
      const result = await executeGraphQL(query, variables, resolvers, context);
      return reply.send({ data: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "GraphQL execution error";
      return reply.code(400).send({ errors: [{ message }] });
    }
  });

  // GraphiQL UI
  app.get("/graphiql", async (_request, reply) => {
    reply.type("text/html").send(generateGraphiQLHtml());
  });

  deps.logger.info("GraphQL endpoint registered at /graphql");
}

// Helper functions
function transformAuction(doc: WithId<AuctionDocument>) {
  return {
    id: doc._id.toHexString(),
    title: doc.title,
    description: doc.description,
    currency: doc.currency,
    status: doc.status,
    pricingMode: doc.pricingMode?.replace("-", "_"),
    minBid: doc.minBid,
    minIncrement: doc.minIncrement,
    startsAt: doc.startsAt.toISOString(),
    endsAt: doc.endsAt.toISOString(),
    currentRoundIndex: doc.currentRoundIndex,
    roundStatus: doc.roundStatus,
    rounds: doc.rounds.map(r => ({
      index: r.index,
      allocationSize: r.allocationSize,
      startAt: r.startAt.toISOString(),
      endAt: r.endAt.toISOString(),
      antiSniping: r.antiSniping
    })),
    totalBids: 0, // Would need aggregation
    topBid: doc.lastBidAmount,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString()
  };
}

function transformBid(doc: WithId<BidDocument>) {
  return {
    id: doc._id.toHexString(),
    auctionId: doc.auctionId.toHexString(),
    userId: doc.userId,
    amount: doc.amount,
    maxAmount: doc.maxAmount,
    roundIndex: doc.roundIndex,
    active: doc.active,
    createdAt: doc.createdAt.toISOString()
  };
}

// Simplified GraphQL executor (production would use graphql-js)
async function executeGraphQL(
  query: string,
  variables: Record<string, unknown> | undefined,
  resolvers: Record<string, Record<string, Function>>,
  context: GraphQLContext
): Promise<Record<string, unknown>> {
  // Very simplified parser - just handle basic queries
  const queryMatch = query.match(/query\s*\{?\s*(\w+)\s*\(([^)]*)\)\s*\{/);
  const mutationMatch = query.match(/mutation\s*\{?\s*(\w+)\s*\(([^)]*)\)\s*\{/);

  if (queryMatch && resolvers.Query) {
    const [, name, argsStr] = queryMatch;
    const args = parseArgs(argsStr ?? "", variables);
    const resolver = name ? resolvers.Query[name] : undefined;
    if (resolver && name) {
      return { [name]: await resolver(null, args, context) };
    }
  }

  if (mutationMatch && resolvers.Mutation) {
    const [, name, argsStr] = mutationMatch;
    const args = parseArgs(argsStr ?? "", variables);
    const resolver = name ? resolvers.Mutation[name] : undefined;
    if (resolver && name) {
      return { [name]: await resolver(null, args, context) };
    }
  }

  throw new Error("Unable to parse GraphQL query");
}

function parseArgs(argsStr: string, variables?: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  
  // Simple argument parser
  const matches = argsStr.matchAll(/(\w+):\s*(\$\w+|"[^"]*"|\d+)/g);
  for (const match of matches) {
    const [, key, value] = match;
    if (value?.startsWith("$") && variables) {
      args[key!] = variables[value.slice(1)];
    } else if (value?.startsWith('"')) {
      args[key!] = value.slice(1, -1);
    } else {
      args[key!] = parseInt(value!, 10);
    }
  }

  return args;
}

function generateGraphiQLHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>GraphiQL - Crypto Auction API</title>
  <style>
    body { height: 100%; margin: 0; overflow: hidden; }
    #graphiql { height: 100vh; }
  </style>
  <link href="https://unpkg.com/graphiql@3.0.9/graphiql.min.css" rel="stylesheet" />
</head>
<body>
  <div id="graphiql">Loading GraphiQL...</div>
  <script src="https://unpkg.com/react@18.2.0/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18.2.0/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/graphiql@3.0.9/graphiql.min.js"></script>
  <script>
    const root = ReactDOM.createRoot(document.getElementById('graphiql'));
    root.render(
      React.createElement(GraphiQL, {
        fetcher: GraphiQL.createFetcher({
          url: '/graphql',
          headers: { 'Content-Type': 'application/json' }
        }),
        defaultEditorToolsVisibility: true
      })
    );
  </script>
</body>
</html>`;
}

export { typeDefs };
