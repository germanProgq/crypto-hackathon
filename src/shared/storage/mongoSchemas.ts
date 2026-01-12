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
  notificationQueue: "notification_queue",
  depositAddresses: "deposit_addresses",
  depositWatchlist: "deposit_watchlist",
  withdrawalRequests: "withdrawal_requests"
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

export type DepositStatus = "pending" | "confirmed" | "credited";
export type WithdrawalStatus =
  | "requested"
  | "authorized"
  | "broadcasted"
  | "confirmed"
  | "failed";
export type WalletStrategy = "address_per_user" | "memo_tag";

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
  userId: string;
  amount: number;
  createdAt: Date;
  idempotencyKey: string;
  active: boolean;
  roundIndex?: number;
  inactiveAt?: Date;
  settledAt?: Date;
  settlementAction?: "captured" | "released";
  settlementRoundIndex?: number;
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

export type NotificationType =
  | "round_result"
  | "bid_confirmed"
  | "withdrawal_broadcasted"
  | "withdrawal_confirmed"
  | "withdrawal_failed"
  | "auction_starting"
  | "round_starting";

export interface NotificationQueueDocument {
  type: NotificationType;
  userId: string;
  auctionId?: ObjectId;
  roundIndex?: number;
  status: "pending" | "sent" | "failed";
  payload: Record<string, unknown>;
  idempotencyKey: string;
  attempts: number;
  nextAttemptAt: Date;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DepositAddressDocument {
  userId: string;
  currency: string;
  strategy: WalletStrategy;
  address: string;
  memo?: string;
  derivationPath?: string;
  createdAt: Date;
  lastUsedAt?: Date;
}

export interface DepositWatchlistDocument {
  txHash: string;
  currency: string;
  userId: string;
  address: string;
  memo?: string;
  amount: number;
  confirmations: number;
  requiredConfirmations: number;
  status: DepositStatus;
  detectedAt: Date;
  confirmedAt?: Date;
  creditedAt?: Date;
  ledgerEntryId?: ObjectId;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface WithdrawalRequestDocument {
  userId: string;
  currency: string;
  amount: number;
  destinationAddress: string;
  destinationMemo?: string;
  status: WithdrawalStatus;
  requestedAt: Date;
  authorizedAt?: Date;
  broadcastedAt?: Date;
  confirmedAt?: Date;
  failedAt?: Date;
  txHash?: string;
  confirmations: number;
  requiredConfirmations: number;
  ledgerWithdrawalId: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  safetyChecks?: {
    addressAllowlisted: boolean;
    underDailyLimit: boolean;
    cooldownPassed: boolean;
    anomalyDetected: boolean;
    anomalyReasons?: string[];
  };
  failureReason?: string;
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
    required: ["auctionId", "userId", "amount", "createdAt", "idempotencyKey", "active"],
    properties: {
      auctionId: { bsonType: "objectId" },
      userId: { bsonType: "string" },
      amount: { bsonType: bsonNumber },
      createdAt: { bsonType: "date" },
      idempotencyKey: { bsonType: "string" },
      active: { bsonType: "bool" },
      roundIndex: { bsonType: bsonNumber },
      inactiveAt: { bsonType: "date" },
      settledAt: { bsonType: "date" },
      settlementAction: { bsonType: "string", enum: ["captured", "released"] },
      settlementRoundIndex: { bsonType: bsonNumber },
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
      "status",
      "payload",
      "idempotencyKey",
      "attempts",
      "nextAttemptAt",
      "createdAt",
      "updatedAt"
    ],
    properties: {
      type: {
        bsonType: "string",
        enum: [
          "round_result",
          "bid_confirmed",
          "withdrawal_broadcasted",
          "withdrawal_confirmed",
          "withdrawal_failed",
          "auction_starting",
          "round_starting"
        ]
      },
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

const depositAddressValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: ["userId", "currency", "strategy", "address", "createdAt"],
    properties: {
      userId: { bsonType: "string" },
      currency: { bsonType: "string" },
      strategy: { bsonType: "string", enum: ["address_per_user", "memo_tag"] },
      address: { bsonType: "string" },
      memo: { bsonType: "string" },
      derivationPath: { bsonType: "string" },
      createdAt: { bsonType: "date" },
      lastUsedAt: { bsonType: "date" }
    }
  }
};

const depositWatchlistValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "txHash",
      "currency",
      "userId",
      "address",
      "amount",
      "confirmations",
      "requiredConfirmations",
      "status",
      "detectedAt",
      "idempotencyKey",
      "createdAt",
      "updatedAt"
    ],
    properties: {
      txHash: { bsonType: "string" },
      currency: { bsonType: "string" },
      userId: { bsonType: "string" },
      address: { bsonType: "string" },
      memo: { bsonType: "string" },
      amount: { bsonType: bsonNumber },
      confirmations: { bsonType: bsonNumber },
      requiredConfirmations: { bsonType: bsonNumber },
      status: { bsonType: "string", enum: ["pending", "confirmed", "credited"] },
      detectedAt: { bsonType: "date" },
      confirmedAt: { bsonType: "date" },
      creditedAt: { bsonType: "date" },
      ledgerEntryId: { bsonType: "objectId" },
      idempotencyKey: { bsonType: "string" },
      metadata: { bsonType: "object" },
      createdAt: { bsonType: "date" },
      updatedAt: { bsonType: "date" }
    }
  }
};

const withdrawalRequestValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "userId",
      "currency",
      "amount",
      "destinationAddress",
      "status",
      "requestedAt",
      "confirmations",
      "requiredConfirmations",
      "ledgerWithdrawalId",
      "idempotencyKey",
      "createdAt",
      "updatedAt"
    ],
    properties: {
      userId: { bsonType: "string" },
      currency: { bsonType: "string" },
      amount: { bsonType: bsonNumber },
      destinationAddress: { bsonType: "string" },
      destinationMemo: { bsonType: "string" },
      status: {
        bsonType: "string",
        enum: ["requested", "authorized", "broadcasted", "confirmed", "failed"]
      },
      requestedAt: { bsonType: "date" },
      authorizedAt: { bsonType: "date" },
      broadcastedAt: { bsonType: "date" },
      confirmedAt: { bsonType: "date" },
      failedAt: { bsonType: "date" },
      txHash: { bsonType: "string" },
      confirmations: { bsonType: bsonNumber },
      requiredConfirmations: { bsonType: bsonNumber },
      ledgerWithdrawalId: { bsonType: "string" },
      idempotencyKey: { bsonType: "string" },
      metadata: { bsonType: "object" },
      safetyChecks: { bsonType: "object" },
      failureReason: { bsonType: "string" },
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
  { name: mongoCollections.notificationQueue, validator: notificationQueueValidator },
  { name: mongoCollections.depositAddresses, validator: depositAddressValidator },
  { name: mongoCollections.depositWatchlist, validator: depositWatchlistValidator },
  { name: mongoCollections.withdrawalRequests, validator: withdrawalRequestValidator }
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
        key: { auctionId: 1, active: 1, amount: -1, createdAt: 1 },
        name: "bids_rank_active"
      },
      { key: { userId: 1, createdAt: -1 }, name: "bids_user_createdAt" },
      { key: { auctionId: 1, userId: 1 }, name: "bids_auction_user" },
      {
        key: { auctionId: 1, userId: 1, active: 1 },
        name: "bids_active_unique",
        unique: true,
        partialFilterExpression: { active: true }
      },
      {
        key: { auctionId: 1, userId: 1, settledAt: 1 },
        name: "bids_settlement_lookup"
      },
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
  },
  {
    collection: mongoCollections.depositAddresses,
    indexes: [
      { key: { userId: 1, currency: 1 }, name: "deposit_address_user_currency", unique: true },
      { key: { address: 1, currency: 1 }, name: "deposit_address_lookup" },
      { key: { address: 1, memo: 1, currency: 1 }, name: "deposit_address_memo_lookup" },
      { key: { createdAt: -1 }, name: "deposit_address_created" }
    ]
  },
  {
    collection: mongoCollections.depositWatchlist,
    indexes: [
      { key: { txHash: 1, currency: 1 }, name: "deposit_watchlist_tx", unique: true },
      { key: { idempotencyKey: 1 }, name: "deposit_watchlist_idempotency", unique: true },
      { key: { userId: 1, createdAt: -1 }, name: "deposit_watchlist_user" },
      { key: { status: 1, confirmations: 1 }, name: "deposit_watchlist_status" },
      { key: { status: 1, updatedAt: 1 }, name: "deposit_watchlist_processing" }
    ]
  },
  {
    collection: mongoCollections.withdrawalRequests,
    indexes: [
      { key: { ledgerWithdrawalId: 1 }, name: "withdrawal_ledger_id", unique: true },
      { key: { idempotencyKey: 1 }, name: "withdrawal_idempotency", unique: true },
      { key: { userId: 1, createdAt: -1 }, name: "withdrawal_user_created" },
      { key: { status: 1, updatedAt: 1 }, name: "withdrawal_status_updated" },
      { key: { txHash: 1 }, name: "withdrawal_tx_hash" },
      {
        key: { userId: 1, status: 1, requestedAt: -1 },
        name: "withdrawal_user_status_requested"
      }
    ]
  }
];
