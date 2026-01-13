// Shared crypto gateway types for observer and signer payloads.
export interface ObserverTransaction {
  txId: string;
  currency: string;
  address: string;
  memo?: string;
  amount: number;
  confirmations: number;
  observedAt: Date;
  blockHeight?: number;
}

export interface ObserverTransactionsResponse {
  nextCursor: string | null;
  transactions: ObserverTransaction[];
}

export interface WithdrawalSigningPayload {
  withdrawalId: string;
  currency: string;
  amount: number;
  fromAddress: string;
  toAddress: string;
  requestedAt: string;
  memo?: string;
}

export interface SignedPayload {
  payload: WithdrawalSigningPayload;
  signature: string;
  publicKey: string;
  algorithm: "ed25519";
  signedAt: string;
  cosignatures?: Array<{
    signature: string;
    publicKey: string;
    algorithm: "ed25519";
  }>;
}
