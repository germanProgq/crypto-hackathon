// MongoDB collection schemas and index specifications.
import type { Document, IndexDescription, ObjectId } from "mongodb";

export const mongoCollections = {
  auctions: "auctions",
  bids: "bids",
  ledgerEntries: "ledger_entries",
  roundResults: "round_results",
  deliveryRecords: "delivery_records"
} as const;

export type AuctionStatus = "draft" | "live" | "closed";
export type LedgerEntryType =
  | "deposit_confirmed"
  | "hold_created"
  | "hold_released"
  | "hold_captured"
  | "withdrawal_requested"
  | "withdrawal_broadcasted"
  | "withdrawal_confirmed"
  | "withdrawal_failed";

export interface AuctionRoundConfig {
  index: number;
  allocationSize: number;
  startAt: Date;
  endAt: Date;
  antiSniping: {
    triggerWindowSeconds: number;
    extensionSeconds: number;
    maxExtensions: number;
  };
}

export interface AuctionDocument {
  title: string;
  description?: string;
  status: AuctionStatus;
  currency: string;
  startsAt: Date;
  endsAt: Date;
  rounds: AuctionRoundConfig[];
  createdAt: Date;
  updatedAt: Date;
}

export interface BidDocument {
  auctionId: ObjectId;
  roundIndex: number;
  userId: string;
  amount: number;
  createdAt: Date;
  idempotencyKey: string;
}

export interface LedgerEntryDocument {
  userId: string;
  entryType: LedgerEntryType;
  amount: number;
  currency: string;
  createdAt: Date;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface RoundResultDocument {
  auctionId: ObjectId;
  roundIndex: number;
  winners: Array<{
    userId: string;
    bidId: ObjectId;
    amount: number;
    rank: number;
  }>;
  finalizedAt: Date;
  createdAt: Date;
}

export interface DeliveryRecordDocument {
  auctionId: ObjectId;
  roundIndex: number;
  userId: string;
  deliveryRef: string;
  createdAt: Date;
}

const bsonNumber = ["int", "long", "double", "decimal"] as const;

const roundSchema = {
  bsonType: "object",
  required: ["index", "allocationSize", "startAt", "endAt", "antiSniping"],
  properties: {
    index: { bsonType: bsonNumber },
    allocationSize: { bsonType: bsonNumber },
    startAt: { bsonType: "date" },
    endAt: { bsonType: "date" },
    antiSniping: {
      bsonType: "object",
      required: ["triggerWindowSeconds", "extensionSeconds", "maxExtensions"],
      properties: {
        triggerWindowSeconds: { bsonType: bsonNumber },
        extensionSeconds: { bsonType: bsonNumber },
        maxExtensions: { bsonType: bsonNumber }
      }
    }
  }
};

const auctionValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "title",
      "status",
      "currency",
      "startsAt",
      "endsAt",
      "rounds",
      "createdAt",
      "updatedAt"
    ],
    properties: {
      title: { bsonType: "string" },
      description: { bsonType: "string" },
      status: { bsonType: "string", enum: ["draft", "live", "closed"] },
      currency: { bsonType: "string" },
      startsAt: { bsonType: "date" },
      endsAt: { bsonType: "date" },
      rounds: { bsonType: "array", minItems: 1, items: roundSchema },
      createdAt: { bsonType: "date" },
      updatedAt: { bsonType: "date" }
    }
  }
};

const bidValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: ["auctionId", "roundIndex", "userId", "amount", "createdAt", "idempotencyKey"],
    properties: {
      auctionId: { bsonType: "objectId" },
      roundIndex: { bsonType: bsonNumber },
      userId: { bsonType: "string" },
      amount: { bsonType: bsonNumber },
      createdAt: { bsonType: "date" },
      idempotencyKey: { bsonType: "string" }
    }
  }
};

const ledgerValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: ["userId", "entryType", "amount", "currency", "createdAt", "idempotencyKey"],
    properties: {
      userId: { bsonType: "string" },
      entryType: {
        bsonType: "string",
        enum: [
          "deposit_confirmed",
          "hold_created",
          "hold_released",
          "hold_captured",
          "withdrawal_requested",
          "withdrawal_broadcasted",
          "withdrawal_confirmed",
          "withdrawal_failed"
        ]
      },
      amount: { bsonType: bsonNumber },
      currency: { bsonType: "string" },
      createdAt: { bsonType: "date" },
      idempotencyKey: { bsonType: "string" },
      metadata: { bsonType: "object" }
    }
  }
};

const roundResultValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: ["auctionId", "roundIndex", "winners", "finalizedAt", "createdAt"],
    properties: {
      auctionId: { bsonType: "objectId" },
      roundIndex: { bsonType: bsonNumber },
      winners: {
        bsonType: "array",
        items: {
          bsonType: "object",
          required: ["userId", "bidId", "amount", "rank"],
          properties: {
            userId: { bsonType: "string" },
            bidId: { bsonType: "objectId" },
            amount: { bsonType: bsonNumber },
            rank: { bsonType: bsonNumber }
          }
        }
      },
      finalizedAt: { bsonType: "date" },
      createdAt: { bsonType: "date" }
    }
  }
};

const deliveryValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: ["auctionId", "roundIndex", "userId", "deliveryRef", "createdAt"],
    properties: {
      auctionId: { bsonType: "objectId" },
      roundIndex: { bsonType: bsonNumber },
      userId: { bsonType: "string" },
      deliveryRef: { bsonType: "string" },
      createdAt: { bsonType: "date" }
    }
  }
};

export const mongoCollectionSpecs: Array<{ name: string; validator?: Document }> = [
  { name: mongoCollections.auctions, validator: auctionValidator },
  { name: mongoCollections.bids, validator: bidValidator },
  { name: mongoCollections.ledgerEntries, validator: ledgerValidator },
  { name: mongoCollections.roundResults, validator: roundResultValidator },
  { name: mongoCollections.deliveryRecords, validator: deliveryValidator }
];

export const mongoIndexSpecs: Array<{ collection: string; indexes: IndexDescription[] }> = [
  {
    collection: mongoCollections.auctions,
    indexes: [
      { key: { status: 1, startsAt: 1 }, name: "auctions_status_startsAt" },
      { key: { createdAt: -1 }, name: "auctions_createdAt" }
    ]
  },
  {
    collection: mongoCollections.bids,
    indexes: [
      {
        key: { auctionId: 1, roundIndex: 1, amount: -1, createdAt: 1 },
        name: "bids_rank"
      },
      { key: { userId: 1, createdAt: -1 }, name: "bids_user_createdAt" },
      { key: { auctionId: 1, roundIndex: 1, userId: 1 }, name: "bids_user_round" },
      { key: { idempotencyKey: 1 }, name: "bids_idempotency", unique: true }
    ]
  },
  {
    collection: mongoCollections.ledgerEntries,
    indexes: [
      { key: { userId: 1, createdAt: -1 }, name: "ledger_user_createdAt" },
      { key: { idempotencyKey: 1 }, name: "ledger_idempotency", unique: true }
    ]
  },
  {
    collection: mongoCollections.roundResults,
    indexes: [
      { key: { auctionId: 1, roundIndex: 1 }, name: "round_results_unique", unique: true },
      { key: { createdAt: -1 }, name: "round_results_createdAt" }
    ]
  },
  {
    collection: mongoCollections.deliveryRecords,
    indexes: [
      { key: { auctionId: 1, userId: 1 }, name: "delivery_auction_user" },
      { key: { userId: 1, createdAt: -1 }, name: "delivery_user_createdAt" }
    ]
  }
];
