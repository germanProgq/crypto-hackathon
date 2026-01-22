// Auction configuration schema and timing validation.
import { z } from "zod";

export const auctionRoundConfigSchema = z
  .object({
    index: z.number().int().nonnegative(),
    allocationSize: z.number().int().positive(),
    startAt: z.coerce.date(),
    endAt: z.coerce.date(),
    antiSniping: z
      .object({
        triggerWindowSeconds: z.number().int().nonnegative(),
        extensionSeconds: z.number().int().nonnegative(),
        maxExtensions: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();

export const auctionConfigSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().optional(),
    currency: z.string().min(1),
    pricingMode: z.enum(["first-price", "cutoff"]).optional(),
    minBid: z.coerce.number().nonnegative().optional(),
    minIncrement: z.coerce.number().nonnegative().optional(),
    deliveryType: z.enum(["access_code", "telegram_role", "nft_mint"]).optional(),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    rounds: z.array(auctionRoundConfigSchema).min(1)
  })
  .strict();

export type AuctionConfig = z.infer<typeof auctionConfigSchema>;

export type AuctionTimingIssue =
  | "round_index_sequence"
  | "round_time_order"
  | "round_overlap"
  | "auction_window_mismatch"
  | "anti_sniping_rules";

export function validateAuctionTiming(config: AuctionConfig): {
  ok: boolean;
  issues: AuctionTimingIssue[];
} {
  const issues: AuctionTimingIssue[] = [];
  const rounds = [...config.rounds].sort((a, b) => a.index - b.index);

  if (rounds.length === 0) {
    issues.push("round_index_sequence");
    return { ok: false, issues };
  }

  rounds.forEach((round, index) => {
    if (round.index !== index && !issues.includes("round_index_sequence")) {
      issues.push("round_index_sequence");
    }

    if (round.startAt.getTime() >= round.endAt.getTime() && !issues.includes("round_time_order")) {
      issues.push("round_time_order");
    }

    if (
      round.antiSniping.maxExtensions > 0 &&
      (round.antiSniping.triggerWindowSeconds <= 0 ||
        round.antiSniping.extensionSeconds <= 0) &&
      !issues.includes("anti_sniping_rules")
    ) {
      issues.push("anti_sniping_rules");
    }

    if (index > 0) {
      const previous = rounds[index - 1];
      if (
        previous &&
        round.startAt.getTime() < previous.endAt.getTime() &&
        !issues.includes("round_overlap")
      ) {
        issues.push("round_overlap");
      }
    }
  });

  const firstRound = rounds[0];
  const lastRound = rounds[rounds.length - 1];
  if (
    firstRound &&
    lastRound &&
    (config.startsAt.getTime() !== firstRound.startAt.getTime() ||
      config.endsAt.getTime() !== lastRound.endAt.getTime())
  ) {
    issues.push("auction_window_mismatch");
  }

  return { ok: issues.length === 0, issues };
}

export function parseAuctionConfig(
  input: unknown,
  defaults?: {
    pricingMode?: "first-price" | "cutoff";
    minBid?: number;
    minIncrement?: number;
  }
): AuctionConfig {
  const parsed = auctionConfigSchema.parse(input);
  const resolved: AuctionConfig = {
    ...parsed,
    pricingMode: parsed.pricingMode ?? defaults?.pricingMode ?? "first-price",
    minBid: normalizeNonNegative(parsed.minBid ?? defaults?.minBid ?? 0),
    minIncrement: normalizeNonNegative(parsed.minIncrement ?? defaults?.minIncrement ?? 0)
  };

  const timing = validateAuctionTiming(resolved);
  if (!timing.ok) {
    throw new Error(`Invalid auction timing: ${timing.issues.join(", ")}`);
  }
  return resolved;
}

function normalizeNonNegative(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value < 0 ? 0 : value;
}
