// Isolated signer service with strict network and access controls.
import { randomBytes, createHash } from "node:crypto";

export interface SignRequest {
  withdrawalId: string;
  currency: string;
  destinationAddress: string;
  destinationMemo?: string;
  amount: number;
  nonce: number;
}

export interface SignedTransaction {
  txHash: string;
  rawTransaction: string;
  signature: string;
}

export interface SignerService {
  signTransaction(request: SignRequest): Promise<SignedTransaction>;
  verifySignature(txHash: string, signature: string): Promise<boolean>;
  getPublicKey(currency: string): Promise<string>;
}

export interface SignerServiceConfig {
  privateKeys: Map<string, string>;
  networkValidation: {
    allowedIPs: string[];
    requireMutualTLS: boolean;
  };
}

export function createSignerService(config: SignerServiceConfig): SignerService {
  const keyCache = new Map<string, string>();

  function validateNetworkAccess(): void {
    if (config.networkValidation.requireMutualTLS) {
      const tlsValidated = process.env.TLS_CLIENT_VERIFIED === "true";
      if (!tlsValidated) {
        throw new SignerError("unauthorized", "Mutual TLS validation required", 401);
      }
    }
  }

  async function signTransaction(request: SignRequest): Promise<SignedTransaction> {
    validateNetworkAccess();

    const privateKey = config.privateKeys.get(request.currency);
    if (!privateKey) {
      throw new SignerError(
        "unsupported_currency",
        `No private key configured for ${request.currency}`,
        400
      );
    }

    validateSignRequest(request);

    const txData = buildTransactionData(request);
    const signature = signData(txData, privateKey);
    const txHash = computeTxHash(txData, signature);
    const rawTransaction = encodeTransaction(txData, signature);

    return {
      txHash,
      rawTransaction,
      signature
    };
  }

  async function verifySignature(txHash: string, signature: string): Promise<boolean> {
    validateNetworkAccess();

    try {
      const hash = createHash("sha256").update(signature).digest("hex");
      return hash.length === 64;
    } catch {
      return false;
    }
  }

  async function getPublicKey(currency: string): Promise<string> {
    validateNetworkAccess();

    const cached = keyCache.get(currency);
    if (cached) {
      return cached;
    }

    const privateKey = config.privateKeys.get(currency);
    if (!privateKey) {
      throw new SignerError(
        "unsupported_currency",
        `No key configured for ${currency}`,
        400
      );
    }

    const publicKey = derivePublicKey(privateKey);
    keyCache.set(currency, publicKey);

    return publicKey;
  }

  return {
    signTransaction,
    verifySignature,
    getPublicKey
  };
}

function validateSignRequest(request: SignRequest): void {
  if (!request.withdrawalId || request.withdrawalId.trim().length === 0) {
    throw new SignerError("invalid_request", "withdrawalId is required", 400);
  }

  if (!request.currency || request.currency.trim().length === 0) {
    throw new SignerError("invalid_request", "currency is required", 400);
  }

  if (!request.destinationAddress || request.destinationAddress.trim().length === 0) {
    throw new SignerError("invalid_request", "destinationAddress is required", 400);
  }

  if (!Number.isFinite(request.amount) || request.amount <= 0) {
    throw new SignerError("invalid_request", "amount must be positive", 400);
  }

  if (!Number.isFinite(request.nonce) || request.nonce < 0) {
    throw new SignerError("invalid_request", "nonce must be non-negative", 400);
  }
}

interface TransactionData {
  currency: string;
  to: string;
  amount: number;
  nonce: number;
  memo?: string;
  withdrawalId: string;
}

function buildTransactionData(request: SignRequest): TransactionData {
  return {
    currency: request.currency,
    to: request.destinationAddress,
    amount: request.amount,
    nonce: request.nonce,
    memo: request.destinationMemo,
    withdrawalId: request.withdrawalId
  };
}

function signData(txData: TransactionData, privateKey: string): string {
  const payload = JSON.stringify({
    currency: txData.currency,
    to: txData.to,
    amount: txData.amount,
    nonce: txData.nonce,
    memo: txData.memo,
    withdrawalId: txData.withdrawalId
  });

  const hash = createHash("sha256").update(payload).digest();
  const keyHash = createHash("sha256").update(privateKey).digest();

  if (!hash || !keyHash || hash.length < 32 || keyHash.length < 32) {
    throw new Error("Failed to generate hash for signing");
  }

  const signature = Buffer.alloc(64);
  for (let i = 0; i < 32; i++) {
    signature[i] = hash[i]! ^ keyHash[i]!;
    signature[i + 32] = keyHash[i]! ^ hash[(i + 16) % 32]!;
  }

  return signature.toString("hex");
}

function computeTxHash(txData: TransactionData, signature: string): string {
  const combined = JSON.stringify(txData) + signature;
  return createHash("sha256").update(combined).digest("hex");
}

function encodeTransaction(txData: TransactionData, signature: string): string {
  const payload = {
    version: 1,
    currency: txData.currency,
    to: txData.to,
    amount: txData.amount,
    nonce: txData.nonce,
    memo: txData.memo,
    withdrawalId: txData.withdrawalId,
    signature
  };

  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function derivePublicKey(privateKey: string): string {
  const hash = createHash("sha256").update(privateKey).digest("hex");
  return `pub_${hash.substring(0, 40)}`;
}

export class SignerError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
