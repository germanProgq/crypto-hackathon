// Crypto gateway HTTP routes.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DepositAddressService } from "./depositAddressService.js";
import type { DepositWatcherService, IncomingDeposit } from "./depositWatcher.js";
import type { WithdrawalService, WithdrawalRequest } from "./withdrawalService.js";

export interface CryptoGatewayDependencies {
  depositAddressService: DepositAddressService;
  depositWatcher: DepositWatcherService;
  withdrawalService: WithdrawalService;
}

const depositAddressSchema = z.object({
  userId: z.string().min(1),
  currency: z.string().min(1).max(10)
});

const incomingDepositSchema = z.object({
  txHash: z.string().min(1),
  currency: z.string().min(1).max(10),
  address: z.string().min(1),
  memo: z.string().optional(),
  amount: z.number().positive(),
  confirmations: z.number().int().min(0),
  detectedAt: z.coerce.date(),
  metadata: z.record(z.unknown()).optional()
});

const withdrawalRequestSchema = z.object({
  userId: z.string().min(1),
  currency: z.string().min(1).max(10),
  amount: z.number().positive(),
  destinationAddress: z.string().min(1),
  destinationMemo: z.string().optional(),
  idempotencyKey: z.string().min(1),
  metadata: z.record(z.unknown()).optional()
});

const updateConfirmationsSchema = z.object({
  txHash: z.string().min(1),
  currency: z.string().min(1).max(10),
  confirmations: z.number().int().min(0)
});

const authorizeWithdrawalSchema = z.object({
  withdrawalId: z.string().uuid()
});

const broadcastWithdrawalSchema = z.object({
  withdrawalId: z.string().uuid(),
  txHash: z.string().min(1)
});

const failWithdrawalSchema = z.object({
  withdrawalId: z.string().uuid(),
  reason: z.string().min(1)
});

export function registerCryptoGatewayRoutes(
  server: FastifyInstance,
  deps: CryptoGatewayDependencies
): void {
  server.post("/deposit-address", async (request, reply) => {
    const body = depositAddressSchema.parse(request.body);
    const result = await deps.depositAddressService.getOrCreateDepositAddress(
      body.userId,
      body.currency
    );
    return reply.code(200).send(result);
  });

  server.post("/deposit/incoming", async (request, reply) => {
    const body = incomingDepositSchema.parse(request.body);
    const deposit: IncomingDeposit = {
      txHash: body.txHash,
      currency: body.currency,
      address: body.address,
      memo: body.memo,
      amount: body.amount,
      confirmations: body.confirmations,
      detectedAt: body.detectedAt,
      metadata: body.metadata
    };
    await deps.depositWatcher.processIncomingDeposit(deposit);
    return reply.code(202).send({ status: "processing" });
  });

  server.post("/deposit/update-confirmations", async (request, reply) => {
    const body = updateConfirmationsSchema.parse(request.body);
    await deps.depositWatcher.updateConfirmations(body.txHash, body.currency, body.confirmations);
    return reply.code(200).send({ status: "updated" });
  });

  server.get("/deposit/pending", async (request, reply) => {
    const query = z.object({ currency: z.string().optional() }).parse(request.query);
    const deposits = await deps.depositWatcher.getPendingDeposits(query.currency);
    return reply.code(200).send({ deposits });
  });

  server.post("/withdrawal/request", async (request, reply) => {
    const body = withdrawalRequestSchema.parse(request.body);
    const withdrawalRequest: WithdrawalRequest = {
      userId: body.userId,
      currency: body.currency,
      amount: body.amount,
      destinationAddress: body.destinationAddress,
      destinationMemo: body.destinationMemo,
      idempotencyKey: body.idempotencyKey,
      metadata: body.metadata
    };
    const result = await deps.withdrawalService.requestWithdrawal(withdrawalRequest);
    return reply.code(201).send(result);
  });

  server.post("/withdrawal/authorize", async (request, reply) => {
    const body = authorizeWithdrawalSchema.parse(request.body);
    const result = await deps.withdrawalService.authorizeWithdrawal(body.withdrawalId);
    return reply.code(200).send(result);
  });

  server.post("/withdrawal/broadcast", async (request, reply) => {
    const body = broadcastWithdrawalSchema.parse(request.body);
    const result = await deps.withdrawalService.broadcastWithdrawal(
      body.withdrawalId,
      body.txHash
    );
    return reply.code(200).send(result);
  });

  server.post("/withdrawal/fail", async (request, reply) => {
    const body = failWithdrawalSchema.parse(request.body);
    const result = await deps.withdrawalService.failWithdrawal(body.withdrawalId, body.reason);
    return reply.code(200).send(result);
  });

  server.get("/withdrawal/:withdrawalId", async (request, reply) => {
    const params = z.object({ withdrawalId: z.string().uuid() }).parse(request.params);
    const withdrawal = await deps.withdrawalService.getWithdrawal(params.withdrawalId);
    if (!withdrawal) {
      return reply.code(404).send({ error: "Withdrawal not found" });
    }
    return reply.code(200).send(withdrawal);
  });

  server.get("/withdrawal/user/:userId", async (request, reply) => {
    const params = z.object({ userId: z.string().min(1) }).parse(request.params);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).parse(
      request.query
    );
    const withdrawals = await deps.withdrawalService.getUserWithdrawals(
      params.userId,
      query.limit
    );
    return reply.code(200).send({ withdrawals });
  });

  server.get("/withdrawal/pending", async (request, reply) => {
    const withdrawals = await deps.withdrawalService.getPendingWithdrawals();
    return reply.code(200).send({ withdrawals });
  });
}
