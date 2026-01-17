// Mock RPC service for observer and signer endpoints.
import {
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify
} from "node:crypto";
import { z } from "zod";
import { loadConfig } from "../../shared/config.js";
import { registerHealthRoutes } from "../../shared/http/health.js";
import { createServer } from "../../shared/http/server.js";
import { createLogger } from "../../shared/logger.js";
import type { SignedPayload, WithdrawalSigningPayload } from "../crypto-gateway/types.js";

const payloadSchema = z.object({
  withdrawalId: z.string().min(1),
  currency: z.string().min(1),
  amount: z.number().positive().finite(),
  fromAddress: z.string().min(1),
  toAddress: z.string().min(1),
  requestedAt: z.string().min(1),
  memo: z.string().min(1).optional()
});

const signedPayloadSchema = z.object({
  payload: payloadSchema,
  signature: z.string().min(1),
  publicKey: z.string().min(1),
  algorithm: z.literal("ed25519"),
  signedAt: z.string().min(1),
  cosignatures: z
    .array(
      z.object({
        signature: z.string().min(1),
        publicKey: z.string().min(1),
        algorithm: z.literal("ed25519")
      })
    )
    .optional()
});

const broadcastRequestSchema = z.object({
  currency: z.string().min(1),
  signedPayload: signedPayloadSchema,
  clientReference: z.string().min(1).optional()
});

const mintRequestSchema = z.object({
  currency: z.string().min(1),
  address: z.string().min(1),
  memo: z.string().min(1).optional(),
  amount: z.number().positive().finite(),
  txId: z.string().min(1).optional(),
  observedAt: z.string().min(1).optional(),
  blockHeight: z.number().int().min(1).optional()
});

const mineRequestSchema = z.object({
  blocks: z.number().int().min(1).optional()
});

const config = loadConfig({
  serviceName: "mock-rpc",
  defaultPort: 9000,
  env: {
    ...process.env,
    HTTP_HOST: process.env.HTTP_HOST ?? "0.0.0.0"
  }
});

const logger = createLogger(config);
const app = createServer({ logger, config });

registerHealthRoutes(app, {
  serviceName: config.serviceName,
  checks: [
    {
      name: "mock-rpc",
      check: async () => ({ ok: true })
    }
  ]
});

type MockTransaction = {
  txId: string;
  currency: string;
  address: string;
  memo?: string;
  amount: number;
  blockHeight: number;
  observedAt: Date;
  sequence: number;
};

const transactions = new Map<string, MockTransaction>();
const clientReferences = new Map<string, string>();
let sequence = 0;
let blockHeight = 1;

const keyPair = generateKeyPairSync("ed25519");
const publicKeyDer = keyPair.publicKey.export({ type: "spki", format: "der" });
const publicKeyBase64 = Buffer.from(publicKeyDer).toString("base64");
const strictSignatures = readEnvBoolean("MOCK_RPC_STRICT_SIGNATURES", false);

app.get("/observer/transactions", async (request) => {
  const query = request.query as Record<string, string | undefined>;
  const currency = (query.currency ?? "").trim().toUpperCase();
  const addresses = (query.addresses ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const after = coerceNumber(query.after, 0);
  const limit = Math.max(1, Math.min(200, coerceNumber(query.limit, 100)));

  const matching = Array.from(transactions.values())
    .filter((tx) => !currency || tx.currency === currency)
    .filter((tx) => addresses.length === 0 || addresses.includes(tx.address))
    .filter((tx) => tx.sequence > after)
    .sort((left, right) => left.sequence - right.sequence)
    .slice(0, limit);

  const nextCursor =
    matching.length > 0 ? matching[matching.length - 1]?.sequence ?? after : after;

  return {
    nextCursor: nextCursor ? nextCursor.toString() : null,
    transactions: matching.map(toObserverResponse)
  };
});

app.get("/observer/transactions/:txId", async (request, reply) => {
  const params = request.params as { txId: string };
  const query = request.query as Record<string, string | undefined>;
  const tx = transactions.get(params.txId);
  if (!tx) {
    return reply.code(404).send({ error: "not_found" });
  }
  if (query.currency) {
    const normalized = query.currency.trim().toUpperCase();
    if (normalized && normalized !== tx.currency) {
      return reply.code(404).send({ error: "not_found" });
    }
  }
  return toObserverResponse(tx);
});

app.post("/observer/transactions/broadcast", async (request, reply) => {
  const parsed = broadcastRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_request" });
  }

  const { currency, signedPayload, clientReference } = parsed.data;
  if (strictSignatures && !verifySignedPayload(signedPayload)) {
    return reply.code(400).send({ error: "invalid_signature" });
  }

  if (clientReference && clientReferences.has(clientReference)) {
    const existingTx = clientReferences.get(clientReference);
    return reply.send({ txId: existingTx });
  }

  const txId = `withdrawal-${randomId()}`;
  const transaction: MockTransaction = {
    txId,
    currency: currency.trim().toUpperCase(),
    address: signedPayload.payload.toAddress,
    memo: signedPayload.payload.memo,
    amount: signedPayload.payload.amount,
    blockHeight,
    observedAt: new Date(),
    sequence: nextSequence()
  };

  transactions.set(txId, transaction);
  if (clientReference) {
    clientReferences.set(clientReference, txId);
  }

  return reply.send({ txId });
});

app.post("/signer/sign", async (request, reply) => {
  const parsed = payloadSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_request" });
  }

  const payload = parsed.data;
  if (Number.isNaN(new Date(payload.requestedAt).getTime())) {
    return reply.code(400).send({ error: "invalid_request" });
  }

  const canonical = canonicalize(payload);
  const signature = sign(null, Buffer.from(canonical, "utf8"), keyPair.privateKey);
  const signedPayload: SignedPayload = {
    payload,
    signature: signature.toString("base64"),
    publicKey: publicKeyBase64,
    algorithm: "ed25519",
    signedAt: new Date().toISOString()
  };

  return reply.send({ signedPayload });
});

app.post("/mock/observer/mint", async (request, reply) => {
  const parsed = mintRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_request" });
  }

  const input = parsed.data;
  const txId = input.txId ?? `deposit-${randomId()}`;
  const observedAt = input.observedAt ? new Date(input.observedAt) : new Date();
  if (Number.isNaN(observedAt.getTime())) {
    return reply.code(400).send({ error: "invalid_request" });
  }

  const transaction: MockTransaction = {
    txId,
    currency: input.currency.trim().toUpperCase(),
    address: input.address,
    memo: input.memo,
    amount: input.amount,
    blockHeight: input.blockHeight ?? blockHeight,
    observedAt,
    sequence: nextSequence()
  };

  transactions.set(txId, transaction);
  return reply.send({ txId });
});

app.post("/mock/observer/mine", async (request) => {
  const parsed = mineRequestSchema.safeParse(request.body ?? {});
  const blocks = parsed.success ? parsed.data.blocks ?? 1 : 1;
  blockHeight += Math.max(1, blocks);
  return { blockHeight };
});

app.post("/mock/observer/reset", async () => {
  transactions.clear();
  clientReferences.clear();
  sequence = 0;
  blockHeight = 1;
  return { ok: true };
});

void start();

async function start(): Promise<void> {
  try {
    const address = await app.listen({
      host: config.http.host,
      port: config.http.port
    });
    logger.info({ address }, "Mock RPC service started");

    const shutdown = async (signal: string) => {
      logger.info({ signal }, "Mock RPC service stopping");
      await app.close();
      process.exit(0);
    };

    process.on("SIGINT", () => {
      void shutdown("SIGINT");
    });

    process.on("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
  } catch (error) {
    logger.error({ err: error }, "Mock RPC service failed to start");
    process.exit(1);
  }
}

function nextSequence(): number {
  sequence += 1;
  return sequence;
}

function confirmations(tx: MockTransaction): number {
  return Math.max(0, blockHeight - tx.blockHeight + 1);
}

function toObserverResponse(tx: MockTransaction) {
  return {
    txId: tx.txId,
    currency: tx.currency,
    address: tx.address,
    memo: tx.memo,
    amount: tx.amount,
    confirmations: confirmations(tx),
    observedAt: tx.observedAt.toISOString(),
    blockHeight: tx.blockHeight
  };
}

function verifySignedPayload(signedPayload: SignedPayload): boolean {
  try {
    const canonical = canonicalize(signedPayload.payload);
    const signature = Buffer.from(signedPayload.signature, "base64");
    const publicKeyDer = Buffer.from(signedPayload.publicKey, "base64");
    const publicKey = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
    return verify(null, Buffer.from(canonical, "utf8"), publicKey, signature);
  } catch (error) {
    logger.warn({ err: error }, "Failed to verify mock signature");
    return false;
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

function readEnvBoolean(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function randomId(): string {
  return Math.random().toString(16).slice(2);
}

function coerceNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
