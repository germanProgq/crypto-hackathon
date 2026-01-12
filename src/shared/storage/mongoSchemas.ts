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
  cryptoWalletAddresses: "crypto_wallet_addresses",
  cryptoAddressPool: "crypto_address_pool",
  cryptoDeposits: "crypto_deposits",
  cryptoWithdrawals: "crypto_withdrawals",
  cryptoWithdrawalAllowlists: "crypto_withdrawal_allowlists",
  cryptoGatewayState: "crypto_gateway_state",
  cryptoCounters: "crypto_counters"
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

export type CryptoWalletStrategy = "address_pool" | "memo_tag";
export type CryptoDepositStatus = "observed" | "confirming" | "confirmed" | "credited";
export type CryptoWithdrawalStatus =
  | "requested"
  | "authorized"
  | "broadcasted"
  | "confirmed"
  | "failed";

export interface CryptoWalletAddressDocument {
  userId: string;
  currency: string;
  address: string;
  memo?: string;
  strategy: CryptoWalletStrategy;
  createdAt: Date;
  updatedAt: Date;
}

export interface CryptoAddressPoolDocument {
  currency: string;
  address: string;
  assignedTo?: string;
  assignedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CryptoDepositDocument {
  currency: string;
  txId: string;
  address: string;
  memo?: string;
  amount: number;
  confirmations: number;
  status: CryptoDepositStatus;
  userId?: string;
  blockHeight?: number;
  observedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  creditedAt?: Date;
  ledgerEntryId?: ObjectId;
}

export interface CryptoWithdrawalDocument {
  userId: string;
  currency: string;
  amount: number;
  destinationAddress: string;
  memo?: string;
  status: CryptoWithdrawalStatus;
  idempotencyKey: string;
  requestedAt: Date;
  authorizedAt?: Date;
  broadcastedAt?: Date;
  confirmedAt?: Date;
  failedAt?: Date;
  txId?: string;
  flags?: string[];
  reviewRequired?: boolean;
  failureReason?: string;
  authorizedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CryptoWithdrawalAllowlistDocument {
  userId: string;
  currency: string;
  address: string;
  label?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CryptoGatewayStateDocument {
  key: string;
  currency: string;
  cursor?: string;
  updatedAt: Date;
}

export interface CryptoCounterDocument {
  key: string;
  sequence: number;
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

const cryptoWalletAddressValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: ["userId", "currency", "address", "strategy", "createdAt", "updatedAt"],
    properties: {
      userId: { bsonType: "string" },
      currency: { bsonType: "string" },
      address: { bsonType: "string" },
      memo: { bsonType: "string" },
      strategy: { bsonType: "string", enum: ["address_pool", "memo_tag"] },
      createdAt: { bsonType: "date" },
      updatedAt: { bsonType: "date" }
    }
  }
};

const cryptoAddressPoolValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: ["currency", "address", "createdAt", "updatedAt"],
    properties: {
      currency: { bsonType: "string" },
      address: { bsonType: "string" },
      assignedTo: { bsonType: "string" },
      assignedAt: { bsonType: "date" },
      createdAt: { bsonType: "date" },
      updatedAt: { bsonType: "date" }
    }
  }
};

const cryptoDepositValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "currency",
      "txId",
      "address",
      "amount",
      "confirmations",
      "status",
      "observedAt",
      "createdAt",
      "updatedAt"
    ],
    properties: {
      currency: { bsonType: "string" },
      txId: { bsonType: "string" },
      address: { bsonType: "string" },
      memo: { bsonType: "string" },
      amount: { bsonType: bsonNumber },
      confirmations: { bsonType: bsonNumber },
      status: {
        bsonType: "string",
        enum: ["observed", "confirming", "confirmed", "credited"]
      },
      userId: { bsonType: "string" },
      blockHeight: { bsonType: bsonNumber },
      observedAt: { bsonType: "date" },
      createdAt: { bsonType: "date" },
      updatedAt: { bsonType: "date" },
      creditedAt: { bsonType: "date" },
      ledgerEntryId: { bsonType: "objectId" }
    }
  }
};

const cryptoWithdrawalValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "userId",
      "currency",
      "amount",
      "destinationAddress",
      "status",
      "idempotencyKey",
      "requestedAt",
      "createdAt",
      "updatedAt"
    ],
    properties: {
      userId: { bsonType: "string" },
      currency: { bsonType: "string" },
      amount: { bsonType: bsonNumber },
      destinationAddress: { bsonType: "string" },
      memo: { bsonType: "string" },
      status: {
        bsonType: "string",
        enum: ["requested", "authorized", "broadcasted", "confirmed", "failed"]
      },
      idempotencyKey: { bsonType: "string" },
      requestedAt: { bsonType: "date" },
      authorizedAt: { bsonType: "date" },
      broadcastedAt: { bsonType: "date" },
      confirmedAt: { bsonType: "date" },
      failedAt: { bsonType: "date" },
      txId: { bsonType: "string" },
      flags: { bsonType: "array", items: { bsonType: "string" } },
      reviewRequired: { bsonType: "bool" },
      failureReason: { bsonType: "string" },
      authorizedBy: { bsonType: "string" },
      createdAt: { bsonType: "date" },
      updatedAt: { bsonType: "date" }
    }
  }
};

const cryptoWithdrawalAllowlistValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: ["userId", "currency", "address", "createdAt", "updatedAt"],
    properties: {
      userId: { bsonType: "string" },
      currency: { bsonType: "string" },
      address: { bsonType: "string" },
      label: { bsonType: "string" },
      createdAt: { bsonType: "date" },
      updatedAt: { bsonType: "date" }
    }
  }
};

const cryptoGatewayStateValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: ["key", "currency", "updatedAt"],
    properties: {
      key: { bsonType: "string" },
      currency: { bsonType: "string" },
      cursor: { bsonType: "string" },
      updatedAt: { bsonType: "date" }
    }
  }
};

const cryptoCounterValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: ["key", "sequence", "updatedAt"],
    properties: {
      key: { bsonType: "string" },
      sequence: { bsonType: bsonNumber },
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
  { name: mongoCollections.cryptoWalletAddresses, validator: cryptoWalletAddressValidator },
  { name: mongoCollections.cryptoAddressPool, validator: cryptoAddressPoolValidator },
  { name: mongoCollections.cryptoDeposits, validator: cryptoDepositValidator },
  { name: mongoCollections.cryptoWithdrawals, validator: cryptoWithdrawalValidator },
  {
    name: mongoCollections.cryptoWithdrawalAllowlists,
    validator: cryptoWithdrawalAllowlistValidator
  },
  { name: mongoCollections.cryptoGatewayState, validator: cryptoGatewayStateValidator },
  { name: mongoCollections.cryptoCounters, validator: cryptoCounterValidator }
];

export const mongoIndexSpecs: Array<{ collection: string; indexes: IndexDescription[] }> = [
  {
    collection: mongoCollections.auctions,
    indexes: [
      { key: { status: 1, startsAt: 1 }, name: "auctions_status_startsAt" },
      { key: { status: 1, endsAt: -1 }, name: "auctions_status_endsAt" },
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
  },
  {
    collection: mongoCollections.cryptoWalletAddresses,
    indexes: [
      {
        key: { userId: 1, currency: 1 },
        name: "crypto_wallet_user_currency",
        unique: true
      },
      {
        key: { currency: 1, address: 1 },
        name: "crypto_wallet_currency_address",
        unique: true
      },
      {
        key: { currency: 1, memo: 1 },
        name: "crypto_wallet_currency_memo",
        unique: true,
        partialFilterExpression: { memo: { $exists: true } }
      }
    ]
  },
  {
    collection: mongoCollections.cryptoAddressPool,
    indexes: [
      {
        key: { currency: 1, address: 1 },
        name: "crypto_pool_currency_address",
        unique: true
      },
      { key: { currency: 1, assignedTo: 1 }, name: "crypto_pool_currency_assigned" }
    ]
  },
  {
    collection: mongoCollections.cryptoDeposits,
    indexes: [
      { key: { currency: 1, txId: 1 }, name: "crypto_deposits_tx", unique: true },
      { key: { status: 1, updatedAt: 1 }, name: "crypto_deposits_status_updated" },
      { key: { userId: 1, observedAt: -1 }, name: "crypto_deposits_user_observed" }
    ]
  },
  {
    collection: mongoCollections.cryptoWithdrawals,
    indexes: [
      { key: { idempotencyKey: 1 }, name: "crypto_withdrawals_idempotency", unique: true },
      { key: { status: 1, updatedAt: 1 }, name: "crypto_withdrawals_status_updated" },
      { key: { userId: 1, requestedAt: -1 }, name: "crypto_withdrawals_user_requested" },
      {
        key: { txId: 1 },
        name: "crypto_withdrawals_tx",
        unique: true,
        partialFilterExpression: { txId: { $exists: true } }
      }
    ]
  },
  {
    collection: mongoCollections.cryptoWithdrawalAllowlists,
    indexes: [
      {
        key: { userId: 1, currency: 1, address: 1 },
        name: "crypto_allowlist_user_currency_address",
        unique: true
      },
      { key: { userId: 1, currency: 1 }, name: "crypto_allowlist_user_currency" }
    ]
  },
  {
    collection: mongoCollections.cryptoGatewayState,
    indexes: [
      { key: { key: 1, currency: 1 }, name: "crypto_gateway_state_unique", unique: true }
    ]
  },
  {
    collection: mongoCollections.cryptoCounters,
    indexes: [{ key: { key: 1 }, name: "crypto_counters_unique", unique: true }]
  }
];
