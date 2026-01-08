// Ledger core integration tests.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/shared/config.js";
import { createLogger } from "../src/shared/logger.js";
import {
  connectMongo,
  ensureMongoCollections,
  ensureMongoIndexes,
  type MongoDependencies
} from "../src/shared/storage/mongo.js";
import { mongoCollections } from "../src/shared/storage/mongoSchemas.js";
import { LedgerError, createLedgerRepository } from "../src/services/ledger/ledgerStore.js";

describe("ledger core", () => {
  const testDbName = `crypto_hack_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const config = loadConfig({
    serviceName: "ledger-test",
    defaultPort: 4102,
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
  });

  afterAll(async () => {
    if (mongo) {
      await mongo.db.dropDatabase();
      await mongo.client.close();
    }
  }, 20000);

  it("enforces idempotency for ledger entries", async () => {
    const first = await ledger.createEntry({
      userId: "user-1",
      entryType: "deposit_confirmed",
      amount: 100,
      currency: "USDT",
      idempotencyKey: "deposit-1"
    });

    const repeat = await ledger.createEntry({
      userId: "user-1",
      entryType: "deposit_confirmed",
      amount: 100,
      currency: "USDT",
      idempotencyKey: "deposit-1"
    });

    expect(repeat.entry._id).toEqual(first.entry._id);

    await expect(
      ledger.createEntry({
        userId: "user-1",
        entryType: "deposit_confirmed",
        amount: 200,
        currency: "USDT",
        idempotencyKey: "deposit-1"
      })
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  }, 15000);

  it("prevents concurrent holds from overspending", async () => {
    await ledger.createEntry({
      userId: "user-2",
      entryType: "deposit_confirmed",
      amount: 100,
      currency: "USDT",
      idempotencyKey: "deposit-2"
    });

    const requests = Array.from({ length: 10 }, (_, index) =>
      ledger.createHold({
        userId: "user-2",
        amount: 20,
        currency: "USDT",
        holdId: `hold-${index}`,
        idempotencyKey: `hold-${index}`
      })
    );

    const results = await Promise.allSettled(requests);
    const successes = results.filter((result) => result.status === "fulfilled");
    const failures = results.filter((result) => result.status === "rejected");

    const balance = await ledger.getBalance("user-2", "USDT");
    expect(balance.available).toBeGreaterThanOrEqual(0);
    expect(balance.held).toBeGreaterThanOrEqual(0);
    expect(balance.current).toBeCloseTo(100, 5);
    expect(balance.held).toBeCloseTo(successes.length * 20, 5);

    for (const failure of failures) {
      const reason = (failure as PromiseRejectedResult).reason;
      if (reason instanceof LedgerError) {
        expect(["insufficient_funds", "hold_exists"]).toContain(reason.code);
      }
    }
  }, 15000);

  it("releases holds without negative balances under concurrency", async () => {
    await ledger.createEntry({
      userId: "user-3",
      entryType: "deposit_confirmed",
      amount: 100,
      currency: "USDT",
      idempotencyKey: "deposit-3"
    });

    await ledger.createHold({
      userId: "user-3",
      amount: 25,
      currency: "USDT",
      holdId: "hold-a",
      idempotencyKey: "hold-a"
    });
    await ledger.createHold({
      userId: "user-3",
      amount: 15,
      currency: "USDT",
      holdId: "hold-b",
      idempotencyKey: "hold-b"
    });
    await ledger.createHold({
      userId: "user-3",
      amount: 30,
      currency: "USDT",
      holdId: "hold-c",
      idempotencyKey: "hold-c"
    });

    const releases = [
      {
        holdId: "hold-a",
        amount: 25,
        idempotencyKey: "release-a"
      },
      {
        holdId: "hold-b",
        amount: 15,
        idempotencyKey: "release-b"
      },
      {
        holdId: "hold-c",
        amount: 30,
        idempotencyKey: "release-c"
      }
    ].map((entry) =>
      ledger.releaseHold({
        userId: "user-3",
        currency: "USDT",
        ...entry
      })
    );

    await Promise.all(releases);

    const balance = await ledger.getBalance("user-3", "USDT");
    expect(balance.available).toBeCloseTo(100, 5);
    expect(balance.held).toBeCloseTo(0, 5);
    expect(balance.current).toBeCloseTo(100, 5);
  }, 15000);
});
