// Auction creation helpers for consistent document shaping.
import { ObjectId, type WithId } from "mongodb";
import type {
  AuctionDocument,
  AuctionRoundConfig
} from "../../shared/storage/mongoSchemas.js";
import type { AuctionConfig } from "./auctionConfig.js";

export function buildAuctionDocument(
  config: AuctionConfig,
  supportedCurrencies: string[]
): WithId<AuctionDocument> {
  const title = normalizeRequiredText(config.title, "title");
  const currency = normalizeCurrency(config.currency, supportedCurrencies);
  const description = normalizeOptionalText(config.description);
  const deliveryType = config.deliveryType;
  const rounds = normalizeRounds(config.rounds);
  const pricingMode = config.pricingMode;
  const minBid = normalizeNonNegative(config.minBid);
  const minIncrement = normalizeNonNegative(config.minIncrement);
  const firstRound = rounds[0] ?? null;
  const now = new Date();

  const auction: WithId<AuctionDocument> = {
    _id: new ObjectId(),
    title,
    status: "draft",
    currency,
    pricingMode,
    minBid,
    minIncrement,
    deliveryType,
    startsAt: config.startsAt,
    endsAt: config.endsAt,
    rounds,
    currentRoundIndex: firstRound?.index ?? null,
    roundStatus: firstRound ? "scheduled" : null,
    roundEffectiveEndAt: firstRound?.endAt ?? null,
    roundLastBidAt: null,
    lastBidAmount: null,
    createdAt: now,
    updatedAt: now
  };
  if (description) {
    auction.description = description;
  }
  return auction;
}

function normalizeRequiredText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} is required.`);
  }
  return trimmed;
}

function normalizeOptionalText(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeCurrency(value: string, supportedCurrencies: string[]): string {
  const normalized = value.trim().toUpperCase();
  if (!supportedCurrencies.includes(normalized)) {
    throw new Error("Unsupported currency.");
  }
  return normalized;
}

function normalizeRounds(rounds: AuctionRoundConfig[]): AuctionRoundConfig[] {
  return [...rounds]
    .sort((left, right) => left.index - right.index)
    .map((round) => ({
      index: round.index,
      allocationSize: round.allocationSize,
      startAt: round.startAt,
      endAt: round.endAt,
      antiSniping: {
        triggerWindowSeconds: round.antiSniping.triggerWindowSeconds,
        extensionSeconds: round.antiSniping.extensionSeconds,
        maxExtensions: round.antiSniping.maxExtensions
      }
    }));
}

function normalizeNonNegative(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value < 0 ? 0 : value;
}
