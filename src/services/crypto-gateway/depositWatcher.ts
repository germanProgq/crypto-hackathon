// Deposit watcher with confirmation thresholds and idempotent crediting.
import type { Collection, ObjectId } from "mongodb";
import type { MongoDependencies } from "../../shared/storage/mongo.js";
import { runMongoTransaction } from "../../shared/storage/mongoTransaction.js";
import {
  mongoCollections,
  type DepositWatchlistDocument,
  type DepositStatus
} from "../../shared/storage/mongoSchemas.js";
import type { DepositAddressService } from "./depositAddressService.js";
import type { LedgerMutationResult } from "../ledger/ledgerStore.js";

export interface IncomingDeposit {
  txHash: string;
  currency: string;
  address: string;
  memo?: string;
  amount: number;
  confirmations: number;
  detectedAt: Date;
  metadata?: Record<string, unknown>;
}

export interface DepositWatcherService {
  processIncomingDeposit(deposit: IncomingDeposit): Promise<void>;
  updateConfirmations(txHash: string, currency: string, confirmations: number): Promise<void>;
  getPendingDeposits(currency?: string): Promise<DepositWatchlistDocument[]>;
}

export interface DepositWatcherDependencies {
  mongo: MongoDependencies;
  depositAddressService: DepositAddressService;
  ledgerService: {
    createEntry: (input: {
      userId: string;
      entryType: "deposit_confirmed";
      amount: number;
      currency: string;
      idempotencyKey: string;
      metadata?: Record<string, unknown>;
      audit?: {
        source?: string;
        requestId?: string;
      };
    }) => Promise<LedgerMutationResult>;
  };
  confirmationThresholds: Record<string, number>;
}

export function createDepositWatcher(deps: DepositWatcherDependencies): DepositWatcherService {
  const collection = deps.mongo.db.collection<DepositWatchlistDocument>(
    mongoCollections.depositWatchlist
  );

  async function processIncomingDeposit(deposit: IncomingDeposit): Promise<void> {
    const depositAddress = await deps.depositAddressService.findByAddress(
      deposit.address,
      deposit.currency,
      deposit.memo
    );

    if (!depositAddress) {
      return;
    }

    const requiredConfirmations = deps.confirmationThresholds[deposit.currency] ?? 6;
    const idempotencyKey = `deposit:${deposit.txHash}:${deposit.currency}`;

    const existing = await collection.findOne({
      txHash: deposit.txHash,
      currency: deposit.currency
    });

    if (existing) {
      return;
    }

    const now = new Date();
    const status: DepositStatus = deposit.confirmations >= requiredConfirmations
      ? "confirmed"
      : "pending";

    const document: DepositWatchlistDocument = {
      txHash: deposit.txHash,
      currency: deposit.currency,
      userId: depositAddress.userId,
      address: deposit.address,
      memo: deposit.memo,
      amount: deposit.amount,
      confirmations: deposit.confirmations,
      requiredConfirmations,
      status,
      detectedAt: deposit.detectedAt,
      confirmedAt: status === "confirmed" ? now : undefined,
      idempotencyKey,
      metadata: deposit.metadata,
      createdAt: now,
      updatedAt: now
    };

    await collection.insertOne(document);

    if (status === "confirmed") {
      await creditDeposit(document);
    }

    await deps.depositAddressService.updateLastUsed(
      depositAddress.userId,
      deposit.currency
    );
  }

  async function updateConfirmations(
    txHash: string,
    currency: string,
    confirmations: number
  ): Promise<void> {
    const deposit = await collection.findOne({ txHash, currency });

    if (!deposit) {
      return;
    }

    if (deposit.status === "credited") {
      return;
    }

    const now = new Date();
    const shouldConfirm = confirmations >= deposit.requiredConfirmations;

    if (shouldConfirm && deposit.status === "pending") {
      await collection.updateOne(
        { txHash, currency },
        {
          $set: {
            confirmations,
            status: "confirmed",
            confirmedAt: now,
            updatedAt: now
          }
        }
      );

      const updated = await collection.findOne({ txHash, currency });
      if (updated && updated.status === "confirmed") {
        await creditDeposit(updated);
      }
    } else if (deposit.confirmations !== confirmations) {
      await collection.updateOne(
        { txHash, currency },
        {
          $set: {
            confirmations,
            updatedAt: now
          }
        }
      );
    }
  }

  async function creditDeposit(deposit: DepositWatchlistDocument): Promise<void> {
    if (deposit.status === "credited") {
      return;
    }

    try {
      const result = await deps.ledgerService.createEntry({
        userId: deposit.userId,
        entryType: "deposit_confirmed",
        amount: deposit.amount,
        currency: deposit.currency,
        idempotencyKey: deposit.idempotencyKey,
        metadata: {
          txHash: deposit.txHash,
          address: deposit.address,
          memo: deposit.memo,
          ...deposit.metadata
        },
        audit: {
          source: "deposit_watcher",
          requestId: deposit.txHash
        }
      });

      await collection.updateOne(
        { txHash: deposit.txHash, currency: deposit.currency },
        {
          $set: {
            status: "credited",
            creditedAt: new Date(),
            ledgerEntryId: result.entry._id as ObjectId,
            updatedAt: new Date()
          }
        }
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("idempotency")) {
        await collection.updateOne(
          { txHash: deposit.txHash, currency: deposit.currency },
          {
            $set: {
              status: "credited",
              creditedAt: new Date(),
              updatedAt: new Date()
            }
          }
        );
      } else {
        throw error;
      }
    }
  }

  async function getPendingDeposits(currency?: string): Promise<DepositWatchlistDocument[]> {
    const query: Record<string, unknown> = {
      status: { $in: ["pending", "confirmed"] }
    };

    if (currency) {
      query.currency = currency;
    }

    return collection
      .find(query)
      .sort({ updatedAt: 1 })
      .limit(100)
      .toArray();
  }

  return {
    processIncomingDeposit,
    updateConfirmations,
    getPendingDeposits
  };
}
