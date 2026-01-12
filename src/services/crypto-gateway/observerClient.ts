// Observer client for deposit and withdrawal transaction data.
import { z } from "zod";
import type { AppConfig } from "../../shared/config.js";
import type { ObserverTransaction, ObserverTransactionsResponse, SignedPayload } from "./types.js";

const observerTimeoutMs = 8000;

const rawTransactionSchema = z.object({
  txId: z.string().min(1),
  currency: z.string().min(1),
  address: z.string().min(1),
  memo: z.string().min(1).optional(),
  amount: z.number().positive().finite(),
  confirmations: z.number().int().nonnegative(),
  observedAt: z.string().min(1),
  blockHeight: z.number().int().nonnegative().optional()
});

const transactionsResponseSchema = z.object({
  nextCursor: z.string().nullable().optional(),
  transactions: z.array(rawTransactionSchema)
});

const broadcastResponseSchema = z.object({
  txId: z.string().min(1)
});

export interface ObserverClientOptions {
  baseUrl: string;
}

export function createObserverClient(config: AppConfig["crypto"]) {
  const baseUrl = normalizeBaseUrl(config.observerUrl);

  async function listTransactions(options: {
    currency: string;
    addresses: string[];
    after?: string | null;
    limit?: number;
  }): Promise<ObserverTransactionsResponse> {
    const params = new URLSearchParams();
    params.set("currency", options.currency);
    if (options.after) {
      params.set("after", options.after);
    }
    if (options.addresses.length > 0) {
      params.set("addresses", options.addresses.join(","));
    }
    if (options.limit) {
      params.set("limit", options.limit.toString());
    }

    const response = await fetchJson(
      `${baseUrl}/observer/transactions?${params.toString()}`
    );
    const parsed = transactionsResponseSchema.parse(response);
    return {
      nextCursor: parsed.nextCursor ?? null,
      transactions: parsed.transactions.map(toObserverTransaction)
    };
  }

  async function getTransaction(
    currency: string,
    txId: string
  ): Promise<ObserverTransaction | null> {
    const response = await fetchJson(
      `${baseUrl}/observer/transactions/${encodeURIComponent(txId)}?currency=${encodeURIComponent(
        currency
      )}`,
      { allowNotFound: true }
    );
    if (response === null) {
      return null;
    }
    return toObserverTransaction(rawTransactionSchema.parse(response));
  }

  async function broadcastTransaction(
    currency: string,
    signedPayload: SignedPayload,
    clientReference?: string
  ): Promise<{ txId: string }> {
    const response = await fetchJson(`${baseUrl}/observer/transactions/broadcast`, {
      method: "POST",
      body: JSON.stringify({ currency, signedPayload, clientReference }),
      headers: { "content-type": "application/json" }
    });
    return broadcastResponseSchema.parse(response);
  }

  return {
    listTransactions,
    getTransaction,
    broadcastTransaction
  };
}

function toObserverTransaction(raw: z.infer<typeof rawTransactionSchema>): ObserverTransaction {
  const observedAt = new Date(raw.observedAt);
  if (Number.isNaN(observedAt.getTime())) {
    throw new Error("Invalid observedAt in observer response.");
  }
  return {
    txId: raw.txId,
    currency: raw.currency.trim().toUpperCase(),
    address: raw.address,
    memo: raw.memo,
    amount: raw.amount,
    confirmations: raw.confirmations,
    observedAt,
    blockHeight: raw.blockHeight
  };
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function fetchJson(
  url: string,
  options: RequestInit & { allowNotFound?: boolean } = {}
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), observerTimeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    if (options.allowNotFound && response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Observer request failed with ${response.status}.`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}
