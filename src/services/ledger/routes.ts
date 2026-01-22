// Ledger HTTP routes and request validation.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ServiceDependencies } from "../../shared/service.js";
import {
  LedgerError,
  createLedgerRepository,
  type LedgerEntryInput,
  type LedgerHistoryOptions,
  type HoldOperationInput,
  type WithdrawalOperationInput
} from "./ledgerStore.js";
import {
  requireCoreAuth,
  requireServiceAuth,
  resolveUserIdFromAuth
} from "../../shared/auth/coreAuth.js";
import { registerOpenAPI } from "../../shared/openapi/spec.js";

const auditSchema = z
  .object({
    requestId: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    ip: z.string().min(1).optional(),
    userAgent: z.string().min(1).optional(),
    actorId: z.string().min(1).optional()
  })
  .strict();

const baseBodySchema = z.object({
  userId: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().min(1),
  idempotencyKey: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  audit: auditSchema.optional()
});

const holdBodySchema = baseBodySchema.extend({
  holdId: z.string().min(1)
});

const withdrawalBodySchema = baseBodySchema.extend({
  withdrawalId: z.string().min(1)
});

const entryBodySchema = baseBodySchema.extend({
  entryType: z.enum([
    "deposit_confirmed",
    "withdrawal_requested",
    "withdrawal_broadcasted",
    "withdrawal_confirmed",
    "withdrawal_failed"
  ]),
  withdrawalId: z.string().min(1).optional()
});

const balanceQuerySchema = z.object({
  currency: z.string().min(1)
});

const historyQuerySchema = z.object({
  currency: z.string().min(1),
  limit: z.string().optional(),
  before: z.string().optional()
});

export async function registerLedgerRoutes(
  app: FastifyInstance,
  deps: ServiceDependencies
): Promise<void> {
  // Register OpenAPI/Swagger documentation
  await registerOpenAPI(app);

  const ledger = createLedgerRepository(deps.mongo, {
    retentionDays: deps.config.dataRetention.ledgerDays,
    redis: deps.redis,
    logger: deps.logger
  });

  app.get("/ledger/:userId/balance", async (request, reply) => {
    const auth = requireCoreAuth(request, reply, deps);
    if (!auth) {
      return;
    }
    const query = balanceQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "invalid_request", message: "currency is required." });
    }

    try {
      const params = request.params as { userId: string };
      const userId = resolveUserIdFromAuth(auth, params.userId, reply);
      if (!userId) {
        return;
      }
      const balance = await ledger.getBalance(userId, query.data.currency);
      return balance;
    } catch (error) {
      return handleLedgerError(reply, error);
    }
  });

  app.get("/ledger/:userId/history", async (request, reply) => {
    const auth = requireCoreAuth(request, reply, deps);
    if (!auth) {
      return;
    }
    const query = historyQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid history query." });
    }

    const options: LedgerHistoryOptions = {
      limit: parseLimit(query.data.limit),
      before: parseDate(query.data.before)
    };

    if (query.data.before && !options.before) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid before value." });
    }

    try {
      const params = request.params as { userId: string };
      const userId = resolveUserIdFromAuth(auth, params.userId, reply);
      if (!userId) {
        return;
      }
      const entries = await ledger.getHistory(
        userId,
        query.data.currency,
        options
      );
      return entries.map((entry) => ({
        ...entry,
        _id: entry._id.toHexString()
      }));
    } catch (error) {
      return handleLedgerError(reply, error);
    }
  });

  app.get("/ledger/:userId/reconcile", async (request, reply) => {
    const auth = requireCoreAuth(request, reply, deps);
    if (!auth) {
      return;
    }
    const query = balanceQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "invalid_request", message: "currency is required." });
    }

    try {
      const params = request.params as { userId: string };
      const userId = resolveUserIdFromAuth(auth, params.userId, reply);
      if (!userId) {
        return;
      }
      return await ledger.reconcile(userId, query.data.currency);
    } catch (error) {
      return handleLedgerError(reply, error);
    }
  });

  app.post("/ledger/entries", async (request, reply) => {
    if (!requireServiceAuth(request, reply, deps)) {
      return;
    }
    const body = entryBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid entry payload." });
    }

    try {
      const metadata = body.data.metadata ? { ...body.data.metadata } : undefined;
      const payload: LedgerEntryInput = {
        userId: body.data.userId,
        amount: body.data.amount,
        currency: body.data.currency,
        idempotencyKey: body.data.idempotencyKey,
        entryType: body.data.entryType,
        metadata: body.data.withdrawalId ? { ...(metadata ?? {}), withdrawalId: body.data.withdrawalId } : metadata,
        audit: body.data.audit
      };
      const result = await ledger.createEntry(payload);
      return result;
    } catch (error) {
      return handleLedgerError(reply, error);
    }
  });

  app.post("/ledger/holds", async (request, reply) => {
    if (!requireServiceAuth(request, reply, deps)) {
      return;
    }
    const body = holdBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid hold payload." });
    }

    try {
      const result = await ledger.createHold(body.data as HoldOperationInput);
      return result;
    } catch (error) {
      return handleLedgerError(reply, error);
    }
  });

  app.post("/ledger/holds/release", async (request, reply) => {
    if (!requireServiceAuth(request, reply, deps)) {
      return;
    }
    const body = holdBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid hold payload." });
    }

    try {
      const result = await ledger.releaseHold(body.data as HoldOperationInput);
      return result;
    } catch (error) {
      return handleLedgerError(reply, error);
    }
  });

  app.post("/ledger/holds/capture", async (request, reply) => {
    if (!requireServiceAuth(request, reply, deps)) {
      return;
    }
    const body = holdBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid hold payload." });
    }

    try {
      const result = await ledger.captureHold(body.data as HoldOperationInput);
      return result;
    } catch (error) {
      return handleLedgerError(reply, error);
    }
  });

  app.post("/ledger/withdrawals/request", async (request, reply) => {
    if (!requireServiceAuth(request, reply, deps)) {
      return;
    }
    const body = withdrawalBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid withdrawal payload." });
    }

    try {
      const result = await ledger.requestWithdrawal(body.data as WithdrawalOperationInput);
      return result;
    } catch (error) {
      return handleLedgerError(reply, error);
    }
  });

  app.post("/ledger/withdrawals/broadcast", async (request, reply) => {
    if (!requireServiceAuth(request, reply, deps)) {
      return;
    }
    const body = withdrawalBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid withdrawal payload." });
    }

    try {
      const entry = await ledger.broadcastWithdrawal(body.data as WithdrawalOperationInput);
      return { entry };
    } catch (error) {
      return handleLedgerError(reply, error);
    }
  });

  app.post("/ledger/withdrawals/confirm", async (request, reply) => {
    if (!requireServiceAuth(request, reply, deps)) {
      return;
    }
    const body = withdrawalBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid withdrawal payload." });
    }

    try {
      const result = await ledger.confirmWithdrawal(body.data as WithdrawalOperationInput);
      return result;
    } catch (error) {
      return handleLedgerError(reply, error);
    }
  });

  app.post("/ledger/withdrawals/fail", async (request, reply) => {
    if (!requireServiceAuth(request, reply, deps)) {
      return;
    }
    const body = withdrawalBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", message: "Invalid withdrawal payload." });
    }

    try {
      const result = await ledger.failWithdrawal(body.data as WithdrawalOperationInput);
      return result;
    } catch (error) {
      return handleLedgerError(reply, error);
    }
  });
}

function handleLedgerError(reply: FastifyReply, error: unknown) {
  if (error instanceof LedgerError) {
    return reply.code(error.status).send({ error: error.code, message: error.message });
  }

  if (error instanceof Error) {
    return reply.code(500).send({ error: "internal_error", message: error.message });
  }

  return reply.code(500).send({ error: "internal_error", message: "Unknown error." });
}

function parseLimit(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return parsed;
}

function parseDate(value?: string): Date | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return parsed;
}
