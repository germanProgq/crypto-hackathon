// Deposit address management service.
import type { Collection } from "mongodb";
import type { MongoDependencies } from "../../shared/storage/mongo.js";
import {
  mongoCollections,
  type DepositAddressDocument
} from "../../shared/storage/mongoSchemas.js";
import type {
  DepositAddressRequest,
  DepositAddressResult,
  WalletStrategyProvider
} from "./walletStrategy.js";

export interface DepositAddressService {
  getOrCreateDepositAddress(
    userId: string,
    currency: string
  ): Promise<DepositAddressResult>;
  findByAddress(
    address: string,
    currency: string,
    memo?: string
  ): Promise<DepositAddressDocument | null>;
  updateLastUsed(userId: string, currency: string): Promise<void>;
}

export function createDepositAddressService(
  mongo: MongoDependencies,
  walletStrategy: WalletStrategyProvider
): DepositAddressService {
  const collection = mongo.db.collection<DepositAddressDocument>(
    mongoCollections.depositAddresses
  );

  async function getOrCreateDepositAddress(
    userId: string,
    currency: string
  ): Promise<DepositAddressResult> {
    const existing = await collection.findOne({ userId, currency });

    if (existing) {
      return {
        address: existing.address,
        memo: existing.memo,
        strategy: existing.strategy
      };
    }

    const request: DepositAddressRequest = { userId, currency };
    const result = await walletStrategy.generateDepositAddress(request);

    const now = new Date();
    const document: DepositAddressDocument = {
      userId,
      currency,
      strategy: result.strategy,
      address: result.address,
      memo: result.memo,
      createdAt: now,
      lastUsedAt: now
    };

    await collection.insertOne(document);

    return result;
  }

  async function findByAddress(
    address: string,
    currency: string,
    memo?: string
  ): Promise<DepositAddressDocument | null> {
    const strategy = walletStrategy.getStrategy();

    if (strategy === "address_per_user") {
      return collection.findOne({ address, currency });
    }

    if (strategy === "memo_tag") {
      if (!memo) {
        return null;
      }
      return collection.findOne({ address, currency, memo });
    }

    return null;
  }

  async function updateLastUsed(userId: string, currency: string): Promise<void> {
    await collection.updateOne(
      { userId, currency },
      { $set: { lastUsedAt: new Date() } }
    );
  }

  return {
    getOrCreateDepositAddress,
    findByAddress,
    updateLastUsed
  };
}
