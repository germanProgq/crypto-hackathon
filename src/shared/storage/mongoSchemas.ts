// Purpose: MongoDB collection schemas and index specifications.
import type { Document, IndexDescription, ObjectId } from "mongodb";

export const mongoCollections = {
  auctions: "auctions",
  auctionRoundStates: "auction_round_states",
  bids: "bids",
  ledgerAccounts: "ledger_accounts",
  ledgerEntries: "ledger_entries",
  roundResults: "round_results",
  deliveryRecords: "delivery_records",
  notificationQueue: "notification_queue"
} as const;

export type AuctionStatus = "draft" | "live" | "closed";
export type AuctionRoundStatus = "scheduled" | "live" | "closed";
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

export interface AuctionRoundStateDocument {
  auctionId: ObjectId;
  roundIndex: number;
  status: AuctionRoundStatus;
  scheduledStartAt: Date;
  scheduledEndAt: Date;
  effectiveEndAt: Date;
  extensionCount: number;
  lastBidAt?: Date;
  startedAt?: Date;
  closedAt?: Date;
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
  audit?: {
    requestId?: string;
    source?: string;
    ip?: string;
    userAgent?: string;
    actorId?: string;
  };
}

export interface LedgerEntryDocument {
  userId: string;
  entryType: LedgerEntryType;
  amount: number;
  currency: string;
  createdAt: Date;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  audit?: {
    requestId?: string;
    source?: string;
    ip?: string;
    userAgent?: string;
    actorId?: string;
  };
}

export interface LedgerAccountDocument {
  userId: string;
  currency: string;
  sequence: number;
  createdAt: Date;
  updatedAt: Date;
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
  settlementCompletedAt?: Date;
  createdAt: Date;
}

export interface DeliveryRecordDocument {
  auctionId: ObjectId;
  roundIndex: number;
  userId: string;
  deliveryRef: string;
  createdAt: Date;
}

export interface NotificationQueueDocument {
  type: "round_result";
  userId: string;
  auctionId: ObjectId;
  roundIndex: number;
  status: "pending" | "sent" | "failed";
  payload: Record<string, unknown>;
  idempotencyKey: string;
  attempts: number;
  nextAttemptAt: Date;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
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

const roundStateValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "auctionId",
      "roundIndex",
      "status",
      "scheduledStartAt",
      "scheduledEndAt",
      "effectiveEndAt",
      "extensionCount",
      "createdAt",
      "updatedAt"
    ],
    properties: {
      auctionId: { bsonType: "objectId" },
      roundIndex: { bsonType: bsonNumber },
      status: { bsonType: "string", enum: ["scheduled", "live", "closed"] },
      scheduledStartAt: { bsonType: "date" },
      scheduledEndAt: { bsonType: "date" },
      effectiveEndAt: { bsonType: "date" },
      extensionCount: { bsonType: bsonNumber },
      lastBidAt: { bsonType: "date" },
      startedAt: { bsonType: "date" },
      closedAt: { bsonType: "date" },
      createdAt: { bsonType: "date" },
      updatedAt: { bsonType: "date" }
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
      idempotencyKey: { bsonType: "string" },
      audit: {
        bsonType: "object",
        properties: {
          requestId: { bsonType: "string" },
          source: { bsonType: "string" },
          ip: { bsonType: "string" },
          userAgent: { bsonType: "string" },
          actorId: { bsonType: "string" }
        }
      }
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
      metadata: { bsonType: "object" },
      audit: {
        bsonType: "object",
        properties: {
          requestId: { bsonType: "string" },
          source: { bsonType: "string" },
          ip: { bsonType: "string" },
          userAgent: { bsonType: "string" },
          actorId: { bsonType: "string" }
        }
      }
    }
  }
};

const ledgerAccountValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: ["userId", "currency", "sequence", "createdAt", "updatedAt"],
    properties: {
      userId: { bsonType: "string" },
      currency: { bsonType: "string" },
      sequence: { bsonType: bsonNumber },
      createdAt: { bsonType: "date" },
      updatedAt: { bsonType: "date" }
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
      settlementCompletedAt: { bsonType: "date" },
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

const notificationQueueValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "type",
      "userId",
      "auctionId",
      "roundIndex",
      "status",
      "payload",
      "idempotencyKey",
      "attempts",
      "nextAttemptAt",
      "createdAt",
      "updatedAt"
    ],
    properties: {
      type: { bsonType: "string", enum: ["round_result"] },
      userId: { bsonType: "string" },
      auctionId: { bsonType: "objectId" },
      roundIndex: { bsonType: bsonNumber },
      status: { bsonType: "string", enum: ["pending", "sent", "failed"] },
      payload: { bsonType: "object" },
      idempotencyKey: { bsonType: "string" },
      attempts: { bsonType: bsonNumber },
      nextAttemptAt: { bsonType: "date" },
      lastError: { bsonType: "string" },
      createdAt: { bsonType: "date" },
      updatedAt: { bsonType: "date" }
    }
  }
};

export const mongoCollectionSpecs: Array<{ name: string; validator?: Document }> = [
  { name: mongoCollections.auctions, validator: auctionValidator },
  { name: mongoCollections.auctionRoundStates, validator: roundStateValidator },
  { name: mongoCollections.bids, validator: bidValidator },
  { name: mongoCollections.ledgerAccounts, validator: ledgerAccountValidator },
  { name: mongoCollections.ledgerEntries, validator: ledgerValidator },
  { name: mongoCollections.roundResults, validator: roundResultValidator },
  { name: mongoCollections.deliveryRecords, validator: deliveryValidator },
  { name: mongoCollections.notificationQueue, validator: notificationQueueValidator }
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
    collection: mongoCollections.auctionRoundStates,
    indexes: [
      {
        key: { auctionId: 1, roundIndex: 1 },
        name: "auction_round_state_unique",
        unique: true
      },
      { key: { auctionId: 1, status: 1 }, name: "auction_round_state_status" },
      { key: { status: 1, scheduledStartAt: 1 }, name: "auction_round_state_startAt" },
      { key: { status: 1, effectiveEndAt: 1 }, name: "auction_round_state_endAt" }
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
      { key: { userId: 1, currency: 1, createdAt: -1 }, name: "ledger_user_currency_createdAt" },
      { key: { idempotencyKey: 1 }, name: "ledger_idempotency", unique: true },
      {
        key: { "metadata.holdId": 1 },
        name: "ledger_hold_id",
        partialFilterExpression: { "metadata.holdId": { $exists: true } }
      },
      {
        key: { "metadata.withdrawalId": 1 },
        name: "ledger_withdrawal_id",
        partialFilterExpression: { "metadata.withdrawalId": { $exists: true } }
      }
    ]
  },
  {
    collection: mongoCollections.ledgerAccounts,
    indexes: [
      { key: { userId: 1, currency: 1 }, name: "ledger_accounts_user_currency", unique: true },
      { key: { updatedAt: -1 }, name: "ledger_accounts_updatedAt" }
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
  },
  {
    collection: mongoCollections.notificationQueue,
    indexes: [
      { key: { idempotencyKey: 1 }, name: "notification_idempotency", unique: true },
      { key: { status: 1, nextAttemptAt: 1 }, name: "notification_status_next" },
      { key: { userId: 1, createdAt: -1 }, name: "notification_user_createdAt" }
    ]
  }
];
