import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServiceDependencies } from "../service.js";
import { extractTelegramInitData, verifyTelegramInitData } from "./telegram.js";

export type CoreAuthContext =
  | { kind: "service" }
  | { kind: "user"; userId: string; source: "telegram" | "demo" };

type AuthResolution =
  | { ok: true; context: CoreAuthContext }
  | { ok: false; status: number; code: string; message: string };

export function requireCoreAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: ServiceDependencies
): CoreAuthContext | null {
  const resolved = resolveCoreAuth(request, deps);
  if (resolved.ok) {
    return resolved.context;
  }
  reply.code(resolved.status).send({ error: resolved.code, message: resolved.message });
  return null;
}

export function requireServiceAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: ServiceDependencies
): boolean {
  const context = requireCoreAuth(request, reply, deps);
  if (!context) {
    return false;
  }
  if (context.kind !== "service") {
    reply.code(403).send({ error: "forbidden", message: "Service token required." });
    return false;
  }
  return true;
}

export function resolveUserIdFromAuth(
  auth: CoreAuthContext,
  candidateUserId: string | undefined,
  reply: FastifyReply
): string | null {
  if (auth.kind === "service") {
    const normalized = normalizeUserId(candidateUserId);
    if (!normalized) {
      reply.code(400).send({ error: "invalid_request", message: "userId is required." });
      return null;
    }
    return normalized;
  }

  if (candidateUserId && candidateUserId !== auth.userId) {
    reply.code(403).send({ error: "forbidden", message: "User id mismatch." });
    return null;
  }

  return auth.userId;
}

function resolveCoreAuth(
  request: FastifyRequest,
  deps: ServiceDependencies
): AuthResolution {
  const serviceToken = readServiceToken(request.headers);
  const configuredToken = deps.config.coreApi.token;

  if (serviceToken) {
    if (!configuredToken) {
      return {
        ok: false,
        status: 403,
        code: "forbidden",
        message: "Service token is not configured."
      };
    }
    if (secureCompare(configuredToken, serviceToken)) {
      return { ok: true, context: { kind: "service" } };
    }
    return { ok: false, status: 403, code: "forbidden", message: "Invalid service token." };
  }

  const initData = extractTelegramInitData(request.headers);
  if (initData) {
    if (!deps.config.telegram.botToken) {
      return {
        ok: false,
        status: 500,
        code: "telegram_not_configured",
        message: "Telegram bot token is not configured."
      };
    }
    const verified = verifyTelegramInitData(
      initData,
      deps.config.telegram.botToken,
      deps.config.telegram.webAppMaxAgeSeconds
    );
    if (!verified) {
      return {
        ok: false,
        status: 401,
        code: "telegram_invalid",
        message: "Invalid Telegram init data."
      };
    }
    return {
      ok: true,
      context: { kind: "user", userId: verified.user.id, source: "telegram" }
    };
  }

  const allowDemoUser = deps.config.web.allowDemoUser && deps.config.env !== "production";
  if (allowDemoUser) {
    const demoUserId = normalizeDemoUserId(getHeaderValue(request.headers, "x-demo-user-id"));
    if (demoUserId) {
      return { ok: true, context: { kind: "user", userId: demoUserId, source: "demo" } };
    }
  }

  return {
    ok: false,
    status: 401,
    code: "auth_required",
    message: "Service token or Telegram init data required."
  };
}

function readServiceToken(headers: Record<string, string | string[] | undefined>): string | null {
  const header = getHeaderValue(headers, "x-service-token");
  if (header) {
    return header;
  }
  const authorization = getHeaderValue(headers, "authorization");
  if (authorization && authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return null;
}

function getHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  key: string
): string | null {
  const value = headers[key];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function normalizeDemoUserId(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) {
    return null;
  }
  return trimmed;
}

function normalizeUserId(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function secureCompare(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
