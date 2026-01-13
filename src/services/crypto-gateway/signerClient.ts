// Signer client for withdrawal payload signing.
import { z } from "zod";
import type { AppConfig } from "../../shared/config.js";
import type { SignedPayload, WithdrawalSigningPayload } from "./types.js";

const signerTimeoutMs = 8000;

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

const signerResponseSchema = z.object({
  signedPayload: signedPayloadSchema
});

export function createSignerClient(config: AppConfig["crypto"]) {
  const baseUrl = normalizeBaseUrl(config.signerUrl);
  const token = config.signerToken;

  async function signWithdrawal(payload: WithdrawalSigningPayload): Promise<SignedPayload> {
    const response = await fetchJson(`${baseUrl}/signer/sign`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signer-token": token
      },
      body: JSON.stringify(payload)
    });
    const parsed = signerResponseSchema.parse(response);
    return parsed.signedPayload;
  }

  return { signWithdrawal };
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function fetchJson(url: string, options: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), signerTimeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Signer request failed with ${response.status}.`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}
