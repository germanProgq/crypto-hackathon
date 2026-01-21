// Signer service for withdrawal payload signing.
import { createPrivateKey, createPublicKey, sign, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { loadConfig, type AppConfig } from "../../shared/config.js";
import { canonicalize } from "../../shared/crypto/canonicalize.js";
import { registerHealthRoutes } from "../../shared/http/health.js";
import { createServer } from "../../shared/http/server.js";
import { createLogger } from "../../shared/logger.js";

const payloadSchema = z.object({
  withdrawalId: z.string().min(1),
  currency: z.string().min(1),
  amount: z.number().positive().finite(),
  fromAddress: z.string().min(1),
  toAddress: z.string().min(1),
  requestedAt: z.string().min(1),
  memo: z.string().min(1).optional()
});

const roundProofSchema = z.object({
  payload: z.object({
    auctionId: z.string().min(1),
    roundIndex: z.number().int().nonnegative(),
    allocationSize: z.number().int().nonnegative(),
    roundStartAt: z.string().min(1),
    roundEndAt: z.string().min(1),
    effectiveEndAt: z.string().min(1).nullable().optional(),
    extensionCount: z.number().int().nonnegative().nullable().optional(),
    antiSniping: z.object({
      triggerWindowSeconds: z.number().int().nonnegative(),
      extensionSeconds: z.number().int().nonnegative(),
      maxExtensions: z.number().int().nonnegative()
    }),
    bidsRoot: z.string().min(1),
    bidsCount: z.number().int().nonnegative(),
    winners: z.array(
      z.object({
        userId: z.string().min(1),
        bidId: z.string().min(1),
        amount: z.number().positive().finite(),
        rank: z.number().int().positive()
      })
    ),
    finalizedAt: z.string().min(1)
  })
});

const kmsResponseSchema = z.object({
  signature: z.string().min(1),
  publicKey: z.string().min(1),
  algorithm: z.literal("ed25519")
});

const localOnlyIps = new Set(["127.0.0.1", "::1", "0:0:0:0:0:0:0:1"]);
const kmsTimeoutMs = 8000;

const config = loadConfig({
  serviceName: "signer",
  defaultPort: 4007,
  env: {
    ...process.env,
    HTTP_HOST: process.env.HTTP_HOST ?? "127.0.0.1"
  }
});
const logger = createLogger(config);
const keyring = buildSigningKeyring(config.signer);

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
  if (isHealthRoute(request)) {
    return;
  }

  if (!isIpAllowed(request, config)) {
    reply.code(403).send({ error: "forbidden", message: "IP not allowed." });
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
    const signedPayload = await signPayload(payload, keyring);
    return reply.send({ signedPayload });
  } catch (error) {
    return handleSignerError(reply, error);
  }
});

app.post("/signer/sign-round-result", async (request, reply) => {
  const body = roundProofSchema.safeParse(request.body);
  if (!body.success) {
    return reply.code(400).send({ error: "invalid_request", message: "Invalid payload." });
  }

  const payload = body.data.payload;
  try {
    const signedPayload = await signPayload(payload, keyring);
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

async function signPayload(payload: unknown, ring: SigningKeyring) {
  const canonical = canonicalize(payload);
  const signatures = await Promise.all(
    ring.signers.map((signer) => signer.sign(canonical))
  );
  if (signatures.length < ring.threshold) {
    throw new Error("Signer quorum not met.");
  }
  const primary = signatures[0];
  if (!primary) {
    throw new Error("Signer quorum not met.");
  }
  const cosignatures = signatures.slice(1);
  return {
    payload,
    signature: primary.signature,
    publicKey: primary.publicKey,
    algorithm: primary.algorithm,
    signedAt: new Date().toISOString(),
    cosignatures: cosignatures.length > 0 ? cosignatures : undefined
  };
}

function loadPrivateKey(value: string) {
  if (value.includes("BEGIN")) {
    return createPrivateKey(value);
  }
  return createPrivateKey({ key: Buffer.from(value, "base64"), format: "der", type: "pkcs8" });
}

type SignerConfig = AppConfig["signer"];

type SignatureRecord = {
  signature: string;
  publicKey: string;
  algorithm: "ed25519";
};

type SigningKeyring = {
  signers: KeySigner[];
  threshold: number;
};

type KeySigner = {
  id: string;
  sign: (canonical: string) => Promise<SignatureRecord>;
};

function buildSigningKeyring(cfg: SignerConfig): SigningKeyring {
  const signers: KeySigner[] = [];
  const primaryKey = cfg.privateKey.trim();
  if (primaryKey) {
    signers.push(createLocalSigner(primaryKey, "local-0"));
  }

  const extraKeys = cfg.privateKeys.map((entry) => entry.trim()).filter(Boolean);
  for (const [index, key] of extraKeys.entries()) {
    signers.push(createLocalSigner(key, `local-${index + 1}`));
  }

  if (cfg.kmsUrl) {
    signers.push(
      createKmsSigner({
        url: cfg.kmsUrl,
        keyId: cfg.kmsKeyId,
        token: cfg.kmsToken
      })
    );
  }

  return {
    signers,
    threshold: Math.max(1, cfg.multisigThreshold)
  };
}

function createLocalSigner(keyMaterial: string, id: string): KeySigner {
  const privateKey = loadPrivateKey(keyMaterial);
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const publicKeyBase64 = Buffer.from(publicKey).toString("base64");
  return {
    id,
    async sign(canonical: string): Promise<SignatureRecord> {
      const signature = sign(null, Buffer.from(canonical, "utf8"), privateKey);
      return {
        signature: signature.toString("base64"),
        publicKey: publicKeyBase64,
        algorithm: "ed25519"
      };
    }
  };
}

function createKmsSigner(options: {
  url: string;
  keyId?: string;
  token?: string;
}): KeySigner {
  const baseUrl = normalizeBaseUrl(options.url);
  const id = options.keyId ? `kms:${options.keyId}` : "kms";
  return {
    id,
    async sign(canonical: string): Promise<SignatureRecord> {
      const headers: Record<string, string> = {
        "content-type": "application/json"
      };
      if (options.token) {
        headers["x-kms-token"] = options.token;
      }
      const response = await fetchJson(`${baseUrl}/sign`, {
        method: "POST",
        headers,
        body: JSON.stringify({ payload: canonical, keyId: options.keyId })
      });
      return kmsResponseSchema.parse(response);
    }
  };
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function fetchJson(url: string, options: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), kmsTimeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`KMS signer request failed with ${response.status}.`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
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
  if (cfg.signer.allowedIps.includes("*")) {
    return true;
  }
  const candidates = new Set(
    [request.ip, request.socket.remoteAddress]
      .map((value) => (value ? normalizeIp(value) : null))
      .filter((value): value is string => Boolean(value))
  );

  if (cfg.signer.allowedIps.length > 0) {
    for (const ip of candidates) {
      if (cfg.signer.allowedIps.includes(ip)) {
        return true;
      }
    }
    return false;
  }

  for (const ip of candidates) {
    if (localOnlyIps.has(ip) || isPrivateIp(ip)) {
      return true;
    }
  }

  return false;
}

function normalizeIp(ip: string): string {
  if (ip.startsWith("::ffff:")) {
    return ip.slice("::ffff:".length);
  }
  return ip;
}

function isPrivateIp(ip: string): boolean {
  if (ip === "::1") {
    return true;
  }

  const parts = ip.split(".").map((entry) => Number(entry));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return false;
  }

  const [first, second] = parts;
  if (first === 10 || first === 127) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  if (first === 172 && second !== undefined && second >= 16 && second <= 31) {
    return true;
  }
  return false;
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
