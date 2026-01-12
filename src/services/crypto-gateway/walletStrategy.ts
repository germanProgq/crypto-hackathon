// Deposit wallet strategy and address attribution helpers.
import { MongoServerError, type ClientSession } from "mongodb";
import type { AppConfig } from "../../shared/config.js";
import type { MongoDependencies } from "../../shared/storage/mongo.js";
import { runMongoTransaction } from "../../shared/storage/mongoTransaction.js";
import {
  mongoCollections,
  type CryptoAddressPoolDocument,
  type CryptoCounterDocument,
  type CryptoWalletAddressDocument,
  type WalletStrategy as WalletStrategyMode
} from "../../shared/storage/mongoSchemas.js";
import type { ObserverTransaction } from "./types.js";

export interface DepositDestination {
  userId: string;
  currency: string;
  address: string;
  memo?: string;
  strategy: AppConfig["crypto"]["walletStrategy"];
}

export interface WalletStrategy {
  ensureAddressPool(): Promise<void>;
  getDepositDestination(userId: string, currency: string): Promise<DepositDestination>;
  resolveDepositAttribution(
    transaction: ObserverTransaction
  ): Promise<DepositDestination | null>;
  listWatchedAddresses(currency: string): Promise<string[]>;
}

export interface DepositAddressRequest {
  userId: string;
  currency: string;
}

export interface DepositAddressResult {
  address: string;
  memo?: string;
  strategy: WalletStrategyMode;
}

export interface WalletStrategyProvider {
  getStrategy(): WalletStrategyMode;
  generateDepositAddress(request: DepositAddressRequest): Promise<DepositAddressResult>;
  verifyAddress(address: string, currency: string): boolean;
}

export function createWalletStrategy(
  mongo: MongoDependencies,
  config: AppConfig["crypto"]
): WalletStrategy {
  const addressPool = mongo.db.collection<CryptoAddressPoolDocument>(
    mongoCollections.cryptoAddressPool
  );
  const walletAddresses = mongo.db.collection<CryptoWalletAddressDocument>(
    mongoCollections.cryptoWalletAddresses
  );
  const counters = mongo.db.collection<CryptoCounterDocument>(mongoCollections.cryptoCounters);
  const seededCurrencies = new Set<string>();

  async function ensureAddressPool(): Promise<void> {
    const now = new Date();
    for (const [currency, addresses] of Object.entries(config.deposit.addressPool)) {
      if (addresses.length === 0) {
        continue;
      }
      const normalized = normalizeCurrency(currency);
      if (seededCurrencies.has(normalized)) {
        continue;
      }
      const ops = addresses.map((address) => ({
        updateOne: {
          filter: { currency: normalized, address },
          update: {
            $setOnInsert: { currency: normalized, address, createdAt: now },
            $set: { updatedAt: now }
          },
          upsert: true
        }
      }));
      if (ops.length > 0) {
        await addressPool.bulkWrite(ops, { ordered: false });
      }
      seededCurrencies.add(normalized);
    }
  }

  async function getDepositDestination(
    userId: string,
    currency: string
  ): Promise<DepositDestination> {
    const normalized = normalizeCurrency(currency);
    await ensureAddressPool();
    try {
      return await runMongoTransaction(mongo, async (session) => {
        const existing = await walletAddresses.findOne(
          { userId, currency: normalized },
          { session }
        );
        if (existing) {
          return toDestination(existing);
        }

        if (config.walletStrategy === "address_pool") {
          const assigned = await addressPool.findOneAndUpdate(
            {
              currency: normalized,
              assignedTo: { $exists: false }
            },
            {
              $set: {
                assignedTo: userId,
                assignedAt: new Date(),
                updatedAt: new Date()
              }
            },
            { session, sort: { createdAt: 1 }, returnDocument: "after" }
          );

          if (!assigned) {
            throw new Error("Deposit address pool exhausted.");
          }

          const now = new Date();
          const record: CryptoWalletAddressDocument = {
            userId,
            currency: normalized,
            address: assigned.address,
            strategy: "address_pool",
            createdAt: now,
            updatedAt: now
          };

          await walletAddresses.insertOne(record, { session });
          return toDestination(record);
        }

        const memoAddress = config.deposit.memoDepositAddresses[normalized];
        if (!memoAddress) {
          throw new Error("Memo deposit address missing for currency.");
        }

        const memo = await reserveMemo(normalized, session);
        const now = new Date();
        const record: CryptoWalletAddressDocument = {
          userId,
          currency: normalized,
          address: memoAddress,
          memo,
          strategy: "memo_tag",
          createdAt: now,
          updatedAt: now
        };

        await walletAddresses.insertOne(record, { session });
        return toDestination(record);
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        const existing = await walletAddresses.findOne({ userId, currency: normalized });
        if (existing) {
          return toDestination(existing);
        }
      }
      throw error;
    }
  }

  async function resolveDepositAttribution(
    transaction: ObserverTransaction
  ): Promise<DepositDestination | null> {
    const normalized = normalizeCurrency(transaction.currency);
    if (config.walletStrategy === "memo_tag") {
      const memoAddress = config.deposit.memoDepositAddresses[normalized];
      if (!memoAddress || memoAddress !== transaction.address || !transaction.memo) {
        return null;
      }
      const entry = await walletAddresses.findOne({
        currency: normalized,
        memo: transaction.memo
      });
      return entry ? toDestination(entry) : null;
    }

    const entry = await walletAddresses.findOne({
      currency: normalized,
      address: transaction.address
    });
    return entry ? toDestination(entry) : null;
  }

  async function listWatchedAddresses(currency: string): Promise<string[]> {
    const normalized = normalizeCurrency(currency);
    if (config.walletStrategy === "memo_tag") {
      const memoAddress = config.deposit.memoDepositAddresses[normalized];
      return memoAddress ? [memoAddress] : [];
    }
    return walletAddresses.distinct("address", { currency: normalized });
  }

  async function reserveMemo(currency: string, session: ClientSession): Promise<string> {
    const now = new Date();
    const key = `memo:${currency}`;
    const result = await counters.findOneAndUpdate(
      { key },
      {
        $setOnInsert: { key },
        $inc: { sequence: 1 },
        $set: { updatedAt: now }
      },
      { upsert: true, returnDocument: "after", session }
    );
    const sequence = Number(result?.sequence ?? 0);
    if (!Number.isFinite(sequence)) {
      throw new Error("Memo sequence unavailable.");
    }
    return sequence.toString();
  }

  return {
    ensureAddressPool,
    getDepositDestination,
    resolveDepositAttribution,
    listWatchedAddresses
  };
}

function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

function toDestination(record: CryptoWalletAddressDocument): DepositDestination {
  return {
    userId: record.userId,
    currency: record.currency,
    address: record.address,
    memo: record.memo,
    strategy: record.strategy
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}
