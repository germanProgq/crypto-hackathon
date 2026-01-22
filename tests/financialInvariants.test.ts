// @ts-nocheck
// Financial invariant tests: mathematical proof of correctness.
// Tests validate that ledger maintains financial integrity under all conditions.
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/shared/config.js";
import { createLogger } from "../src/shared/logger.js";
import {
  connectMongo,
  ensureMongoCollections,
  ensureMongoIndexes,
  type MongoDependencies
} from "../src/shared/storage/mongo.js";
import {
  mongoCollections,
  type AuctionDocument,
  type AuctionRoundConfig,
  type BidDocument,
  type LedgerEntryDocument,
  type LedgerAccountDocument
} from "../src/shared/storage/mongoSchemas.js";
import { createLedgerRepository } from "../src/services/ledger/ledgerStore.js";
import { createAuctionRepository } from "../src/services/auction-engine/auctionStore.js";
import { hasDocker } from "./support/infra.js";

const describeInfra = hasDocker() ? describe : describe.skip;

describeInfra("Financial Invariants", () => {
  const testDbName = `crypto_hack_invariants_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const config = loadConfig({
    serviceName: "invariants-test",
    defaultPort: 4300,
    env: {
      MONGO_DB: testDbName,
      MONGO_URI: "mongodb://127.0.0.1:27018/?directConnection=true&replicaSet=rs0",
      LOG_LEVEL: "error"
    }
  });
  const logger = createLogger(config);
  let mongo: MongoDependencies;
  let ledger: ReturnType<typeof createLedgerRepository>;

  beforeAll(async () => {
    mongo = await connectMongo(config, logger);
    await ensureMongoCollections(mongo.db, logger);
    await ensureMongoIndexes(mongo.db, logger);
    ledger = createLedgerRepository(mongo);
  }, 60000);

  beforeEach(async () => {
    await mongo.db.collection(mongoCollections.ledgerEntries).deleteMany({});
    await mongo.db.collection(mongoCollections.ledgerAccounts).deleteMany({});
    await mongo.db.collection(mongoCollections.bids).deleteMany({});
    await mongo.db.collection(mongoCollections.auctions).deleteMany({});
  });

  afterAll(async () => {
    if (mongo) {
      await mongo.db.dropDatabase();
      await mongo.client.close();
    }
  }, 20000);

  it("INVARIANT 1: Money conservation - total funds remain constant across all operations", async () => {
    const users = ["user-1", "user-2", "user-3", "user-4", "user-5"];
    const initialDeposits = [1000, 500, 750, 1200, 300];

    // Deposit initial funds for all users
    for (let i = 0; i < users.length; i++) {
      await ledger.createEntry({
        userId: users[i],
        entryType: "deposit_confirmed",
        amount: initialDeposits[i],
        currency: "USDT",
        idempotencyKey: `deposit-${users[i]}-${Date.now()}`
      });
    }

    const totalInitial = initialDeposits.reduce((sum, d) => sum + d, 0);

    // Execute random operations: holds, releases, captures
    const operations = [];
    for (let i = 0; i < 50; i++) {
      const userIndex = Math.floor(Math.random() * users.length);
      const userId = users[userIndex];
      const holdId = `hold-${userId}-${i}`;
      const amount = Math.floor(Math.random() * 50) + 1;

      operations.push({ userId, holdId, amount });
    }

    // Execute holds (some will fail due to insufficient funds - expected)
    const successfulHolds: typeof operations = [];
    for (const op of operations) {
      try {
        await ledger.createHold({
          userId: op.userId,
          amount: op.amount,
          currency: "USDT",
          holdId: op.holdId,
          idempotencyKey: `hold-${op.holdId}-${Date.now()}`
        });
        successfulHolds.push(op);
      } catch {
        // Insufficient funds - expected behavior
      }
    }

    // Release half, capture the other half
    const halfIndex = Math.floor(successfulHolds.length / 2);
    for (let i = 0; i < successfulHolds.length; i++) {
      const op = successfulHolds[i];
      if (i < halfIndex) {
        await ledger.releaseHold({
          userId: op.userId,
          amount: op.amount,
          currency: "USDT",
          holdId: op.holdId,
          idempotencyKey: `release-${op.holdId}-${Date.now()}`
        });
      } else {
        await ledger.captureHold({
          userId: op.userId,
          amount: op.amount,
          currency: "USDT",
          holdId: op.holdId,
          idempotencyKey: `capture-${op.holdId}-${Date.now()}`
        });
      }
    }

    // Verify total funds conservation
    let totalFinalBalances = 0;
    let totalCaptured = 0;
    for (const userId of users) {
      const balance = await ledger.getBalance(userId, "USDT");
      totalFinalBalances += balance.current;
      totalCaptured += balance.spent;
    }

    // Total = all balances + all captured amounts (captured funds left the user accounts)
    expect(totalFinalBalances + totalCaptured).toBeCloseTo(totalInitial, 6);
  }, 30000);

  it("INVARIANT 2: No negative balances - available and held are always >= 0", async () => {
    await ledger.createEntry({
      userId: "user-negative-test",
      entryType: "deposit_confirmed",
      amount: 100,
      currency: "USDT",
      idempotencyKey: `deposit-negative-${Date.now()}`
    });

    // Try to create holds that exceed balance
    const holdPromises = Array.from({ length: 10 }, (_, i) =>
      ledger.createHold({
        userId: "user-negative-test",
        amount: 20,
        currency: "USDT",
        holdId: `hold-neg-${i}`,
        idempotencyKey: `hold-neg-${i}-${Date.now()}`
      }).catch(() => null) // Swallow errors for insufficient funds
    );

    await Promise.all(holdPromises);

    const balance = await ledger.getBalance("user-negative-test", "USDT");

    expect(balance.available).toBeGreaterThanOrEqual(0);
    expect(balance.held).toBeGreaterThanOrEqual(0);
    expect(balance.current).toBeGreaterThanOrEqual(0);
    expect(balance.current).toBeCloseTo(100, 6); // Total should still be initial deposit
  }, 15000);

  it("INVARIANT 3: Balance equation - available + held = deposits - withdrawals - captures", async () => {
    const userId = "user-equation-test";

    // Deposit 1000
    await ledger.createEntry({
      userId,
      entryType: "deposit_confirmed",
      amount: 1000,
      currency: "USDT",
      idempotencyKey: `deposit-eq-${Date.now()}`
    });

    // Create holds
    await ledger.createHold({
      userId,
      amount: 200,
      currency: "USDT",
      holdId: "hold-eq-1",
      idempotencyKey: `hold-eq-1-${Date.now()}`
    });

    await ledger.createHold({
      userId,
      amount: 150,
      currency: "USDT",
      holdId: "hold-eq-2",
      idempotencyKey: `hold-eq-2-${Date.now()}`
    });

    // Capture one hold
    await ledger.captureHold({
      userId,
      amount: 200,
      currency: "USDT",
      holdId: "hold-eq-1",
      idempotencyKey: `capture-eq-1-${Date.now()}`
    });

    // Release other hold
    await ledger.releaseHold({
      userId,
      amount: 150,
      currency: "USDT",
      holdId: "hold-eq-2",
      idempotencyKey: `release-eq-2-${Date.now()}`
    });

    const balance = await ledger.getBalance(userId, "USDT");

    // Available = 1000 - 200 (captured) = 800
    // Held = 0 (all holds resolved)
    // Spent = 200 (captured)
    expect(balance.available).toBeCloseTo(800, 6);
    expect(balance.held).toBeCloseTo(0, 6);
    expect(balance.spent).toBeCloseTo(200, 6);
    expect(balance.current).toBeCloseTo(800, 6);
    expect(balance.available + balance.held).toBeCloseTo(balance.current, 6);
  }, 15000);

  it("INVARIANT 4: Idempotency - duplicate operations don't change balance", async () => {
    const userId = "user-idemp-test";
    const idempKey = `idemp-${Date.now()}`;

    await ledger.createEntry({
      userId,
      entryType: "deposit_confirmed",
      amount: 500,
      currency: "USDT",
      idempotencyKey: `deposit-idemp-${Date.now()}`
    });

    // Execute same hold multiple times
    const holdPromises = Array.from({ length: 5 }, () =>
      ledger.createHold({
        userId,
        amount: 100,
        currency: "USDT",
        holdId: "hold-idemp",
        idempotencyKey: idempKey
      })
    );

    const results = await Promise.all(holdPromises);

    // All should return the same entry
    const entryIds = new Set(results.map((r) => r.entry._id.toString()));
    expect(entryIds.size).toBe(1);

    const balance = await ledger.getBalance(userId, "USDT");
    expect(balance.held).toBeCloseTo(100, 6); // Only one hold created
    expect(balance.available).toBeCloseTo(400, 6);
  }, 15000);

  it("INVARIANT 5: Sum of bid amounts never exceeds sum of holds", async () => {
    const auctionId = new ObjectId();
    const bidsCollection = mongo.db.collection<BidDocument>(mongoCollections.bids);
    const users = ["bidder-1", "bidder-2", "bidder-3"];

    // Fund users
    for (const userId of users) {
      await ledger.createEntry({
        userId,
        entryType: "deposit_confirmed",
        amount: 500,
        currency: "USDT",
        idempotencyKey: `deposit-bid-${userId}-${Date.now()}`
      });
    }

    // Create bids with holds
    const bidAmounts = [100, 150, 200];
    for (let i = 0; i < users.length; i++) {
      const bidId = new ObjectId();

      // Create hold
      await ledger.createHold({
        userId: users[i],
        amount: bidAmounts[i],
        currency: "USDT",
        holdId: bidId.toHexString(),
        idempotencyKey: `hold-bid-${bidId}-${Date.now()}`
      });

      // Insert bid
      await bidsCollection.insertOne({
        _id: bidId,
        auctionId,
        userId: users[i],
        amount: bidAmounts[i],
        createdAt: new Date(),
        idempotencyKey: `bid-${bidId}-${Date.now()}`,
        active: true
      });
    }

    // Calculate totals
    const totalBidAmounts = (await bidsCollection.find({ auctionId }).toArray())
      .reduce((sum, bid) => sum + bid.amount, 0);

    let totalHeld = 0;
    for (const userId of users) {
      const balance = await ledger.getBalance(userId, "USDT");
      totalHeld += balance.held;
    }

    expect(totalBidAmounts).toBeLessThanOrEqual(totalHeld);
    expect(totalBidAmounts).toBeCloseTo(totalHeld, 6); // Should be equal in this case
  }, 15000);

  it("INVARIANT 6: Reconciliation produces consistent results", async () => {
    const userId = "user-reconcile-test";

    await ledger.createEntry({
      userId,
      entryType: "deposit_confirmed",
      amount: 1000,
      currency: "USDT",
      idempotencyKey: `deposit-rec-${Date.now()}`
    });

    await ledger.createHold({
      userId,
      amount: 300,
      currency: "USDT",
      holdId: "hold-rec-1",
      idempotencyKey: `hold-rec-1-${Date.now()}`
    });

    await ledger.captureHold({
      userId,
      amount: 300,
      currency: "USDT",
      holdId: "hold-rec-1",
      idempotencyKey: `capture-rec-1-${Date.now()}`
    });

    const reconciliation = await ledger.reconcile(userId, "USDT");

    expect(reconciliation.balanceMatches).toBe(true);
    expect(reconciliation.issues).toHaveLength(0);
    expect(reconciliation.balance.current).toBeCloseTo(
      reconciliation.expectedCurrent,
      6
    );
  }, 15000);

  it("INVARIANT 7: Concurrent holds from same user are serialized correctly", async () => {
    const userId = "user-concurrent-holds";

    await ledger.createEntry({
      userId,
      entryType: "deposit_confirmed",
      amount: 100,
      currency: "USDT",
      idempotencyKey: `deposit-conc-${Date.now()}`
    });

    // Try to create 10 holds of 20 each (only 5 should succeed)
    const holdPromises = Array.from({ length: 10 }, (_, i) =>
      ledger.createHold({
        userId,
        amount: 20,
        currency: "USDT",
        holdId: `hold-conc-${i}`,
        idempotencyKey: `hold-conc-${i}-${Date.now()}`
      }).then(() => ({ success: true, index: i }))
        .catch(() => ({ success: false, index: i }))
    );

    const results = await Promise.all(holdPromises);
    const successCount = results.filter((r) => r.success).length;

    const balance = await ledger.getBalance(userId, "USDT");

    // At most 5 holds should succeed (100 / 20 = 5)
    expect(successCount).toBeLessThanOrEqual(5);
    expect(balance.available).toBeGreaterThanOrEqual(0);
    expect(balance.held).toBeCloseTo(successCount * 20, 6);
    expect(balance.current).toBeCloseTo(100, 6);
  }, 15000);

  it("INVARIANT 8: Withdrawal flow maintains balance integrity", async () => {
    const userId = "user-withdrawal-test";

    await ledger.createEntry({
      userId,
      entryType: "deposit_confirmed",
      amount: 500,
      currency: "USDT",
      idempotencyKey: `deposit-wd-${Date.now()}`
    });

    // Request withdrawal
    await ledger.requestWithdrawal({
      userId,
      amount: 200,
      currency: "USDT",
      withdrawalId: "wd-1",
      idempotencyKey: `wd-req-${Date.now()}`
    });

    let balance = await ledger.getBalance(userId, "USDT");
    expect(balance.available).toBeCloseTo(300, 6);
    expect(balance.held).toBeCloseTo(200, 6);

    // Confirm withdrawal
    await ledger.confirmWithdrawal({
      userId,
      amount: 200,
      currency: "USDT",
      withdrawalId: "wd-1",
      idempotencyKey: `wd-conf-${Date.now()}`
    });

    balance = await ledger.getBalance(userId, "USDT");
    expect(balance.available).toBeCloseTo(300, 6);
    expect(balance.held).toBeCloseTo(0, 6);
    expect(balance.current).toBeCloseTo(300, 6);
    expect(balance.spent).toBeCloseTo(200, 6);
  }, 15000);

  it("INVARIANT 9: Failed withdrawal returns funds to available", async () => {
    const userId = "user-wd-fail-test";

    await ledger.createEntry({
      userId,
      entryType: "deposit_confirmed",
      amount: 500,
      currency: "USDT",
      idempotencyKey: `deposit-wdf-${Date.now()}`
    });

    await ledger.requestWithdrawal({
      userId,
      amount: 200,
      currency: "USDT",
      withdrawalId: "wd-fail-1",
      idempotencyKey: `wd-req-fail-${Date.now()}`
    });

    // Fail the withdrawal
    await ledger.failWithdrawal({
      userId,
      amount: 200,
      currency: "USDT",
      withdrawalId: "wd-fail-1",
      idempotencyKey: `wd-fail-${Date.now()}`
    });

    const balance = await ledger.getBalance(userId, "USDT");
    expect(balance.available).toBeCloseTo(500, 6); // Full amount returned
    expect(balance.held).toBeCloseTo(0, 6);
    expect(balance.current).toBeCloseTo(500, 6);
  }, 15000);

  it("INVARIANT 10: Stress test - 100 random operations maintain integrity", async () => {
    const users = ["stress-1", "stress-2", "stress-3"];

    // Initial deposits
    for (const userId of users) {
      await ledger.createEntry({
        userId,
        entryType: "deposit_confirmed",
        amount: 1000,
        currency: "USDT",
        idempotencyKey: `deposit-stress-${userId}-${Date.now()}`
      });
    }

    const totalInitial = users.length * 1000;
    const activeHolds = new Map<string, { userId: string; amount: number }>();

    // Execute 100 random operations
    for (let i = 0; i < 100; i++) {
      const userId = users[Math.floor(Math.random() * users.length)];
      const holdId = `stress-hold-${i}`;
      const amount = Math.floor(Math.random() * 50) + 1;

      const opType = Math.random();

      if (opType < 0.4) {
        // Create hold
        try {
          await ledger.createHold({
            userId,
            amount,
            currency: "USDT",
            holdId,
            idempotencyKey: `stress-hold-${holdId}-${Date.now()}`
          });
          activeHolds.set(holdId, { userId, amount });
        } catch {
          // Insufficient funds - expected
        }
      } else if (opType < 0.7 && activeHolds.size > 0) {
        // Release a random hold
        const keys = Array.from(activeHolds.keys());
        const key = keys[Math.floor(Math.random() * keys.length)];
        const hold = activeHolds.get(key)!;
        try {
          await ledger.releaseHold({
            userId: hold.userId,
            amount: hold.amount,
            currency: "USDT",
            holdId: key,
            idempotencyKey: `stress-release-${key}-${Date.now()}`
          });
          activeHolds.delete(key);
        } catch {
          // Already resolved - expected in concurrent scenario
        }
      } else if (activeHolds.size > 0) {
        // Capture a random hold
        const keys = Array.from(activeHolds.keys());
        const key = keys[Math.floor(Math.random() * keys.length)];
        const hold = activeHolds.get(key)!;
        try {
          await ledger.captureHold({
            userId: hold.userId,
            amount: hold.amount,
            currency: "USDT",
            holdId: key,
            idempotencyKey: `stress-capture-${key}-${Date.now()}`
          });
          activeHolds.delete(key);
        } catch {
          // Already resolved - expected
        }
      }
    }

    // Verify total conservation
    let totalFinal = 0;
    let totalCaptured = 0;
    for (const userId of users) {
      const balance = await ledger.getBalance(userId, "USDT");
      totalFinal += balance.current;
      totalCaptured += balance.spent;

      // Each user should have non-negative balances
      expect(balance.available).toBeGreaterThanOrEqual(-1e-9);
      expect(balance.held).toBeGreaterThanOrEqual(-1e-9);
    }

    expect(totalFinal + totalCaptured).toBeCloseTo(totalInitial, 6);
  }, 60000);
});
