// Bid ranking member encoding for Redis sorted sets.
import type { ObjectId } from "mongodb";

const maxTimestampMs = 9_999_999_999_999;
const padLength = 13;

export function buildRankingMember(bidId: ObjectId | string, createdAt: Date): string {
  const id = typeof bidId === "string" ? bidId : bidId.toHexString();
  const inverted = Math.max(0, maxTimestampMs - createdAt.getTime());
  const padded = inverted.toString().padStart(padLength, "0");
  return `${padded}:${id}`;
}

export function parseRankingMember(member: string): { bidId: string } {
  const [, bidId = ""] = member.split(":");
  return { bidId };
}
