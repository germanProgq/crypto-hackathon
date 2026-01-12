// Signer service for withdrawal payload signing.
import { createPrivateKey, createPublicKey, sign, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { loadConfig } from "../../shared/config.js";
import { registerHealthRoutes } from "../../shared/http/health.js";
import { createServer } from "../../shared/http/server.js";
import { createLogger } from "../../shared/logger.js";
import type { WithdrawalSigningPayload } from "../crypto-gateway/types.js";

const payloadSchema = z.object({
  withdrawalId: z.string().min(1),
  currency: z.string().min(1),
  amount: z.number().positive().finite(),
  fromAddress: z.string().min(1),
  toAddress: z.string().min(1),
  requestedAt: z.string().min(1),
  memo: z.string().min(1).optional()
});

const localOnlyIps = new Set(["127.0.0.1", "::1", "0:0:0:0:0:0:0:1"]);

const config = loadConfig({
  serviceName: "signer",
  defaultPort: 4007,
  env: {
    ...process.env,
    HTTP_HOST: process.env.HTTP_HOST ?? "127.0.0.1"
  }
});
const logger = createLogger(config);
const privateKey = loadPrivateKey(config.signer.privateKey);
const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
const publicKeyBase64 = Buffer.from(publicKey).toString("base64");

const app = createServer({ logger, config });

registerHealthRoutes(app, {
  serviceName: config.serviceName,
  checks: [
    {
      name: "signer",
      check: async () => ({ ok: true })
    }
  ]
});

app.addHook("preHandler", async (request, reply) => {
  if (!isIpAllowed(request, config)) {
    reply.code(403).send({ error: "forbidden", message: "IP not allowed." });
    return reply;
  }

  if (isHealthRoute(request)) {
    return reply;
  }

  if (!authorizeSigner(request, config)) {
    reply.code(403).send({ error: "forbidden", message: "Signer token required." });
    return reply;
  }
});

app.post("/signer/sign", async (request, reply) => {
  const body = payloadSchema.safeParse(request.body);
  if (!body.success) {
    return reply.code(400).send({ error: "invalid_request", message: "Invalid payload." });
  }

  const payload = body.data;
  if (Number.isNaN(new Date(payload.requestedAt).getTime())) {
    return reply.code(400).send({ error: "invalid_request", message: "Invalid requestedAt." });
  }

  try {
    const signedPayload = signPayload(payload);
    return reply.send({ signedPayload });
  } catch (error) {
    return handleSignerError(reply, error);
  }
});

void start();

async function start(): Promise<void> {
  try {
    const address = await app.listen({
      host: config.http.host,
      port: config.http.port
    });
    logger.info({ address }, "Signer service started");

    const shutdown = async (signal: string) => {
      logger.info({ signal }, "Signer service stopping");
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
    logger.error({ err: error }, "Signer service failed to start");
    process.exit(1);
  }
}

function signPayload(payload: WithdrawalSigningPayload) {
  const canonical = canonicalize(payload);
  const signature = sign(null, Buffer.from(canonical, "utf8"), privateKey);
  return {
    payload,
    signature: signature.toString("base64"),
    publicKey: publicKeyBase64,
    algorithm: "ed25519" as const,
    signedAt: new Date().toISOString()
  };
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

function loadPrivateKey(value: string) {
  if (value.includes("BEGIN")) {
    return createPrivateKey(value);
  }
  return createPrivateKey({ key: Buffer.from(value, "base64"), format: "der", type: "pkcs8" });
}

function authorizeSigner(request: FastifyRequest, cfg: typeof config): boolean {
  const header = request.headers["x-signer-token"];
  const candidate = Array.isArray(header) ? header[0] : header;
  const token = cfg.signer.apiToken;
  if (!candidate) {
    return false;
  }
  if (candidate.length !== token.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
}

function isIpAllowed(request: FastifyRequest, cfg: typeof config): boolean {
  const ip = normalizeIp(request.ip);
  if (cfg.signer.allowedIps.length > 0) {
    return cfg.signer.allowedIps.includes(ip);
  }
  return localOnlyIps.has(ip);
}

function normalizeIp(ip: string): string {
  if (ip.startsWith("::ffff:")) {
    return ip.slice("::ffff:".length);
  }
  return ip;
}

function isHealthRoute(request: FastifyRequest): boolean {
  const url = request.raw.url ?? "";
  return url.startsWith("/health/");
}

function handleSignerError(reply: FastifyReply, error: unknown) {
  if (error instanceof Error) {
    return reply.code(500).send({ error: "internal_error", message: error.message });
  }

  return reply.code(500).send({ error: "internal_error", message: "Unknown error." });
}
