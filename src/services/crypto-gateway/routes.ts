// Crypto gateway HTTP routes and validation.
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ServiceDependencies } from "../../shared/service.js";
import { LedgerError } from "../ledger/ledgerStore.js";
import {
  CryptoGatewayError,
  createCryptoGatewayService,
  type WithdrawalRequestInput
} from "./cryptoGatewayService.js";
import {
  requireCoreAuth,
  resolveUserIdFromAuth
} from "../../shared/auth/coreAuth.js";

const currencyQuerySchema = z.object({
  currency: z.string().min(1)
});

const withdrawalRequestSchema = z.object({
  userId: z.string().min(1).optional(),
  currency: z.string().min(1),
  amount: z.number().positive().finite(),
  destinationAddress: z.string().min(1),
  memo: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1)
});

const authorizeSchema = z.object({
  actorId: z.string().min(1).optional()
});

const allowlistSchema = z.object({
  userId: z.string().min(1),
  currency: z.string().min(1),
  address: z.string().min(1),
  label: z.string().min(1).optional()
});

export async function registerCryptoGatewayRoutes(
  app: FastifyInstance,
  deps: ServiceDependencies
): Promise<void> {
  const service = createCryptoGatewayService(deps);

  app.get("/crypto/:userId/deposit-address", async (request, reply) => {
    const auth = requireCoreAuth(request, reply, deps);
    if (!auth) {
      return;
    }
    const query = currencyQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "invalid_request", message: "currency is required." });
    }

    try {
      const params = request.params as { userId: string };
      const userId = resolveUserIdFromAuth(auth, params.userId, reply);
      if (!userId) {
        return;
      }
      const destination = await service.getDepositDestination(userId, query.data.currency);
      return destination;
    } catch (error) {
      return handleCryptoError(reply, error);
    }
  });

  app.post("/crypto/withdrawals/request", async (request, reply) => {
    const auth = requireCoreAuth(request, reply, deps);
    if (!auth) {
      return;
    }
    const body = withdrawalRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid withdrawal payload." });
    }

    try {
      const userId = resolveUserIdFromAuth(auth, body.data.userId, reply);
      if (!userId) {
        return;
      }
      const result = await service.requestWithdrawal({
        ...body.data,
        userId
      } as WithdrawalRequestInput);
      return {
        withdrawal: serializeWithdrawal(result.withdrawal),
        balance: result.balance,
        decision: result.decision,
        flags: result.flags,
        violations: result.violations
      };
    } catch (error) {
      return handleCryptoError(reply, error);
    }
  });

  app.post("/crypto/withdrawals/:withdrawalId/authorize", async (request, reply) => {
    if (!authorizeAdmin(request, deps)) {
      return reply.code(403).send({ error: "forbidden", message: "Admin token required." });
    }

    const body = authorizeSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid authorization payload." });
    }

    try {
      const params = request.params as { withdrawalId: string };
      const updated = await service.authorizeWithdrawal(
        params.withdrawalId,
        body.data.actorId
      );
      return { withdrawal: serializeWithdrawal(updated) };
    } catch (error) {
      return handleCryptoError(reply, error);
    }
  });

  app.get("/crypto/withdrawals/:withdrawalId", async (request, reply) => {
    if (!authorizeAdmin(request, deps)) {
      return reply.code(403).send({ error: "forbidden", message: "Admin token required." });
    }

    try {
      const params = request.params as { withdrawalId: string };
      const withdrawal = await service.getWithdrawal(params.withdrawalId);
      return { withdrawal: serializeWithdrawal(withdrawal) };
    } catch (error) {
      return handleCryptoError(reply, error);
    }
  });

  app.post("/crypto/withdrawals/allowlist", async (request, reply) => {
    if (!authorizeAdmin(request, deps)) {
      return reply.code(403).send({ error: "forbidden", message: "Admin token required." });
    }

    const body = allowlistSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid allowlist payload." });
    }

    try {
      const entry = await service.addAllowlistEntry(body.data);
      return { allowlist: serializeAllowlist(entry) };
    } catch (error) {
      return handleCryptoError(reply, error);
    }
  });
}

function authorizeAdmin(request: FastifyRequest, deps: ServiceDependencies): boolean {
  const token = deps.config.crypto.adminToken;
  if (!token) {
    return false;
  }
  const header = request.headers["x-admin-token"];
  const candidate = Array.isArray(header) ? header[0] : header;
  if (!candidate) {
    return false;
  }
  if (token.length !== candidate.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(token), Buffer.from(candidate));
}

function serializeWithdrawal(withdrawal: { _id: { toHexString: () => string } } & Record<string, unknown>) {
  return {
    ...withdrawal,
    _id: withdrawal._id.toHexString()
  };
}

function serializeAllowlist(entry: { _id: { toHexString: () => string } } & Record<string, unknown>) {
  return {
    ...entry,
    _id: entry._id.toHexString()
  };
}

function handleCryptoError(reply: FastifyReply, error: unknown) {
  if (error instanceof CryptoGatewayError) {
    return reply.code(error.status).send({ error: error.code, message: error.message });
  }

  if (error instanceof LedgerError) {
    return reply.code(error.status).send({ error: error.code, message: error.message });
  }

  if (error instanceof Error) {
    return reply.code(500).send({ error: "internal_error", message: error.message });
  }

  return reply.code(500).send({ error: "internal_error", message: "Unknown error." });
}
