// Crypto gateway deposit and withdrawal integration tests.
import { createPublicKey, generateKeyPairSync, sign, timingSafeEqual, verify } from "node:crypto";
import fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/shared/config.js";
import { createLogger } from "../src/shared/logger.js";
import {
  connectMongo,
  ensureMongoCollections,
  ensureMongoIndexes,
  type MongoDependencies
} from "../src/shared/storage/mongo.js";
import { mongoCollections } from "../src/shared/storage/mongoSchemas.js";
import type { RedisClient } from "../src/shared/storage/redis.js";
import { createCryptoGatewayService } from "../src/services/crypto-gateway/cryptoGatewayService.js";
import type { SignedPayload, WithdrawalSigningPayload } from "../src/services/crypto-gateway/types.js";
import { createLedgerRepository } from "../src/services/ledger/ledgerStore.js";

type TestTransaction = {
  txId: string;
  currency: string;
  address: string;
  memo?: string;
  amount: number;
  blockHeight: number;
  observedAt: Date;
  sequence: number;
};

const payloadSchema = z.object({
  withdrawalId: z.string().min(1),
  currency: z.string().min(1),
  amount: z.number().positive().finite(),
  fromAddress: z.string().min(1),
  toAddress: z.string().min(1),
  requestedAt: z.string().min(1),
  memo: z.string().min(1).optional()
});

class TestSignerServer {
  readonly token: string;
  readonly privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  readonly publicKeyBase64: string;
  private readonly app = fastify();
  url = "";

  constructor(token: string) {
    this.token = token;
    const keyPair = generateKeyPairSync("ed25519");
    this.privateKey = keyPair.privateKey;
    const publicKey = keyPair.publicKey.export({ type: "spki", format: "der" });
    this.publicKeyBase64 = Buffer.from(publicKey).toString("base64");
  }

  async start(): Promise<void> {
    this.app.post("/signer/sign", async (request, reply) => {
      const header = request.headers["x-signer-token"];
      const candidate = Array.isArray(header) ? header[0] : header;
      if (!candidate || candidate.length !== this.token.length) {
        return reply.code(403).send({ error: "forbidden" });
      }
      if (!timingSafeEqual(Buffer.from(candidate), Buffer.from(this.token))) {
        return reply.code(403).send({ error: "forbidden" });
      }

      const body = payloadSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }

      const payload = body.data;
      const canonical = canonicalize(payload);
      const signature = sign(null, Buffer.from(canonical, "utf8"), this.privateKey);
      const signedPayload: SignedPayload = {
        payload,
        signature: signature.toString("base64"),
        publicKey: this.publicKeyBase64,
        algorithm: "ed25519",
        signedAt: new Date().toISOString()
      };

      return reply.send({ signedPayload });
    });

    const address = await this.app.listen({ host: "127.0.0.1", port: 0 });
    this.url = address;
  }

  async stop(): Promise<void> {
    await this.app.close();
  }
}

class TestObserverServer {
  private readonly app = fastify();
  private readonly transactions = new Map<string, TestTransaction>();
  private readonly clientReferences = new Map<string, string>();
  private sequence = 0;
  private blockHeight = 1;
  url = "";

  async start(): Promise<void> {
    this.app.get("/observer/transactions", async (request) => {
      const query = request.query as Record<string, string | undefined>;
      const currency = (query.currency ?? "").trim().toUpperCase();
      const addresses = (query.addresses ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      const after = query.after ? Number(query.after) : 0;
      const limit = query.limit ? Number(query.limit) : 100;

      const matching = Array.from(this.transactions.values())
        .filter((tx) => tx.currency === currency)
        .filter((tx) => addresses.length === 0 || addresses.includes(tx.address))
        .filter((tx) => tx.sequence > after)
        .sort((a, b) => a.sequence - b.sequence)
        .slice(0, Math.max(1, Math.min(200, limit)));

      const nextCursor = matching.length > 0 ? matching[matching.length - 1]?.sequence ?? after : after;

      return {
        nextCursor: nextCursor ? nextCursor.toString() : null,
        transactions: matching.map((tx) => this.toResponse(tx))
      };
    });

    this.app.get("/observer/transactions/:txId", async (request, reply) => {
      const params = request.params as { txId: string };
      const tx = this.transactions.get(params.txId);
      if (!tx) {
        return reply.code(404).send({ error: "not_found" });
      }
      return this.toResponse(tx);
    });

    this.app.post("/observer/transactions/broadcast", async (request, reply) => {
      const body = request.body as {
        currency?: string;
        signedPayload?: SignedPayload;
        clientReference?: string;
      };

      if (!body?.currency || !body.signedPayload) {
        return reply.code(400).send({ error: "invalid_request" });
      }

      const signedPayload = body.signedPayload;
      const payload = payloadSchema.safeParse(signedPayload.payload);
      if (!payload.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }

      if (!this.verifySignedPayload(signedPayload)) {
        return reply.code(400).send({ error: "invalid_signature" });
      }

      if (body.clientReference && this.clientReferences.has(body.clientReference)) {
        const existingTx = this.clientReferences.get(body.clientReference);
        return reply.send({ txId: existingTx });
      }

      const txId = `withdrawal-${Math.random().toString(16).slice(2)}`;
      const transaction: TestTransaction = {
        txId,
        currency: body.currency.trim().toUpperCase(),
        address: payload.data.toAddress,
        memo: payload.data.memo,
        amount: payload.data.amount,
        blockHeight: this.blockHeight,
        observedAt: new Date(),
        sequence: this.nextSequence()
      };

      this.transactions.set(txId, transaction);
      if (body.clientReference) {
        this.clientReferences.set(body.clientReference, txId);
      }

      return reply.send({ txId });
    });

    const address = await this.app.listen({ host: "127.0.0.1", port: 0 });
    this.url = address;
  }

  async stop(): Promise<void> {
    await this.app.close();
  }

  reset(): void {
    this.transactions.clear();
    this.clientReferences.clear();
    this.sequence = 0;
    this.blockHeight = 1;
  }

  mine(blocks = 1): void {
    this.blockHeight += Math.max(1, blocks);
  }

  mintDeposit(input: {
    currency: string;
    address: string;
    memo?: string;
    amount: number;
  }): string {
    const txId = `deposit-${Math.random().toString(16).slice(2)}`;
    const transaction: TestTransaction = {
      txId,
      currency: input.currency.trim().toUpperCase(),
      address: input.address,
      memo: input.memo,
      amount: input.amount,
      blockHeight: this.blockHeight,
      observedAt: new Date(),
      sequence: this.nextSequence()
    };
    this.transactions.set(txId, transaction);
    return txId;
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private confirmations(tx: TestTransaction): number {
    return Math.max(0, this.blockHeight - tx.blockHeight + 1);
  }

  private toResponse(tx: TestTransaction) {
    return {
      txId: tx.txId,
      currency: tx.currency,
      address: tx.address,
      memo: tx.memo,
      amount: tx.amount,
      confirmations: this.confirmations(tx),
      observedAt: tx.observedAt.toISOString(),
      blockHeight: tx.blockHeight
    };
  }

  private verifySignedPayload(signedPayload: SignedPayload): boolean {
    const canonical = canonicalize(signedPayload.payload);
    const signature = Buffer.from(signedPayload.signature, "base64");
    const publicKeyDer = Buffer.from(signedPayload.publicKey, "base64");
    const publicKey = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
    return verify(null, Buffer.from(canonical, "utf8"), publicKey, signature);
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return `{${entries.join(",")}}`;
}

describe("crypto gateway flows", () => {
  const testDbName = `crypto_hack_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const signerToken = "signer-token";
  const observer = new TestObserverServer();
  const signer = new TestSignerServer(signerToken);
  let mongo: MongoDependencies;
  let service: ReturnType<typeof createCryptoGatewayService>;
  let ledger: ReturnType<typeof createLedgerRepository>;

  beforeAll(async () => {
    await observer.start();
    await signer.start();

    const config = loadConfig({
      serviceName: "crypto-gateway-test",
      defaultPort: 4103,
      env: {
        MONGO_DB: testDbName,
        MONGO_URI: "mongodb://127.0.0.1:27018/?directConnection=true&replicaSet=rs0",
        LOG_LEVEL: "error",
        CRYPTO_SUPPORTED_CURRENCIES: "USDT",
        CRYPTO_WALLET_STRATEGY: "memo_tag",
        CRYPTO_MEMO_DEPOSIT_ADDRESS: "USDT:DEPOSIT_ADDR",
        CRYPTO_HOT_WALLET_ADDRESS: "USDT:HOT_WALLET",
        CRYPTO_SIGNER_URL: signer.url,
        CRYPTO_SIGNER_TOKEN: signerToken,
        CRYPTO_OBSERVER_URL: observer.url,
        CRYPTO_DEPOSIT_CONFIRMATIONS: "2",
        CRYPTO_WITHDRAWAL_CONFIRMATIONS: "2",
        CRYPTO_WITHDRAWAL_COOLDOWN_SECONDS: "0",
        CRYPTO_WITHDRAWAL_MAX_REQUESTS_PER_DAY: "10",
        CRYPTO_WITHDRAWAL_MAX_REQUESTS_PER_HOUR: "10",
        CRYPTO_WITHDRAWAL_AUTO_AUTHORIZE_MAX_AMOUNT: "1000000",
        CRYPTO_WITHDRAWAL_ANOMALY_MULTIPLIER: "1000000"
      }
    });
    const logger = createLogger(config);
    mongo = await connectMongo(config, logger);
    await ensureMongoCollections(mongo.db, logger);
    await ensureMongoIndexes(mongo.db, logger);

    service = createCryptoGatewayService({
      config,
      logger,
      mongo,
      redis: {} as RedisClient
    });
    ledger = createLedgerRepository(mongo);
  }, 60000);

  beforeEach(async () => {
    observer.reset();
    await mongo.db.collection(mongoCollections.cryptoDeposits).deleteMany({});
    await mongo.db.collection(mongoCollections.cryptoWithdrawals).deleteMany({});
    await mongo.db.collection(mongoCollections.cryptoWithdrawalAllowlists).deleteMany({});
    await mongo.db.collection(mongoCollections.cryptoWalletAddresses).deleteMany({});
    await mongo.db.collection(mongoCollections.cryptoAddressPool).deleteMany({});
    await mongo.db.collection(mongoCollections.cryptoGatewayState).deleteMany({});
    await mongo.db.collection(mongoCollections.cryptoCounters).deleteMany({});
    await mongo.db.collection(mongoCollections.ledgerEntries).deleteMany({});
    await mongo.db.collection(mongoCollections.ledgerAccounts).deleteMany({});
  });

  afterAll(async () => {
    await observer.stop();
    await signer.stop();
    if (mongo) {
      await mongo.db.dropDatabase();
      await mongo.client.close();
    }
  }, 20000);

  it("credits deposits after confirmations and handles duplicates", async () => {
    const destination = await service.getDepositDestination("user-1", "USDT");
    observer.mintDeposit({
      currency: "USDT",
      address: destination.address,
      memo: destination.memo,
      amount: 100
    });

    await service.processDeposits();
    let balance = await ledger.getBalance("user-1", "USDT");
    expect(balance.available).toBeCloseTo(0, 6);

    observer.mine(1);
    await service.processDeposits();
    balance = await ledger.getBalance("user-1", "USDT");
    expect(balance.available).toBeCloseTo(100, 6);

    await service.processDeposits();
    balance = await ledger.getBalance("user-1", "USDT");
    expect(balance.available).toBeCloseTo(100, 6);
  }, 30000);

  it("runs withdrawal state transitions with signing and confirmations", async () => {
    const destination = await service.getDepositDestination("user-2", "USDT");
    observer.mintDeposit({
      currency: "USDT",
      address: destination.address,
      memo: destination.memo,
      amount: 200
    });
    observer.mine(2);
    await service.processDeposits();

    const request = await service.requestWithdrawal({
      userId: "user-2",
      currency: "USDT",
      amount: 40,
      destinationAddress: "ADDR-OUT",
      idempotencyKey: "withdrawal-1"
    });
    expect(request.withdrawal.status).toBe("requested");
    expect(request.decision).toBe("review");

    const authorized = await service.authorizeWithdrawal(request.withdrawal._id.toHexString());
    expect(authorized.status).toBe("authorized");

    await service.processAuthorizedWithdrawals();
    const updated = await service.getWithdrawal(authorized._id.toHexString());
    expect(updated.status).toBe("broadcasted");
    expect(updated.txId).toBeTruthy();

    observer.mine(2);
    await service.processBroadcastedWithdrawals();
    const confirmed = await service.getWithdrawal(authorized._id.toHexString());
    expect(confirmed.status).toBe("confirmed");

    const balance = await ledger.getBalance("user-2", "USDT");
    expect(balance.available).toBeCloseTo(160, 6);
    expect(balance.spent).toBeCloseTo(40, 6);
  }, 30000);
});
