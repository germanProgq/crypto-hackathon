// Purpose: shared types for round proof signing and verification.

export type RoundProofPayload = {
  auctionId: string;
  roundIndex: number;
  allocationSize: number;
  roundStartAt: string;
  roundEndAt: string;
  effectiveEndAt?: string | null;
  extensionCount?: number | null;
  antiSniping: {
    triggerWindowSeconds: number;
    extensionSeconds: number;
    maxExtensions: number;
  };
  bidsRoot: string;
  bidsCount: number;
  winners: Array<{
    userId: string;
    bidId: string;
    amount: number;
    rank: number;
  }>;
  finalizedAt: string;
};

export type SignedRoundProof = {
  payload: RoundProofPayload;
  signature: string;
  publicKey: string;
  algorithm: "ed25519";
  signedAt: string;
  cosignatures?: Array<{
    signature: string;
    publicKey: string;
    algorithm: "ed25519";
  }>;
};
