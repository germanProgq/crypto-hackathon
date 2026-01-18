// Purpose: build deterministic Merkle roots for bid proofs.
import { createHash } from "node:crypto";
import { canonicalize } from "./canonicalize.js";

type MerkleResult = {
  root: string;
  leaves: string[];
};

export function buildMerkleRootFromPayloads(payloads: unknown[]): MerkleResult {
  const leaves = payloads.map((payload) => hashLeaf(payload));
  return { root: buildMerkleRoot(leaves), leaves };
}

export function buildMerkleRoot(leaves: string[]): string {
  if (leaves.length === 0) {
    return hashBytes(Buffer.from(""));
  }

  let level = leaves.map((leaf) => normalizeHex(leaf));
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      if (!left) {
        continue;
      }
      const right = level[index + 1] ?? left;
      next.push(hashPair(left, right));
    }
    level = next;
  }
  return level[0] ?? hashBytes(Buffer.from(""));
}

export function hashLeaf(payload: unknown): string {
  const data = `leaf:${canonicalize(payload)}`;
  return hashBytes(Buffer.from(data, "utf8"));
}

function hashPair(left: string, right: string): string {
  const leftBytes = Buffer.from(normalizeHex(left), "hex");
  const rightBytes = Buffer.from(normalizeHex(right), "hex");
  return hashBytes(Buffer.concat([leftBytes, rightBytes]));
}

function hashBytes(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function normalizeHex(value: string): string {
  return value.toLowerCase().replace(/^0x/, "");
}
