// Crypto gateway workflows for deposits and withdrawals.
import { MongoServerError, ObjectId, type WithId } from "mongodb";
import type { ServiceDependencies } from "../../shared/service.js";
import { runMongoTransaction } from "../../shared/storage/mongoTransaction.js";
import {
  mongoCollections,
  type CryptoDepositDocument,
  type CryptoGatewayStateDocument,
  type CryptoWithdrawalAllowlistDocument,
  type CryptoWithdrawalDocument
} from "../../shared/storage/mongoSchemas.js";
import { createLedgerRepository, type LedgerBalance } from "../ledger/ledgerStore.js";
import { createObserverClient } from "./observerClient.js";
import { createSignerClient } from "./signerClient.js";
import type { ObserverTransaction, WithdrawalSigningPayload } from "./types.js";
import { createWalletStrategy, type DepositDestination } from "./walletStrategy.js";

const depositBatchSize = 100;
const withdrawalBatchSize = 50;
const minDepositScanDelayMs = 250;

export type CryptoGatewayErrorCode =
  | "invalid_request"
  | "unsupported_currency"
  | "withdrawal_not_found"
  | "withdrawal_conflict"
  | "idempotency_conflict";

export class CryptoGatewayError extends Error {
  readonly code: CryptoGatewayErrorCode;
  readonly status: number;

  constructor(code: CryptoGatewayErrorCode, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface WithdrawalRequestInput {
  userId: string;
  currency: string;
  amount: number;
  destinationAddress: string;
  memo?: string;
  idempotencyKey: string;
}

export interface WithdrawalRequestResult {
  withdrawal: WithId<CryptoWithdrawalDocument>;
  balance: LedgerBalance;
  decision: "approve" | "review" | "reject";
  flags: string[];
  violations: string[];
}

export interface WithdrawalDecision {
  decision: "approve" | "review" | "reject";
  flags: string[];
  violations: string[];
}

export function createCryptoGatewayService(deps: ServiceDependencies) {
  const ledger = createLedgerRepository(deps.mongo, {
    retentionDays: deps.config.dataRetention.ledgerDays
  });
  const walletStrategy = createWalletStrategy(deps.mongo, deps.config.crypto);
  const observer = createObserverClient(deps.config.crypto);
  const signer = createSignerClient(deps.config.crypto);

  const deposits = deps.mongo.db.collection<CryptoDepositDocument>(
    mongoCollections.cryptoDeposits
  );
  const withdrawals = deps.mongo.db.collection<CryptoWithdrawalDocument>(
    mongoCollections.cryptoWithdrawals
  );
  const allowlists = deps.mongo.db.collection<CryptoWithdrawalAllowlistDocument>(
    mongoCollections.cryptoWithdrawalAllowlists
  );
  const gatewayState = deps.mongo.db.collection<CryptoGatewayStateDocument>(
    mongoCollections.cryptoGatewayState
  );
  const depositPollIntervalMs = deps.config.crypto.deposit.pollIntervalMs;
  const withdrawalPollIntervalMs = deps.config.crypto.withdrawal.pollIntervalMs;
  const withdrawalBroadcastIntervalMs = deps.config.crypto.withdrawal.broadcastIntervalMs;
  const idleDepositScanDelayMs = Math.max(depositPollIntervalMs, 15000);

  async function getDepositDestination(
    userId: string,
    currency: string
  ): Promise<DepositDestination> {
    const normalized = normalizeCurrency(currency);
    assertSupportedCurrency(normalized);
    return walletStrategy.getDepositDestination(userId, normalized);
  }

  async function addAllowlistEntry(input: {
    userId: string;
    currency: string;
    address: string;
    label?: string;
  }): Promise<WithId<CryptoWithdrawalAllowlistDocument>> {
    const normalized = normalizeCurrency(input.currency);
    assertSupportedCurrency(normalized);
    const now = new Date();
    const setOnInsert: Record<string, unknown> = {
      userId: input.userId,
      currency: normalized,
      address: input.address,
      createdAt: now
    };
    const update: Record<string, unknown> = {
      updatedAt: now
    };
    if (input.label) {
      update.label = input.label;
    }
    const result = await allowlists.findOneAndUpdate(
      { userId: input.userId, currency: normalized, address: input.address },
      {
        $setOnInsert: setOnInsert,
        $set: update
      },
      { upsert: true, returnDocument: "after" }
    );

    if (!result) {
      throw new CryptoGatewayError("invalid_request", "Allowlist update failed.", 500);
    }

    return result;
  }

  async function requestWithdrawal(input: WithdrawalRequestInput): Promise<WithdrawalRequestResult> {
    const normalized = normalizeCurrency(input.currency);
    assertSupportedCurrency(normalized);
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new CryptoGatewayError("invalid_request", "Withdrawal amount must be positive.", 400);
    }
    if (!input.destinationAddress || input.destinationAddress.trim().length === 0) {
      throw new CryptoGatewayError("invalid_request", "Destination address is required.", 400);
    }

    const existing = await withdrawals.findOne({ idempotencyKey: input.idempotencyKey });
    if (existing) {
      if (!matchesWithdrawalRequest(existing, input, normalized)) {
        throw new CryptoGatewayError(
          "idempotency_conflict",
          "Idempotency key does not match withdrawal payload.",
          409
        );
      }
      const balance = await ledger.getBalance(existing.userId, existing.currency);
      const decision =
        existing.status === "failed"
          ? "reject"
          : existing.status === "requested" && existing.reviewRequired
            ? "review"
            : "approve";
      return {
        withdrawal: existing,
        balance,
        decision,
        flags: existing.flags ?? [],
        violations: []
      };
    }

    const now = new Date();
    const withdrawalId = new ObjectId();
    const record: WithId<CryptoWithdrawalDocument> = {
      _id: withdrawalId,
      userId: input.userId,
      currency: normalized,
      amount: input.amount,
      destinationAddress: input.destinationAddress,
      status: "requested",
      idempotencyKey: input.idempotencyKey,
      requestedAt: now,
      createdAt: now,
      updatedAt: now
    };
    if (typeof input.memo === "string" && input.memo.trim().length > 0) {
      record.memo = input.memo;
    }

    const metadata = buildWithdrawalMetadata(record);
    let ledgerResult: { balance: LedgerBalance };
    try {
      ledgerResult = await runMongoTransaction(deps.mongo, async (session) => {
        await withdrawals.insertOne(record, { session });
        const result = await ledger.requestWithdrawalInSession(
          {
            userId: record.userId,
            amount: record.amount,
            currency: record.currency,
            withdrawalId: withdrawalId.toHexString(),
            idempotencyKey: record.idempotencyKey,
            metadata
          },
          session
        );
        return result;
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        const existingRecord = await withdrawals.findOne({ idempotencyKey: record.idempotencyKey });
        if (existingRecord) {
          const balance = await ledger.getBalance(existingRecord.userId, existingRecord.currency);
          const decision =
            existingRecord.status === "failed"
              ? "reject"
              : existingRecord.status === "requested" && existingRecord.reviewRequired
                ? "review"
                : "approve";
          return {
            withdrawal: existingRecord,
            balance,
            decision,
            flags: existingRecord.flags ?? [],
            violations: []
          };
        }
      }
      throw error;
    }

    const decision = await evaluateWithdrawalSafety(record);
    const updated = await applyWithdrawalDecision(record, decision);
    const balance =
      decision.decision === "reject"
        ? await ledger.getBalance(record.userId, record.currency)
        : ledgerResult.balance;

    return {
      withdrawal: updated,
      balance,
      decision: decision.decision,
      flags: decision.flags,
      violations: decision.violations
    };
  }

  async function authorizeWithdrawal(withdrawalId: string, actorId?: string) {
    if (!ObjectId.isValid(withdrawalId)) {
      throw new CryptoGatewayError("invalid_request", "Invalid withdrawal id.", 400);
    }
    const now = new Date();
    const update: Record<string, unknown> = {
      status: "authorized",
      authorizedAt: now,
      reviewRequired: false,
      updatedAt: now,
      nextPollAt: now
    };
    if (actorId) {
      update.authorizedBy = actorId;
    }
    const updated = await withdrawals.findOneAndUpdate(
      { _id: new ObjectId(withdrawalId), status: "requested" },
      { $set: update },
      { returnDocument: "after" }
    );

    if (updated) {
      return updated;
    }

    const existing = await withdrawals.findOne({ _id: new ObjectId(withdrawalId) });
    if (!existing) {
      throw new CryptoGatewayError("withdrawal_not_found", "Withdrawal not found.", 404);
    }

    throw new CryptoGatewayError(
      "withdrawal_conflict",
      `Withdrawal is ${existing.status}.`,
      409
    );
  }

  async function getWithdrawal(withdrawalId: string) {
    if (!ObjectId.isValid(withdrawalId)) {
      throw new CryptoGatewayError("invalid_request", "Invalid withdrawal id.", 400);
    }
    const withdrawal = await withdrawals.findOne({ _id: new ObjectId(withdrawalId) });
    if (!withdrawal) {
      throw new CryptoGatewayError("withdrawal_not_found", "Withdrawal not found.", 404);
    }
    return withdrawal;
  }

  async function processDeposits(
    options: { now?: Date; force?: boolean } = {}
  ): Promise<void> {
    const force = options.force ?? true;

    for (const currency of deps.config.crypto.supportedCurrencies) {
      const scanNow = options.now ?? new Date();
      const state = await gatewayState.findOne({ key: "deposit", currency });
      const nextPollAt = state?.nextPollAt;

      if (!force && nextPollAt && nextPollAt > scanNow) {
        await refreshPendingDeposits(currency, { force, now: scanNow });
        continue;
      }

      const addresses = await walletStrategy.listWatchedAddresses(currency);
      if (addresses.length === 0) {
        await updateGatewayState("deposit", currency, {
          nextPollAt: new Date(scanNow.getTime() + idleDepositScanDelayMs)
        });
        await refreshPendingDeposits(currency, { force, now: scanNow });
        continue;
      }

      const cursor = state?.cursor ?? null;
      const response = await observer.listTransactions({
        currency,
        addresses,
        after: cursor,
        limit: depositBatchSize
      });

      for (const transaction of response.transactions) {
        try {
          await ingestDepositTransaction(transaction);
        } catch (error) {
          deps.logger.error({ err: error, txId: transaction.txId }, "Deposit ingestion failed");
        }
      }

      const scanDelayMs =
        response.transactions.length >= depositBatchSize
          ? minDepositScanDelayMs
          : depositPollIntervalMs;

      await updateGatewayState("deposit", currency, {
        cursor: response.nextCursor ?? undefined,
        nextPollAt: new Date(scanNow.getTime() + scanDelayMs)
      });

      await refreshPendingDeposits(currency, { force, now: scanNow });
    }
  }

  async function processAuthorizedWithdrawals(
    options: { now?: Date; force?: boolean } = {}
  ): Promise<void> {
    const now = options.now ?? new Date();
    const force = options.force ?? true;
    const query: Record<string, unknown> = { status: "authorized" };
    if (!force) {
      query.$or = [{ nextPollAt: { $lte: now } }, { nextPollAt: { $exists: false } }];
    }
    const authorized = await withdrawals
      .find(query)
      .sort(force ? { authorizedAt: 1 } : { nextPollAt: 1, authorizedAt: 1 })
      .limit(withdrawalBatchSize)
      .toArray();

    for (const record of authorized) {
      try {
        await broadcastWithdrawal(record);
      } catch (error) {
        deps.logger.error(
          { err: error, withdrawalId: record._id.toHexString() },
          "Withdrawal broadcast failed"
        );
        const failureAt = new Date();
        await withdrawals.updateOne(
          { _id: record._id, status: "authorized" },
          {
            $set: {
              nextPollAt: new Date(failureAt.getTime() + withdrawalBroadcastIntervalMs),
              updatedAt: failureAt
            }
          }
        );
      }
    }
  }

  async function processBroadcastedWithdrawals(
    options: { now?: Date; force?: boolean } = {}
  ): Promise<void> {
    const now = options.now ?? new Date();
    const force = options.force ?? true;
    const query: Record<string, unknown> = { status: "broadcasted" };
    if (!force) {
      query.$or = [{ nextPollAt: { $lte: now } }, { nextPollAt: { $exists: false } }];
    }
    const broadcasted = await withdrawals
      .find(query)
      .sort(force ? { broadcastedAt: 1 } : { nextPollAt: 1, broadcastedAt: 1 })
      .limit(withdrawalBatchSize)
      .toArray();

    for (const record of broadcasted) {
      try {
        await confirmWithdrawal(record);
      } catch (error) {
        deps.logger.error(
          { err: error, withdrawalId: record._id.toHexString() },
          "Withdrawal confirm failed"
        );
        const failureAt = new Date();
        await withdrawals.updateOne(
          { _id: record._id, status: "broadcasted" },
          {
            $set: {
              nextPollAt: new Date(failureAt.getTime() + withdrawalPollIntervalMs),
              updatedAt: failureAt
            }
          }
        );
      }
    }
  }

  async function ingestDepositTransaction(transaction: ObserverTransaction): Promise<void> {
    if (transaction.amount <= 0 || !Number.isFinite(transaction.amount)) {
      return;
    }

    const attribution = await walletStrategy.resolveDepositAttribution(transaction);
    if (!attribution) {
      return;
    }

    const existing = await deposits.findOne({
      currency: transaction.currency,
      txId: transaction.txId
    });

    if (existing) {
      if (!matchesDeposit(existing, transaction, attribution)) {
        deps.logger.warn(
          { txId: transaction.txId },
          "Deposit transaction payload mismatch."
        );
        return;
      }

      if (existing.status === "credited") {
        return;
      }
    }

    const now = new Date();
    const status = getDepositStatus(
      transaction.confirmations,
      deps.config.crypto.deposit.confirmations
    );
    const nextPollAt = new Date(now.getTime() + depositPollIntervalMs);
    const result = await deposits.findOneAndUpdate(
      { currency: transaction.currency, txId: transaction.txId },
      {
        $setOnInsert: {
          currency: transaction.currency,
          txId: transaction.txId,
          address: transaction.address,
          memo: transaction.memo,
          amount: transaction.amount,
          userId: attribution.userId,
          observedAt: transaction.observedAt,
          createdAt: now
        },
        $set: {
          confirmations: transaction.confirmations,
          status,
          updatedAt: now,
          blockHeight: transaction.blockHeight,
          nextPollAt
        }
      },
      { upsert: true, returnDocument: "after" }
    );

    if (!result) {
      return;
    }

    if (status === "confirmed") {
      await creditDeposit(result);
    }
  }

  async function refreshPendingDeposits(
    currency: string,
    options: { now?: Date; force?: boolean } = {}
  ): Promise<void> {
    const now = options.now ?? new Date();
    const force = options.force ?? true;
    const query: Record<string, unknown> = {
      currency,
      status: { $in: ["observed", "confirming", "confirmed"] }
    };
    if (!force) {
      query.$or = [{ nextPollAt: { $lte: now } }, { nextPollAt: { $exists: false } }];
    }

    const pending = await deposits
      .find(query)
      .sort(force ? { observedAt: 1 } : { nextPollAt: 1, observedAt: 1 })
      .limit(depositBatchSize)
      .toArray();

    for (const record of pending) {
      const attemptAt = new Date();
      const nextPollAt = new Date(attemptAt.getTime() + depositPollIntervalMs);

      try {
        const updated = await observer.getTransaction(currency, record.txId);
        if (!updated) {
          await deposits.updateOne(
            { _id: record._id },
            { $set: { nextPollAt, updatedAt: attemptAt } }
          );
          continue;
        }

        if (record.status === "credited") {
          continue;
        }

        if (!matchesDeposit(record, updated, { userId: record.userId ?? "" })) {
          deps.logger.warn({ txId: record.txId }, "Deposit refresh mismatch.");
          await deposits.updateOne(
            { _id: record._id },
            { $set: { nextPollAt, updatedAt: attemptAt } }
          );
          continue;
        }

        const status = getDepositStatus(
          updated.confirmations,
          deps.config.crypto.deposit.confirmations
        );
        const next = await deposits.findOneAndUpdate(
          { _id: record._id },
          {
            $set: {
              confirmations: updated.confirmations,
              status,
              updatedAt: attemptAt,
              blockHeight: updated.blockHeight,
              nextPollAt
            }
          },
          { returnDocument: "after" }
        );

        if (next && status === "confirmed") {
          await creditDeposit(next);
        }
      } catch (error) {
        deps.logger.error({ err: error, txId: record.txId }, "Deposit refresh failed");
        const failureAt = new Date();
        await deposits.updateOne(
          { _id: record._id },
          {
            $set: {
              nextPollAt: new Date(failureAt.getTime() + depositPollIntervalMs),
              updatedAt: failureAt
            }
          }
        );
      }
    }
  }

  async function creditDeposit(deposit: WithId<CryptoDepositDocument>): Promise<void> {
    const userId = deposit.userId;
    if (!userId) {
      return;
    }
    if (deposit.status === "credited") {
      return;
    }

    await runMongoTransaction(deps.mongo, async (session) => {
      const metadata: Record<string, unknown> = {
        txId: deposit.txId,
        address: deposit.address
      };
      if (deposit.memo) {
        metadata.memo = deposit.memo;
      }
      if (deposit.blockHeight !== undefined) {
        metadata.blockHeight = deposit.blockHeight;
      }
      const entry = await ledger.createEntryInSession(
        {
          userId,
          entryType: "deposit_confirmed",
          amount: deposit.amount,
          currency: deposit.currency,
          idempotencyKey: buildDepositIdempotencyKey(deposit),
          metadata
        },
        session
      );

      await deposits.updateOne(
        { _id: deposit._id },
        {
          $set: {
            status: "credited",
            creditedAt: new Date(),
            updatedAt: new Date(),
            ledgerEntryId: entry.entry._id
          },
          $unset: { nextPollAt: "" }
        },
        { session }
      );
      return entry;
    });
  }

  async function broadcastWithdrawal(record: WithId<CryptoWithdrawalDocument>): Promise<void> {
    if (!record || record.status !== "authorized") {
      return;
    }

    const payload: WithdrawalSigningPayload = {
      withdrawalId: record._id.toHexString(),
      currency: record.currency,
      amount: record.amount,
      fromAddress: getHotWalletAddress(record.currency),
      toAddress: record.destinationAddress,
      requestedAt: record.requestedAt.toISOString(),
      memo: record.memo
    };

    const signed = await signer.signWithdrawal(payload);
    const broadcast = await observer.broadcastTransaction(
      record.currency,
      signed,
      record._id.toHexString()
    );

    const broadcastedAt = new Date();
    await runMongoTransaction(deps.mongo, async (session) => {
      const updated = await withdrawals.findOneAndUpdate(
        { _id: record._id, status: "authorized" },
        {
          $set: {
            status: "broadcasted",
            txId: broadcast.txId,
            broadcastedAt,
            updatedAt: broadcastedAt,
            nextPollAt: new Date(broadcastedAt.getTime() + withdrawalPollIntervalMs)
          }
        },
        { returnDocument: "after", session }
      );

      if (!updated) {
        return null;
      }

      await ledger.broadcastWithdrawalInSession(
        {
          userId: updated.userId,
          amount: updated.amount,
          currency: updated.currency,
          withdrawalId: updated._id.toHexString(),
          idempotencyKey: buildWithdrawalBroadcastIdempotencyKey(updated),
          metadata: buildWithdrawalMetadata(updated, { txId: broadcast.txId })
        },
        session
      );
      return updated;
    });
  }

  async function confirmWithdrawal(record: WithId<CryptoWithdrawalDocument>): Promise<void> {
    if (!record.txId || record.status !== "broadcasted") {
      return;
    }

    const now = new Date();
    const nextPollAt = new Date(now.getTime() + withdrawalPollIntervalMs);
    const transaction = await observer.getTransaction(record.currency, record.txId);
    if (!transaction) {
      await withdrawals.updateOne(
        { _id: record._id, status: "broadcasted" },
        { $set: { nextPollAt, updatedAt: now } }
      );
      return;
    }

    if (transaction.confirmations < deps.config.crypto.withdrawal.confirmations) {
      await withdrawals.updateOne(
        { _id: record._id, status: "broadcasted" },
        { $set: { nextPollAt, updatedAt: now } }
      );
      return;
    }

    await runMongoTransaction(deps.mongo, async (session) => {
      const updated = await withdrawals.findOneAndUpdate(
        { _id: record._id, status: "broadcasted" },
        {
          $set: {
            status: "confirmed",
            confirmedAt: now,
            updatedAt: now
          },
          $unset: { nextPollAt: "" }
        },
        { returnDocument: "after", session }
      );

      if (!updated) {
        return null;
      }

      await ledger.confirmWithdrawalInSession(
        {
          userId: updated.userId,
          amount: updated.amount,
          currency: updated.currency,
          withdrawalId: updated._id.toHexString(),
          idempotencyKey: buildWithdrawalConfirmIdempotencyKey(updated),
          metadata: buildWithdrawalMetadata(updated, { txId: updated.txId })
        },
        session
      );
      return updated;
    });
  }

  async function evaluateWithdrawalSafety(
    record: WithId<CryptoWithdrawalDocument>
  ): Promise<WithdrawalDecision> {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    const recent = await withdrawals
      .find({
        userId: record.userId,
        currency: record.currency,
        status: { $ne: "failed" },
        requestedAt: { $gte: dayAgo }
      })
      .toArray();

    const confirmedHistory = await withdrawals
      .find({
        userId: record.userId,
        currency: record.currency,
        status: "confirmed"
      })
      .sort({ confirmedAt: -1 })
      .limit(20)
      .toArray();

    const allowlisted = await allowlists.findOne({
      userId: record.userId,
      currency: record.currency,
      address: record.destinationAddress
    });

    const violations: string[] = [];
    if (record.amount < deps.config.crypto.withdrawal.minAmount) {
      violations.push("min_amount");
    }
    if (record.amount > deps.config.crypto.withdrawal.maxAmount) {
      violations.push("max_amount");
    }

    const dailyTotal = recent.reduce((sum, item) => sum + item.amount, 0);
    if (dailyTotal > deps.config.crypto.withdrawal.dailyLimit) {
      violations.push("daily_limit");
    }

    const hourlyCount = recent.filter((item) => item.requestedAt >= hourAgo).length;
    if (hourlyCount > deps.config.crypto.withdrawal.maxRequestsPerHour) {
      violations.push("hourly_limit");
    }

    if (recent.length > deps.config.crypto.withdrawal.maxRequestsPerDay) {
      violations.push("daily_count_limit");
    }

    if (deps.config.crypto.withdrawal.cooldownSeconds > 0) {
      const latestConfirmed = confirmedHistory[0]?.confirmedAt;
      if (
        latestConfirmed &&
        now.getTime() - latestConfirmed.getTime() <
          deps.config.crypto.withdrawal.cooldownSeconds * 1000
      ) {
        violations.push("cooldown");
      }
    }

    if (deps.config.crypto.withdrawal.allowlistRequired && !allowlisted) {
      violations.push("allowlist_required");
    }

    const flags: string[] = [];
    if (!allowlisted && !deps.config.crypto.withdrawal.allowlistRequired) {
      const usedBefore = confirmedHistory.some(
        (entry) => entry.destinationAddress === record.destinationAddress
      );
      if (!usedBefore) {
        flags.push("new_address");
      }
    }

    if (confirmedHistory.length === 0) {
      flags.push("first_withdrawal");
    }

    const averageConfirmed =
      confirmedHistory.reduce((sum, item) => sum + item.amount, 0) /
      Math.max(1, confirmedHistory.length);
    if (
      averageConfirmed > 0 &&
      record.amount > averageConfirmed * deps.config.crypto.withdrawal.anomalyMultiplier
    ) {
      flags.push("amount_spike");
    }

    if (record.amount > deps.config.crypto.withdrawal.autoAuthorizeMaxAmount) {
      flags.push("manual_threshold");
    }

    if (violations.length > 0) {
      return { decision: "reject", flags, violations };
    }

    if (flags.length > 0) {
      return { decision: "review", flags, violations };
    }

    return { decision: "approve", flags, violations };
  }

  async function applyWithdrawalDecision(
    record: WithId<CryptoWithdrawalDocument>,
    decision: WithdrawalDecision
  ): Promise<WithId<CryptoWithdrawalDocument>> {
    const now = new Date();

    if (decision.decision === "approve") {
      const updated = await withdrawals.findOneAndUpdate(
        { _id: record._id, status: "requested" },
        {
          $set: {
            status: "authorized",
            authorizedAt: now,
            authorizedBy: "system",
            reviewRequired: false,
            flags: decision.flags,
            updatedAt: now,
            nextPollAt: now
          }
        },
        { returnDocument: "after" }
      );
      return updated ?? record;
    }

    if (decision.decision === "review") {
      const updated = await withdrawals.findOneAndUpdate(
        { _id: record._id, status: "requested" },
        {
          $set: {
            reviewRequired: true,
            flags: decision.flags,
            updatedAt: now
          }
        },
        { returnDocument: "after" }
      );
      return updated ?? record;
    }

    const failureReason = decision.violations.join(",");
    const updated = await runMongoTransaction(deps.mongo, async (session) => {
      const next = await withdrawals.findOneAndUpdate(
        { _id: record._id, status: "requested" },
        {
          $set: {
            status: "failed",
            failedAt: now,
            failureReason,
            reviewRequired: false,
            flags: decision.flags,
            updatedAt: now
          }
        },
        { returnDocument: "after", session }
      );

      if (!next) {
        return record;
      }

      await ledger.failWithdrawalInSession(
        {
          userId: next.userId,
          amount: next.amount,
          currency: next.currency,
          withdrawalId: next._id.toHexString(),
          idempotencyKey: buildWithdrawalFailIdempotencyKey(next),
          metadata: buildWithdrawalMetadata(next)
        },
        session
      );

      return next;
    });

    return updated;
  }

  async function updateGatewayState(
    key: string,
    currency: string,
    updates: { cursor?: string | null; nextPollAt?: Date }
  ): Promise<void> {
    const now = new Date();
    const set: Record<string, unknown> = { updatedAt: now };
    if (updates.cursor !== undefined) {
      set.cursor = updates.cursor;
    }
    if (updates.nextPollAt !== undefined) {
      set.nextPollAt = updates.nextPollAt;
    }
    await gatewayState.updateOne(
      { key, currency },
      {
        $set: set,
        $setOnInsert: {
          key,
          currency
        }
      },
      { upsert: true }
    );
  }

  async function getGatewayCursor(key: string, currency: string): Promise<string | null> {
    const existing = await gatewayState.findOne({ key, currency });
    return existing?.cursor ?? null;
  }

  async function setGatewayCursor(key: string, currency: string, cursor: string): Promise<void> {
    const now = new Date();
    await gatewayState.updateOne(
      { key, currency },
      {
        $set: {
          cursor,
          updatedAt: now
        },
        $setOnInsert: {
          key,
          currency
        }
      },
      { upsert: true }
    );
  }

  function assertSupportedCurrency(currency: string): void {
    if (!deps.config.crypto.supportedCurrencies.includes(currency)) {
      throw new CryptoGatewayError("unsupported_currency", "Unsupported currency.", 400);
    }
  }

  function getHotWalletAddress(currency: string): string {
    const address = deps.config.crypto.withdrawal.hotWalletAddresses[currency];
    if (!address) {
      throw new CryptoGatewayError("invalid_request", "Hot wallet address missing.", 500);
    }
    return address;
  }

  return {
    getDepositDestination,
    addAllowlistEntry,
    requestWithdrawal,
    authorizeWithdrawal,
    getWithdrawal,
    processDeposits,
    processAuthorizedWithdrawals,
    processBroadcastedWithdrawals
  };
}

function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

function getDepositStatus(
  confirmations: number,
  threshold: number
): CryptoDepositDocument["status"] {
  if (confirmations >= threshold) {
    return "confirmed";
  }
  if (confirmations >= 1) {
    return "confirming";
  }
  return "observed";
}

function matchesDeposit(
  existing: CryptoDepositDocument,
  transaction: ObserverTransaction,
  attribution: { userId?: string }
): boolean {
  if (existing.txId !== transaction.txId || existing.currency !== transaction.currency) {
    return false;
  }
  if (existing.address !== transaction.address) {
    return false;
  }
  if (existing.memo !== transaction.memo) {
    return false;
  }
  if (existing.amount !== transaction.amount) {
    return false;
  }
  if (existing.userId && attribution.userId && existing.userId !== attribution.userId) {
    return false;
  }
  return true;
}

function matchesWithdrawalRequest(
  existing: CryptoWithdrawalDocument,
  input: WithdrawalRequestInput,
  currency: string
): boolean {
  if (existing.userId !== input.userId) {
    return false;
  }
  if (existing.currency !== currency) {
    return false;
  }
  if (existing.amount !== input.amount) {
    return false;
  }
  if (existing.destinationAddress !== input.destinationAddress) {
    return false;
  }
  if ((existing.memo ?? null) !== (input.memo ?? null)) {
    return false;
  }
  return true;
}

function buildDepositIdempotencyKey(deposit: CryptoDepositDocument): string {
  return `deposit:${deposit.currency}:${deposit.txId}`;
}

function buildWithdrawalBroadcastIdempotencyKey(
  withdrawal: WithId<CryptoWithdrawalDocument>
): string {
  return `withdrawal:${withdrawal._id.toHexString()}:broadcast`;
}

function buildWithdrawalConfirmIdempotencyKey(
  withdrawal: WithId<CryptoWithdrawalDocument>
): string {
  return `withdrawal:${withdrawal._id.toHexString()}:confirm`;
}

function buildWithdrawalFailIdempotencyKey(
  withdrawal: WithId<CryptoWithdrawalDocument>
): string {
  return `withdrawal:${withdrawal._id.toHexString()}:fail`;
}

function buildWithdrawalMetadata(
  withdrawal: WithId<CryptoWithdrawalDocument>,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    withdrawalId: withdrawal._id.toHexString(),
    destinationAddress: withdrawal.destinationAddress
  };
  if (withdrawal.memo) {
    metadata.memo = withdrawal.memo;
  }
  for (const [key, value] of Object.entries(extra)) {
    metadata[key] = value;
  }
  return metadata;
}

function isDuplicateKeyError(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}
