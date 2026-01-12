// Withdrawal state machine with safety controls and authorization.
import { randomUUID } from "node:crypto";
import type { Collection, ObjectId } from "mongodb";
import type { MongoDependencies } from "../../shared/storage/mongo.js";
import { runMongoTransaction } from "../../shared/storage/mongoTransaction.js";
import {
  mongoCollections,
  type WithdrawalRequestDocument,
  type WithdrawalStatus
} from "../../shared/storage/mongoSchemas.js";

export interface WithdrawalRequest {
  userId: string;
  currency: string;
  amount: number;
  destinationAddress: string;
  destinationMemo?: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface WithdrawalSafetyChecks {
  addressAllowlisted: boolean;
  underDailyLimit: boolean;
  cooldownPassed: boolean;
  anomalyDetected: boolean;
  anomalyReasons?: string[];
}

export interface WithdrawalServiceDependencies {
  mongo: MongoDependencies;
  ledgerService: {
    requestWithdrawal: (input: {
      userId: string;
      amount: number;
      currency: string;
      withdrawalId: string;
      idempotencyKey: string;
      metadata?: Record<string, unknown>;
      audit?: { source?: string };
    }) => Promise<{ entry: { _id: ObjectId }; balance: unknown }>;
    broadcastWithdrawal: (input: {
      userId: string;
      amount: number;
      currency: string;
      withdrawalId: string;
      idempotencyKey: string;
      metadata?: Record<string, unknown>;
      audit?: { source?: string };
    }) => Promise<{ _id: ObjectId }>;
    confirmWithdrawal: (input: {
      userId: string;
      amount: number;
      currency: string;
      withdrawalId: string;
      idempotencyKey: string;
      metadata?: Record<string, unknown>;
      audit?: { source?: string };
    }) => Promise<{ entry: { _id: ObjectId }; balance: unknown }>;
    failWithdrawal: (input: {
      userId: string;
      amount: number;
      currency: string;
      withdrawalId: string;
      idempotencyKey: string;
      metadata?: Record<string, unknown>;
      audit?: { source?: string };
    }) => Promise<{ entry: { _id: ObjectId }; balance: unknown }>;
  };
  safetyValidator: WithdrawalSafetyValidator;
  confirmationThresholds: Record<string, number>;
}

export interface WithdrawalSafetyValidator {
  validateWithdrawal(
    request: WithdrawalRequest
  ): Promise<{ valid: boolean; checks: WithdrawalSafetyChecks }>;
}

export interface WithdrawalService {
  requestWithdrawal(request: WithdrawalRequest): Promise<WithdrawalRequestDocument>;
  authorizeWithdrawal(withdrawalId: string): Promise<WithdrawalRequestDocument>;
  broadcastWithdrawal(
    withdrawalId: string,
    txHash: string
  ): Promise<WithdrawalRequestDocument>;
  confirmWithdrawal(withdrawalId: string, confirmations: number): Promise<void>;
  failWithdrawal(withdrawalId: string, reason: string): Promise<WithdrawalRequestDocument>;
  getWithdrawal(withdrawalId: string): Promise<WithdrawalRequestDocument | null>;
  getUserWithdrawals(userId: string, limit?: number): Promise<WithdrawalRequestDocument[]>;
  getPendingWithdrawals(): Promise<WithdrawalRequestDocument[]>;
}

export function createWithdrawalService(
  deps: WithdrawalServiceDependencies
): WithdrawalService {
  const collection = deps.mongo.db.collection<WithdrawalRequestDocument>(
    mongoCollections.withdrawalRequests
  );

  async function requestWithdrawal(
    request: WithdrawalRequest
  ): Promise<WithdrawalRequestDocument> {
    const existing = await collection.findOne({ idempotencyKey: request.idempotencyKey });

    if (existing) {
      return existing;
    }

    const validation = await deps.safetyValidator.validateWithdrawal(request);

    if (!validation.valid) {
      throw new WithdrawalError(
        "safety_check_failed",
        "Withdrawal failed safety checks",
        400,
        validation.checks
      );
    }

    const withdrawalId = randomUUID();
    const requiredConfirmations = deps.confirmationThresholds[request.currency] ?? 6;
    const now = new Date();

    const document: WithdrawalRequestDocument = {
      userId: request.userId,
      currency: request.currency,
      amount: request.amount,
      destinationAddress: request.destinationAddress,
      destinationMemo: request.destinationMemo,
      status: "requested",
      requestedAt: now,
      confirmations: 0,
      requiredConfirmations,
      ledgerWithdrawalId: withdrawalId,
      idempotencyKey: request.idempotencyKey,
      metadata: request.metadata,
      safetyChecks: validation.checks,
      createdAt: now,
      updatedAt: now
    };

    await runMongoTransaction(deps.mongo, async (session) => {
      await deps.ledgerService.requestWithdrawal({
        userId: request.userId,
        amount: request.amount,
        currency: request.currency,
        withdrawalId,
        idempotencyKey: `${request.idempotencyKey}:ledger:requested`,
        metadata: {
          destinationAddress: request.destinationAddress,
          destinationMemo: request.destinationMemo,
          ...request.metadata
        },
        audit: { source: "withdrawal_service" }
      });

      await collection.insertOne(document, { session });
    });

    const inserted = await collection.findOne({ ledgerWithdrawalId: withdrawalId });
    if (!inserted) {
      throw new WithdrawalError("internal_error", "Failed to create withdrawal", 500);
    }

    return inserted;
  }

  async function authorizeWithdrawal(withdrawalId: string): Promise<WithdrawalRequestDocument> {
    const withdrawal = await collection.findOne({ ledgerWithdrawalId: withdrawalId });

    if (!withdrawal) {
      throw new WithdrawalError("not_found", "Withdrawal not found", 404);
    }

    if (withdrawal.status !== "requested") {
      throw new WithdrawalError(
        "invalid_state",
        `Cannot authorize withdrawal in status: ${withdrawal.status}`,
        400
      );
    }

    const now = new Date();

    await collection.updateOne(
      { ledgerWithdrawalId: withdrawalId, status: "requested" },
      {
        $set: {
          status: "authorized",
          authorizedAt: now,
          updatedAt: now
        }
      }
    );

    const updated = await collection.findOne({ ledgerWithdrawalId: withdrawalId });
    if (!updated) {
      throw new WithdrawalError("internal_error", "Failed to authorize withdrawal", 500);
    }

    return updated;
  }

  async function broadcastWithdrawal(
    withdrawalId: string,
    txHash: string
  ): Promise<WithdrawalRequestDocument> {
    const withdrawal = await collection.findOne({ ledgerWithdrawalId: withdrawalId });

    if (!withdrawal) {
      throw new WithdrawalError("not_found", "Withdrawal not found", 404);
    }

    if (withdrawal.status !== "authorized") {
      throw new WithdrawalError(
        "invalid_state",
        `Cannot broadcast withdrawal in status: ${withdrawal.status}`,
        400
      );
    }

    const now = new Date();

    await runMongoTransaction(deps.mongo, async (session) => {
      await deps.ledgerService.broadcastWithdrawal({
        userId: withdrawal.userId,
        amount: withdrawal.amount,
        currency: withdrawal.currency,
        withdrawalId,
        idempotencyKey: `${withdrawal.idempotencyKey}:ledger:broadcasted`,
        metadata: {
          txHash,
          destinationAddress: withdrawal.destinationAddress
        },
        audit: { source: "withdrawal_service" }
      });

      await collection.updateOne(
        { ledgerWithdrawalId: withdrawalId, status: "authorized" },
        {
          $set: {
            status: "broadcasted",
            txHash,
            broadcastedAt: now,
            updatedAt: now
          }
        },
        { session }
      );
    });

    const updated = await collection.findOne({ ledgerWithdrawalId: withdrawalId });
    if (!updated) {
      throw new WithdrawalError("internal_error", "Failed to broadcast withdrawal", 500);
    }

    return updated;
  }

  async function confirmWithdrawal(withdrawalId: string, confirmations: number): Promise<void> {
    const withdrawal = await collection.findOne({ ledgerWithdrawalId: withdrawalId });

    if (!withdrawal) {
      return;
    }

    if (withdrawal.status === "confirmed" || withdrawal.status === "failed") {
      return;
    }

    if (withdrawal.status !== "broadcasted") {
      return;
    }

    const now = new Date();

    if (confirmations >= withdrawal.requiredConfirmations) {
      await runMongoTransaction(deps.mongo, async (session) => {
        await deps.ledgerService.confirmWithdrawal({
          userId: withdrawal.userId,
          amount: withdrawal.amount,
          currency: withdrawal.currency,
          withdrawalId,
          idempotencyKey: `${withdrawal.idempotencyKey}:ledger:confirmed`,
          metadata: {
            txHash: withdrawal.txHash,
            confirmations
          },
          audit: { source: "withdrawal_service" }
        });

        await collection.updateOne(
          { ledgerWithdrawalId: withdrawalId, status: "broadcasted" },
          {
            $set: {
              status: "confirmed",
              confirmations,
              confirmedAt: now,
              updatedAt: now
            }
          },
          { session }
        );
      });
    } else if (withdrawal.confirmations !== confirmations) {
      await collection.updateOne(
        { ledgerWithdrawalId: withdrawalId },
        {
          $set: {
            confirmations,
            updatedAt: now
          }
        }
      );
    }
  }

  async function failWithdrawal(
    withdrawalId: string,
    reason: string
  ): Promise<WithdrawalRequestDocument> {
    const withdrawal = await collection.findOne({ ledgerWithdrawalId: withdrawalId });

    if (!withdrawal) {
      throw new WithdrawalError("not_found", "Withdrawal not found", 404);
    }

    if (withdrawal.status === "confirmed" || withdrawal.status === "failed") {
      throw new WithdrawalError(
        "invalid_state",
        `Cannot fail withdrawal in status: ${withdrawal.status}`,
        400
      );
    }

    const now = new Date();

    await runMongoTransaction(deps.mongo, async (session) => {
      await deps.ledgerService.failWithdrawal({
        userId: withdrawal.userId,
        amount: withdrawal.amount,
        currency: withdrawal.currency,
        withdrawalId,
        idempotencyKey: `${withdrawal.idempotencyKey}:ledger:failed`,
        metadata: {
          failureReason: reason,
          txHash: withdrawal.txHash
        },
        audit: { source: "withdrawal_service" }
      });

      await collection.updateOne(
        { ledgerWithdrawalId: withdrawalId },
        {
          $set: {
            status: "failed",
            failureReason: reason,
            failedAt: now,
            updatedAt: now
          }
        },
        { session }
      );
    });

    const updated = await collection.findOne({ ledgerWithdrawalId: withdrawalId });
    if (!updated) {
      throw new WithdrawalError("internal_error", "Failed to fail withdrawal", 500);
    }

    return updated;
  }

  async function getWithdrawal(withdrawalId: string): Promise<WithdrawalRequestDocument | null> {
    return collection.findOne({ ledgerWithdrawalId: withdrawalId });
  }

  async function getUserWithdrawals(
    userId: string,
    limit = 50
  ): Promise<WithdrawalRequestDocument[]> {
    return collection
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(Math.min(limit, 200))
      .toArray();
  }

  async function getPendingWithdrawals(): Promise<WithdrawalRequestDocument[]> {
    return collection
      .find({
        status: { $in: ["requested", "authorized", "broadcasted"] }
      })
      .sort({ updatedAt: 1 })
      .limit(100)
      .toArray();
  }

  return {
    requestWithdrawal,
    authorizeWithdrawal,
    broadcastWithdrawal,
    confirmWithdrawal,
    failWithdrawal,
    getWithdrawal,
    getUserWithdrawals,
    getPendingWithdrawals
  };
}

export class WithdrawalError extends Error {
  readonly code: string;
  readonly status: number;
  readonly safetyChecks?: WithdrawalSafetyChecks;

  constructor(
    code: string,
    message: string,
    status: number,
    safetyChecks?: WithdrawalSafetyChecks
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.safetyChecks = safetyChecks;
  }
}
