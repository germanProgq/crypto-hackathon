// Ledger operations, balance derivation, and reconciliation helpers.
import { isDeepStrictEqual } from "node:util";
import { type ClientSession, type Collection, type Document, type WithId } from "mongodb";
import type { Logger } from "pino";
import type { MongoDependencies } from "../../shared/storage/mongo.js";
import type { RedisClient } from "../../shared/storage/redis.js";
import { runMongoTransaction } from "../../shared/storage/mongoTransaction.js";
import { computeExpiresAt, resolveRetentionMs } from "../../shared/storage/retention.js";
import {
  mongoCollections,
  type LedgerAccountDocument,
  type LedgerEntryDocument,
  type LedgerEntryType
} from "../../shared/storage/mongoSchemas.js";
import { applyBalanceDelta } from "../../shared/ledgerBalanceCache.js";

export type LedgerTotals = Record<LedgerEntryType, number>;
type LedgerAccountTotals = Partial<Record<LedgerEntryType, number>>;

export interface LedgerBalance {
  userId: string;
  currency: string;
  available: number;
  held: number;
  spent: number;
  current: number;
  asOf: Date;
}

export interface LedgerReconciliation {
  userId: string;
  currency: string;
  totals: LedgerTotals;
  balance: LedgerBalance;
  expectedCurrent: number;
  balanceMatches: boolean;
  issues: string[];
}

export interface LedgerMutationResult {
  entry: WithId<LedgerEntryDocument>;
  balance: LedgerBalance;
}

export interface LedgerHistoryOptions {
  limit?: number;
  before?: Date;
}

export interface LedgerEntryInput {
  userId: string;
  entryType: LedgerEntryType;
  amount: number;
  currency: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  audit?: LedgerEntryDocument["audit"];
}

export interface HoldOperationInput {
  userId: string;
  amount: number;
  currency: string;
  holdId: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  audit?: LedgerEntryDocument["audit"];
}

export interface WithdrawalOperationInput {
  userId: string;
  amount: number;
  currency: string;
  withdrawalId: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  audit?: LedgerEntryDocument["audit"];
}

export type LedgerErrorCode =
  | "invalid_request"
  | "invalid_amount"
  | "insufficient_funds"
  | "idempotency_conflict"
  | "hold_exists"
  | "hold_not_found"
  | "hold_resolved"
  | "withdrawal_exists"
  | "withdrawal_not_found"
  | "withdrawal_resolved";

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  readonly status: number;

  constructor(code: LedgerErrorCode, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const ledgerEntryTypes: LedgerEntryType[] = [
  "deposit_confirmed",
  "hold_created",
  "hold_released",
  "hold_captured",
  "withdrawal_requested",
  "withdrawal_broadcasted",
  "withdrawal_confirmed",
  "withdrawal_failed"
];

const mutationEntryTypes = new Set<LedgerEntryType>([
  "deposit_confirmed",
  "withdrawal_requested",
  "withdrawal_broadcasted",
  "withdrawal_confirmed",
  "withdrawal_failed"
]);

export function createLedgerRepository(
  mongo: MongoDependencies,
  options: { retentionDays?: number; redis?: RedisClient; logger?: Logger } = {}
) {
  const ledgerEntries = mongo.db.collection<LedgerEntryDocument>(mongoCollections.ledgerEntries);
  const ledgerAccounts = mongo.db.collection<LedgerAccountDocument>(mongoCollections.ledgerAccounts);
  const retentionMs = resolveRetentionMs(options.retentionDays ?? 0);
  const cacheRedis = options.redis;
  const cacheLogger = options.logger;

  async function getBalance(userId: string, currency: string): Promise<LedgerBalance> {
    const totals = await getAccountTotals(ledgerEntries, ledgerAccounts, userId, currency);
    return buildBalance(userId, currency, totals);
  }

  async function getBalanceInSession(
    userId: string,
    currency: string,
    session: ClientSession
  ): Promise<LedgerBalance> {
    return getBalanceWithSession(ledgerEntries, ledgerAccounts, userId, currency, session);
  }

  async function getHistory(
    userId: string,
    currency: string,
    options: LedgerHistoryOptions = {}
  ): Promise<Array<WithId<LedgerEntryDocument>>> {
    const limit = normalizeLimit(options.limit);
    const query: Document = { userId, currency };

    if (options.before) {
      query.createdAt = { $lt: options.before };
    }

    return ledgerEntries
      .find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .toArray();
  }

  async function reconcile(userId: string, currency: string): Promise<LedgerReconciliation> {
    const totals = await getLedgerTotals(ledgerEntries, userId, currency);
    const balance = buildBalance(userId, currency, totals);
    const expectedCurrent =
      getTotal(totals, "deposit_confirmed") -
      getTotal(totals, "withdrawal_confirmed") -
      getTotal(totals, "hold_captured");
    const balanceMatches = Math.abs(expectedCurrent - balance.current) < 1e-9;
    const issues: string[] = [];

    if (balance.available < 0) {
      issues.push("available_negative");
    }

    if (balance.held < 0) {
      issues.push("held_negative");
    }

    if (!balanceMatches) {
      issues.push("current_mismatch");
    }

    return {
      userId,
      currency,
      totals,
      balance,
      expectedCurrent,
      balanceMatches,
      issues
    };
  }

  async function createEntry(input: LedgerEntryInput): Promise<LedgerMutationResult> {
    const result = await runMongoTransaction(mongo, (session) =>
      createEntryWithSession(input, session)
    );
    await updateBalanceCache(
      {
        userId: input.userId,
        currency: input.currency,
        amount: input.amount,
        entryType: input.entryType,
        idempotencyKey: input.idempotencyKey
      },
      result.entry.createdAt ?? new Date()
    );
    return result;
  }

  async function createEntryInSession(
    input: LedgerEntryInput,
    session: ClientSession
  ): Promise<LedgerMutationResult> {
    return createEntryWithSession(input, session);
  }

  async function createEntryWithSession(
    input: LedgerEntryInput,
    session: ClientSession
  ): Promise<LedgerMutationResult> {
    if (!mutationEntryTypes.has(input.entryType)) {
      throw new LedgerError(
        "invalid_request",
        `Entry type not allowed for direct creation: ${input.entryType}`,
        400
      );
    }

    if (input.entryType === "withdrawal_requested") {
      return requestWithdrawalWithSession(toWithdrawalInput(input), session);
    }

    if (input.entryType === "withdrawal_broadcasted") {
      const entry = await broadcastWithdrawalWithSession(toWithdrawalInput(input), session);
      const balance = await getBalanceWithSession(
        ledgerEntries,
        ledgerAccounts,
        input.userId,
        input.currency,
        session
      );
      return { entry, balance };
    }

    if (input.entryType === "withdrawal_confirmed") {
      return resolveWithdrawalWithSession(toWithdrawalInput(input), "withdrawal_confirmed", session);
    }

    if (input.entryType === "withdrawal_failed") {
      return resolveWithdrawalWithSession(toWithdrawalInput(input), "withdrawal_failed", session);
    }

    validateEntryInput(input);

    await touchAccount(ledgerAccounts, input.userId, input.currency, session);
    const entry = await insertLedgerEntry(
      ledgerEntries,
      ledgerAccounts,
      input,
      session,
      retentionMs
    );
    const balance = await getBalanceWithSession(
      ledgerEntries,
      ledgerAccounts,
      input.userId,
      input.currency,
      session
    );
    assertNonNegative(balance);
    return { entry, balance };
  }

  async function createHold(input: HoldOperationInput): Promise<LedgerMutationResult> {
    const result = await runMongoTransaction(mongo, (session) =>
      createHoldWithSession(input, session)
    );
    await updateBalanceCache(
      {
        userId: input.userId,
        currency: input.currency,
        amount: input.amount,
        entryType: "hold_created",
        idempotencyKey: input.idempotencyKey
      },
      result.entry.createdAt ?? new Date()
    );
    return result;
  }

  async function createHoldInSession(
    input: HoldOperationInput,
    session: ClientSession
  ): Promise<LedgerMutationResult> {
    return createHoldWithSession(input, session);
  }

  async function createHoldWithSession(
    input: HoldOperationInput,
    session: ClientSession
  ): Promise<LedgerMutationResult> {
    validateHoldInput(input);
    await touchAccount(ledgerAccounts, input.userId, input.currency, session);
    const holdEntry = await findHoldEntry(
      ledgerEntries,
      input.userId,
      input.currency,
      input.holdId,
      session
    );

    if (holdEntry) {
      if (holdEntry.idempotencyKey === input.idempotencyKey) {
        const balance = await getBalanceWithSession(
          ledgerEntries,
          ledgerAccounts,
          input.userId,
          input.currency,
          session
        );
        return { entry: holdEntry, balance };
      }

      throw new LedgerError("hold_exists", "Hold already exists.", 409);
    }

    const balance = await getBalanceWithSession(
      ledgerEntries,
      ledgerAccounts,
      input.userId,
      input.currency,
      session
    );

    if (balance.available < input.amount) {
      throw new LedgerError("insufficient_funds", "Insufficient available balance.", 409);
    }

    const entry = await insertLedgerEntry(
      ledgerEntries,
      ledgerAccounts,
      {
        userId: input.userId,
        entryType: "hold_created",
        amount: input.amount,
        currency: input.currency,
        idempotencyKey: input.idempotencyKey,
        metadata: mergeReferenceMetadata("holdId", input.holdId, input.metadata),
        audit: input.audit
      },
      session,
      retentionMs
    );

    const updated = await getBalanceWithSession(
      ledgerEntries,
      ledgerAccounts,
      input.userId,
      input.currency,
      session
    );
    assertNonNegative(updated);
    return { entry, balance: updated };
  }

  async function releaseHold(input: HoldOperationInput): Promise<LedgerMutationResult> {
    const result = await resolveHold(input, "hold_released");
    await updateBalanceCache(
      {
        userId: input.userId,
        currency: input.currency,
        amount: input.amount,
        entryType: "hold_released",
        idempotencyKey: input.idempotencyKey
      },
      result.entry.createdAt ?? new Date()
    );
    return result;
  }

  async function captureHold(input: HoldOperationInput): Promise<LedgerMutationResult> {
    const result = await resolveHold(input, "hold_captured");
    await updateBalanceCache(
      {
        userId: input.userId,
        currency: input.currency,
        amount: input.amount,
        entryType: "hold_captured",
        idempotencyKey: input.idempotencyKey
      },
      result.entry.createdAt ?? new Date()
    );
    return result;
  }

  async function requestWithdrawal(input: WithdrawalOperationInput): Promise<LedgerMutationResult> {
    validateWithdrawalInput(input);
    const result = await runMongoTransaction(mongo, (session) =>
      requestWithdrawalWithSession(input, session)
    );
    await updateBalanceCache(
      {
        userId: input.userId,
        currency: input.currency,
        amount: input.amount,
        entryType: "withdrawal_requested",
        idempotencyKey: input.idempotencyKey
      },
      result.entry.createdAt ?? new Date()
    );
    return result;
  }

  async function requestWithdrawalInSession(
    input: WithdrawalOperationInput,
    session: ClientSession
  ): Promise<LedgerMutationResult> {
    return requestWithdrawalWithSession(input, session);
  }

  async function requestWithdrawalWithSession(
    input: WithdrawalOperationInput,
    session: ClientSession
  ): Promise<LedgerMutationResult> {
    await touchAccount(ledgerAccounts, input.userId, input.currency, session);
    const existing = await findWithdrawalEntry(
      ledgerEntries,
      input.userId,
      input.currency,
      input.withdrawalId,
      "withdrawal_requested",
      session
    );

    if (existing) {
      if (existing.idempotencyKey === input.idempotencyKey) {
        const balance = await getBalanceWithSession(
          ledgerEntries,
          ledgerAccounts,
          input.userId,
          input.currency,
          session
        );
        return { entry: existing, balance };
      }

      throw new LedgerError("withdrawal_exists", "Withdrawal already requested.", 409);
    }

    const balance = await getBalanceWithSession(
      ledgerEntries,
      ledgerAccounts,
      input.userId,
      input.currency,
      session
    );

    if (balance.available < input.amount) {
      throw new LedgerError("insufficient_funds", "Insufficient available balance.", 409);
    }

    const entry = await insertLedgerEntry(
      ledgerEntries,
      ledgerAccounts,
      {
        userId: input.userId,
        entryType: "withdrawal_requested",
        amount: input.amount,
        currency: input.currency,
        idempotencyKey: input.idempotencyKey,
        metadata: mergeReferenceMetadata("withdrawalId", input.withdrawalId, input.metadata),
        audit: input.audit
      },
      session,
      retentionMs
    );

    const updated = await getBalanceWithSession(
      ledgerEntries,
      ledgerAccounts,
      input.userId,
      input.currency,
      session
    );
    assertNonNegative(updated);
    return { entry, balance: updated };
  }

  async function broadcastWithdrawal(
    input: WithdrawalOperationInput
  ): Promise<WithId<LedgerEntryDocument>> {
    validateWithdrawalInput(input);

    return runMongoTransaction(mongo, (session) => broadcastWithdrawalWithSession(input, session));
  }

  async function broadcastWithdrawalInSession(
    input: WithdrawalOperationInput,
    session: ClientSession
  ): Promise<WithId<LedgerEntryDocument>> {
    return broadcastWithdrawalWithSession(input, session);
  }

  async function broadcastWithdrawalWithSession(
    input: WithdrawalOperationInput,
    session: ClientSession
  ): Promise<WithId<LedgerEntryDocument>> {
    await touchAccount(ledgerAccounts, input.userId, input.currency, session);
    const existing = await findWithdrawalEntry(
      ledgerEntries,
      input.userId,
      input.currency,
      input.withdrawalId,
      "withdrawal_broadcasted",
      session
    );

    if (existing) {
      if (existing.idempotencyKey === input.idempotencyKey) {
        return existing;
      }

      throw new LedgerError("withdrawal_exists", "Withdrawal already broadcasted.", 409);
    }

    const requested = await findWithdrawalEntry(
      ledgerEntries,
      input.userId,
      input.currency,
      input.withdrawalId,
      "withdrawal_requested",
      session
    );

    if (!requested) {
      throw new LedgerError("withdrawal_not_found", "Withdrawal not found.", 404);
    }

    return insertLedgerEntry(
      ledgerEntries,
      ledgerAccounts,
      {
        userId: input.userId,
        entryType: "withdrawal_broadcasted",
        amount: input.amount,
        currency: input.currency,
        idempotencyKey: input.idempotencyKey,
        metadata: mergeReferenceMetadata("withdrawalId", input.withdrawalId, input.metadata),
        audit: input.audit
      },
      session,
      retentionMs
    );
  }

  async function confirmWithdrawal(input: WithdrawalOperationInput): Promise<LedgerMutationResult> {
    const result = await runMongoTransaction(mongo, (session) =>
      resolveWithdrawalWithSession(input, "withdrawal_confirmed", session)
    );
    await updateBalanceCache(
      {
        userId: input.userId,
        currency: input.currency,
        amount: input.amount,
        entryType: "withdrawal_confirmed",
        idempotencyKey: input.idempotencyKey
      },
      result.entry.createdAt ?? new Date()
    );
    return result;
  }

  async function confirmWithdrawalInSession(
    input: WithdrawalOperationInput,
    session: ClientSession
  ): Promise<LedgerMutationResult> {
    return resolveWithdrawalWithSession(input, "withdrawal_confirmed", session);
  }

  async function failWithdrawal(input: WithdrawalOperationInput): Promise<LedgerMutationResult> {
    const result = await runMongoTransaction(mongo, (session) =>
      resolveWithdrawalWithSession(input, "withdrawal_failed", session)
    );
    await updateBalanceCache(
      {
        userId: input.userId,
        currency: input.currency,
        amount: input.amount,
        entryType: "withdrawal_failed",
        idempotencyKey: input.idempotencyKey
      },
      result.entry.createdAt ?? new Date()
    );
    return result;
  }

  async function failWithdrawalInSession(
    input: WithdrawalOperationInput,
    session: ClientSession
  ): Promise<LedgerMutationResult> {
    return resolveWithdrawalWithSession(input, "withdrawal_failed", session);
  }

  async function updateBalanceCache(
    input: {
      userId: string;
      currency: string;
      amount: number;
      entryType: LedgerEntryType;
      idempotencyKey: string;
    },
    updatedAt: Date
  ): Promise<void> {
    if (!cacheRedis) {
      return;
    }
    try {
      await applyBalanceDelta(cacheRedis, { ...input, updatedAt });
    } catch (error) {
      if (cacheLogger) {
        cacheLogger.warn({ err: error }, "Ledger balance cache update failed");
      }
    }
  }

  async function resolveHold(
    input: HoldOperationInput,
    entryType: "hold_released" | "hold_captured"
  ): Promise<LedgerMutationResult> {
    validateHoldInput(input);

    return runMongoTransaction(mongo, async (session) => {
      await touchAccount(ledgerAccounts, input.userId, input.currency, session);
      const holdEntry = await findHoldEntry(
        ledgerEntries,
        input.userId,
        input.currency,
        input.holdId,
        session
      );

      if (!holdEntry) {
        throw new LedgerError("hold_not_found", "Hold not found.", 404);
      }

      if (input.amount > holdEntry.amount) {
        throw new LedgerError("invalid_request", "Hold amount exceeds hold total.", 409);
      }

      const metadata = mergeReferenceMetadata("holdId", input.holdId, input.metadata);
      const expectedEntry: LedgerEntryDocument = {
        userId: input.userId,
        entryType,
        amount: input.amount,
        currency: input.currency,
        createdAt: new Date(),
        idempotencyKey: input.idempotencyKey,
        metadata,
        audit: input.audit
      };
      const existingByIdempotency = await ledgerEntries.findOne(
        { idempotencyKey: input.idempotencyKey },
        { session }
      );
      if (existingByIdempotency) {
        if (matchesIdempotentEntry(existingByIdempotency, expectedEntry)) {
          const balance = await getBalanceWithSession(
            ledgerEntries,
            ledgerAccounts,
            input.userId,
            input.currency,
            session
          );
          return { entry: existingByIdempotency, balance };
        }
        throw new LedgerError("idempotency_conflict", "Idempotency mismatch.", 409);
      }

      const resolved = await findHoldResolutions(
        ledgerEntries,
        input.userId,
        input.currency,
        input.holdId,
        session
      );

      const resolvedTotal = resolved.reduce((sum, entry) => sum + entry.amount, 0);
      if (resolvedTotal >= holdEntry.amount - 1e-9) {
        throw new LedgerError("hold_resolved", "Hold already resolved.", 409);
      }
      if (resolvedTotal + input.amount > holdEntry.amount + 1e-9) {
        throw new LedgerError("invalid_request", "Hold amount exceeds remaining.", 409);
      }

      const balance = await getBalanceWithSession(
        ledgerEntries,
        ledgerAccounts,
        input.userId,
        input.currency,
        session
      );

      if (balance.held < input.amount) {
        throw new LedgerError("insufficient_funds", "Insufficient held balance.", 409);
      }

      const entry = await insertLedgerEntry(
        ledgerEntries,
        ledgerAccounts,
        {
          userId: input.userId,
          entryType,
          amount: input.amount,
          currency: input.currency,
          idempotencyKey: input.idempotencyKey,
          metadata,
          audit: input.audit
        },
        session,
        retentionMs
      );

      const updated = await getBalanceWithSession(
        ledgerEntries,
        ledgerAccounts,
        input.userId,
        input.currency,
        session
      );
      assertNonNegative(updated);
      return { entry, balance: updated };
    });
  }

  async function resolveWithdrawalWithSession(
    input: WithdrawalOperationInput,
    entryType: "withdrawal_confirmed" | "withdrawal_failed",
    session: ClientSession
  ): Promise<LedgerMutationResult> {
    validateWithdrawalInput(input);

    await touchAccount(ledgerAccounts, input.userId, input.currency, session);
    const requested = await findWithdrawalEntry(
      ledgerEntries,
      input.userId,
      input.currency,
      input.withdrawalId,
      "withdrawal_requested",
      session
    );

    if (!requested) {
      throw new LedgerError("withdrawal_not_found", "Withdrawal not found.", 404);
    }

    if (requested.amount !== input.amount) {
      throw new LedgerError("invalid_request", "Withdrawal amount mismatch.", 409);
    }

    const resolved = await findWithdrawalResolution(
      ledgerEntries,
      input.userId,
      input.currency,
      input.withdrawalId,
      session
    );

    if (resolved) {
      if (resolved.entryType === entryType && resolved.idempotencyKey === input.idempotencyKey) {
        const balance = await getBalanceWithSession(
          ledgerEntries,
          ledgerAccounts,
          input.userId,
          input.currency,
          session
        );
        return { entry: resolved, balance };
      }

      throw new LedgerError("withdrawal_resolved", "Withdrawal already resolved.", 409);
    }

    const balance = await getBalanceWithSession(
      ledgerEntries,
      ledgerAccounts,
      input.userId,
      input.currency,
      session
    );

    if (balance.held < input.amount) {
      throw new LedgerError("insufficient_funds", "Insufficient held balance.", 409);
    }

    const entry = await insertLedgerEntry(
      ledgerEntries,
      ledgerAccounts,
      {
        userId: input.userId,
        entryType,
        amount: input.amount,
        currency: input.currency,
        idempotencyKey: input.idempotencyKey,
        metadata: mergeReferenceMetadata("withdrawalId", input.withdrawalId, input.metadata),
        audit: input.audit
      },
      session,
      retentionMs
    );

    const updated = await getBalanceWithSession(
      ledgerEntries,
      ledgerAccounts,
      input.userId,
      input.currency,
      session
    );
    assertNonNegative(updated);
    return { entry, balance: updated };
  }

  return {
    getBalance,
    getBalanceInSession,
    getHistory,
    reconcile,
    createEntry,
    createEntryInSession,
    createHold,
    createHoldInSession,
    releaseHold,
    captureHold,
    requestWithdrawal,
    requestWithdrawalInSession,
    broadcastWithdrawal,
    broadcastWithdrawalInSession,
    confirmWithdrawal,
    confirmWithdrawalInSession,
    failWithdrawal,
    failWithdrawalInSession
  };
}

async function getLedgerTotals(
  ledgerEntries: Collection<LedgerEntryDocument>,
  userId: string,
  currency: string,
  session?: ClientSession
): Promise<LedgerTotals> {
  const totals = createEmptyTotals();
  const results = await ledgerEntries
    .aggregate(
      [
        { $match: { userId, currency } },
        { $group: { _id: "$entryType", total: { $sum: "$amount" } } }
      ],
      { session }
    )
    .toArray();

  for (const result of results) {
    const entryType = result._id as LedgerEntryType;
    totals[entryType] = Number(result.total ?? 0);
  }

  return totals;
}

async function getAccountTotals(
  ledgerEntries: Collection<LedgerEntryDocument>,
  ledgerAccounts: Collection<LedgerAccountDocument>,
  userId: string,
  currency: string,
  session?: ClientSession
): Promise<LedgerTotals> {
  const account = await ledgerAccounts.findOne({ userId, currency }, { session });
  if (account?.totals) {
    return normalizeTotals(account.totals);
  }

  const totals = await getLedgerTotals(ledgerEntries, userId, currency, session);
  if (account && !account.totals) {
    const now = new Date();
    await ledgerAccounts.updateOne(
      { userId, currency, totals: { $exists: false } },
      { $set: { totals, updatedAt: now } },
      { session }
    );
  }
  return totals;
}

async function getBalanceWithSession(
  ledgerEntries: Collection<LedgerEntryDocument>,
  ledgerAccounts: Collection<LedgerAccountDocument>,
  userId: string,
  currency: string,
  session: ClientSession
): Promise<LedgerBalance> {
  const totals = await getAccountTotals(
    ledgerEntries,
    ledgerAccounts,
    userId,
    currency,
    session
  );
  return buildBalance(userId, currency, totals);
}

function buildBalance(userId: string, currency: string, totals: LedgerTotals): LedgerBalance {
  const depositConfirmed = getTotal(totals, "deposit_confirmed");
  const holdReleased = getTotal(totals, "hold_released");
  const withdrawalFailed = getTotal(totals, "withdrawal_failed");
  const holdCreated = getTotal(totals, "hold_created");
  const withdrawalRequested = getTotal(totals, "withdrawal_requested");
  const holdCaptured = getTotal(totals, "hold_captured");
  const withdrawalConfirmed = getTotal(totals, "withdrawal_confirmed");

  const available =
    depositConfirmed + holdReleased + withdrawalFailed - holdCreated - withdrawalRequested;
  const held =
    holdCreated +
    withdrawalRequested -
    holdReleased -
    holdCaptured -
    withdrawalConfirmed -
    withdrawalFailed;
  const spent = holdCaptured + withdrawalConfirmed;

  return {
    userId,
    currency,
    available,
    held,
    spent,
    current: available + held,
    asOf: new Date()
  };
}

function createEmptyTotals(): LedgerTotals {
  return ledgerEntryTypes.reduce((acc, entryType) => {
    acc[entryType] = 0;
    return acc;
  }, {} as LedgerTotals);
}

function normalizeTotals(totals: LedgerAccountTotals): LedgerTotals {
  const normalized = createEmptyTotals();
  for (const entryType of ledgerEntryTypes) {
    const value = totals[entryType];
    normalized[entryType] =
      typeof value === "number" && Number.isFinite(value) ? value : 0;
  }
  return normalized;
}

function getTotal(totals: LedgerTotals, entryType: LedgerEntryType): number {
  return totals[entryType] ?? 0;
}

function assertNonNegative(balance: LedgerBalance): void {
  if (balance.available < -1e-9 || balance.held < -1e-9 || balance.spent < -1e-9) {
    throw new LedgerError("invalid_request", "Ledger balance invariant violation.", 500);
  }
}

function validateEntryInput(input: LedgerEntryInput): void {
  ensureNonEmpty(input.userId, "userId");
  ensureNonEmpty(input.currency, "currency");
  ensureNonEmpty(input.idempotencyKey, "idempotencyKey");
  ensurePositiveAmount(input.amount);
}

function validateHoldInput(input: HoldOperationInput): void {
  validateEntryInput({
    userId: input.userId,
    entryType: "hold_created",
    amount: input.amount,
    currency: input.currency,
    idempotencyKey: input.idempotencyKey,
    metadata: input.metadata,
    audit: input.audit
  });
  ensureNonEmpty(input.holdId, "holdId");
}

function validateWithdrawalInput(input: WithdrawalOperationInput): void {
  validateEntryInput({
    userId: input.userId,
    entryType: "withdrawal_requested",
    amount: input.amount,
    currency: input.currency,
    idempotencyKey: input.idempotencyKey,
    metadata: input.metadata,
    audit: input.audit
  });
  ensureNonEmpty(input.withdrawalId, "withdrawalId");
}

function ensureNonEmpty(value: string, field: string): void {
  if (!value || value.trim().length === 0) {
    throw new LedgerError("invalid_request", `${field} is required.`, 400);
  }
}

function ensurePositiveAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new LedgerError("invalid_amount", "Amount must be a positive number.", 400);
  }
}

function normalizeLimit(limit?: number): number {
  if (!limit) {
    return 50;
  }

  if (!Number.isFinite(limit)) {
    return 50;
  }

  return Math.max(1, Math.min(200, Math.floor(limit)));
}

async function touchAccount(
  ledgerAccounts: Collection<LedgerAccountDocument>,
  userId: string,
  currency: string,
  session: ClientSession
): Promise<void> {
  const now = new Date();
  await ledgerAccounts.updateOne(
    { userId, currency },
    {
      $setOnInsert: {
        userId,
        currency,
        createdAt: now
      },
      $set: {
        updatedAt: now
      },
      $inc: {
        sequence: 1
      }
    },
    { upsert: true, session }
  );
}

async function applyLedgerAccountDelta(
  ledgerAccounts: Collection<LedgerAccountDocument>,
  input: LedgerEntryInput,
  createdAt: Date,
  session: ClientSession
): Promise<void> {
  const totalsKey = `totals.${input.entryType}`;
  await ledgerAccounts.updateOne(
    { userId: input.userId, currency: input.currency },
    {
      $inc: { [totalsKey]: input.amount },
      $set: { updatedAt: createdAt }
    },
    { session }
  );
}

async function insertLedgerEntry(
  ledgerEntries: Collection<LedgerEntryDocument>,
  ledgerAccounts: Collection<LedgerAccountDocument>,
  input: LedgerEntryInput,
  session: ClientSession,
  retentionMs: number
): Promise<WithId<LedgerEntryDocument>> {
  validateEntryInput(input);
  const createdAt = new Date();
  const expiresAt = computeExpiresAt(createdAt, retentionMs);
  const document: LedgerEntryDocument = {
    userId: input.userId,
    entryType: input.entryType,
    amount: input.amount,
    currency: input.currency,
    createdAt,
    idempotencyKey: input.idempotencyKey
  };

  if (expiresAt) {
    document.expiresAt = expiresAt;
  }

  if (input.metadata !== undefined) {
    document.metadata = input.metadata;
  }

  if (input.audit !== undefined) {
    document.audit = input.audit;
  }

  const result = await ledgerEntries.findOneAndUpdate(
    { idempotencyKey: input.idempotencyKey },
    { $setOnInsert: document },
    { session, upsert: true, returnDocument: "after", includeResultMetadata: true }
  );

  const existing =
    result.value ??
    (await ledgerEntries.findOne({ idempotencyKey: input.idempotencyKey }, { session }));
  if (!existing) {
    throw new LedgerError("idempotency_conflict", "Idempotency conflict.", 409);
  }

  if (!matchesIdempotentEntry(existing, document)) {
    throw new LedgerError("idempotency_conflict", "Idempotency mismatch.", 409);
  }

  const inserted =
    result.lastErrorObject?.updatedExisting === false ||
    Boolean(result.lastErrorObject?.upserted);
  if (inserted) {
    await applyLedgerAccountDelta(ledgerAccounts, input, createdAt, session);
  }

  return existing;
}

function matchesIdempotentEntry(
  existing: LedgerEntryDocument,
  input: LedgerEntryDocument
): boolean {
  if (
    existing.userId !== input.userId ||
    existing.entryType !== input.entryType ||
    existing.amount !== input.amount ||
    existing.currency !== input.currency
  ) {
    return false;
  }

  if (!isDeepStrictEqual(existing.metadata, input.metadata)) {
    return false;
  }

  if (!isDeepStrictEqual(existing.audit, input.audit)) {
    return false;
  }

  return true;
}

function mergeReferenceMetadata(
  referenceKey: "holdId" | "withdrawalId",
  referenceValue: string,
  metadata?: Record<string, unknown>
): Record<string, unknown> {
  const normalized = metadata ? { ...metadata } : {};

  if (referenceKey in normalized && normalized[referenceKey] !== referenceValue) {
    throw new LedgerError("invalid_request", `${referenceKey} mismatch.`, 409);
  }

  normalized[referenceKey] = referenceValue;
  return normalized;
}

function toWithdrawalInput(input: LedgerEntryInput): WithdrawalOperationInput {
  const metadata = input.metadata ?? {};
  const withdrawalId = metadata.withdrawalId;

  if (typeof withdrawalId !== "string" || withdrawalId.trim().length === 0) {
    throw new LedgerError("invalid_request", "withdrawalId is required.", 400);
  }

  return {
    userId: input.userId,
    amount: input.amount,
    currency: input.currency,
    withdrawalId,
    idempotencyKey: input.idempotencyKey,
    metadata: input.metadata,
    audit: input.audit
  };
}

async function findHoldEntry(
  ledgerEntries: Collection<LedgerEntryDocument>,
  userId: string,
  currency: string,
  holdId: string,
  session: ClientSession
): Promise<WithId<LedgerEntryDocument> | null> {
  return ledgerEntries.findOne(
    { userId, currency, entryType: "hold_created", "metadata.holdId": holdId },
    { session }
  );
}

async function findHoldResolutions(
  ledgerEntries: Collection<LedgerEntryDocument>,
  userId: string,
  currency: string,
  holdId: string,
  session: ClientSession
): Promise<Array<WithId<LedgerEntryDocument>>> {
  return ledgerEntries
    .find(
      {
        userId,
        currency,
        entryType: { $in: ["hold_released", "hold_captured"] },
        "metadata.holdId": holdId
      },
      { session }
    )
    .toArray();
}

async function findWithdrawalEntry(
  ledgerEntries: Collection<LedgerEntryDocument>,
  userId: string,
  currency: string,
  withdrawalId: string,
  entryType: LedgerEntryType,
  session: ClientSession
): Promise<WithId<LedgerEntryDocument> | null> {
  return ledgerEntries.findOne(
    {
      userId,
      currency,
      entryType,
      "metadata.withdrawalId": withdrawalId
    },
    { session }
  );
}

async function findWithdrawalResolution(
  ledgerEntries: Collection<LedgerEntryDocument>,
  userId: string,
  currency: string,
  withdrawalId: string,
  session: ClientSession
): Promise<WithId<LedgerEntryDocument> | null> {
  return ledgerEntries.findOne(
    {
      userId,
      currency,
      entryType: { $in: ["withdrawal_confirmed", "withdrawal_failed"] },
      "metadata.withdrawalId": withdrawalId
    },
    { session }
  );
}
