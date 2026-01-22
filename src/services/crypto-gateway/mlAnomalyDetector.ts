// Withdrawal anomaly scoring for crypto gateway risk decisions.
import type { Collection } from "mongodb";
import type { Logger } from "pino";
import type { MongoDependencies } from "../../shared/storage/mongo.js";
import {
  mongoCollections,
  type CryptoWithdrawalDocument
} from "../../shared/storage/mongoSchemas.js";

export type WithdrawalAnomalyInput = {
  userId: string;
  currency: string;
  amount: number;
  destinationAddress: string;
  requestedAt: Date;
};

export type WithdrawalAnomalyResult = {
  score: number;
  reasons: string[];
  historyCount: number;
};

export type WithdrawalAnomalyConfig = {
  historyLimit: number;
  reviewThreshold: number;
  rejectThreshold: number;
};

type WithdrawalProfile = {
  userId: string;
  currency: string;
  avgAmount: number;
  stdAmount: number;
  avgFrequencyHours: number | null;
  timeOfDayPattern: number[];
  knownAddresses: Set<string>;
  lastRequestedAt: Date | null;
  historyCount: number;
  computedAt: Date;
};

const profileTtlMs = 5 * 60 * 1000;

export function createMlAnomalyDetector(
  mongo: MongoDependencies,
  config: WithdrawalAnomalyConfig,
  logger?: Logger
) {
  const withdrawals = mongo.db.collection<CryptoWithdrawalDocument>(
    mongoCollections.cryptoWithdrawals
  );
  const profiles = new Map<string, WithdrawalProfile>();

  async function evaluate(input: WithdrawalAnomalyInput): Promise<WithdrawalAnomalyResult> {
    const profile = await loadProfile(withdrawals, profiles, input, config, logger);
    if (profile.historyCount === 0) {
      return { score: 0, reasons: [], historyCount: 0 };
    }

    const reasons: string[] = [];
    let score = 0;

    const deviation = computeAmountDeviation(input.amount, profile.avgAmount, profile.stdAmount);
    if (deviation > 3) {
      score += 40;
      reasons.push(`amount_deviation:${deviation.toFixed(2)}σ`);
    }

    if (profile.knownAddresses.size > 0 && !profile.knownAddresses.has(input.destinationAddress)) {
      score += 25;
      reasons.push("new_destination");
    }

    if (profile.avgFrequencyHours !== null && profile.lastRequestedAt) {
      const hoursSince =
        (input.requestedAt.getTime() - profile.lastRequestedAt.getTime()) / 3600000;
      if (hoursSince >= 0 && hoursSince < profile.avgFrequencyHours * 0.2) {
        score += 30;
        reasons.push(`high_frequency:${hoursSince.toFixed(1)}h`);
      }
    }

    if (profile.historyCount >= 10) {
      const hour = input.requestedAt.getHours();
      const typical = profile.timeOfDayPattern[hour] ?? 0;
      if (typical < 0.08) {
        score += 15;
        reasons.push(`unusual_time:${hour}`);
      }
    }

    const recentCount = await countRecentWithdrawals(withdrawals, input.userId, input.currency);
    if (recentCount >= 3) {
      score += 20;
      reasons.push(`rapid_succession:${recentCount}`);
    }

    return { score, reasons, historyCount: profile.historyCount };
  }

  return {
    evaluate,
    reviewThreshold: config.reviewThreshold,
    rejectThreshold: config.rejectThreshold
  };
}

async function loadProfile(
  withdrawals: Collection<CryptoWithdrawalDocument>,
  profiles: Map<string, WithdrawalProfile>,
  input: WithdrawalAnomalyInput,
  config: WithdrawalAnomalyConfig,
  logger?: Logger
): Promise<WithdrawalProfile> {
  const key = `${input.userId}:${input.currency}`;
  const cached = profiles.get(key);
  if (cached && Date.now() - cached.computedAt.getTime() <= profileTtlMs) {
    return cached;
  }

  const history = await withdrawals
    .find({
      userId: input.userId,
      currency: input.currency,
      status: "confirmed"
    })
    .sort({ confirmedAt: -1, requestedAt: -1 })
    .limit(Math.max(1, Math.floor(config.historyLimit)))
    .toArray();

  const profile = buildProfile(input.userId, input.currency, history);
  profiles.set(key, profile);
  if (logger && profile.historyCount === 0) {
    logger.info(
      { userId: input.userId, currency: input.currency },
      "No withdrawal history for anomaly scoring"
    );
  }
  return profile;
}

function buildProfile(
  userId: string,
  currency: string,
  history: CryptoWithdrawalDocument[]
): WithdrawalProfile {
  const amounts = history
    .map((entry) => entry.amount)
    .filter((value) => Number.isFinite(value) && value > 0);
  const historyCount = history.length;
  const avgAmount = amounts.length > 0 ? mean(amounts) : 0;
  const stdAmount = amounts.length > 1 ? stddev(amounts, avgAmount) : 0;

  const ordered = [...history].sort((a, b) => {
    const timeA = a.requestedAt?.getTime() ?? 0;
    const timeB = b.requestedAt?.getTime() ?? 0;
    return timeB - timeA;
  });
  const timestamps = ordered
    .map((entry) => entry.requestedAt)
    .filter((value): value is Date => value instanceof Date);
  const intervals = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    const prev = timestamps[index - 1];
    const next = timestamps[index];
    if (!prev || !next) {
      continue;
    }
    intervals.push((prev.getTime() - next.getTime()) / 3600000);
  }
  const avgFrequencyHours = intervals.length > 0 ? mean(intervals) : null;

  const timeOfDayPattern = new Array(24).fill(0);
  for (const entry of history) {
    const date = entry.requestedAt ?? entry.confirmedAt;
    if (!date) {
      continue;
    }
    const hour = date.getHours();
    timeOfDayPattern[hour] += 1;
  }
  const total = timeOfDayPattern.reduce((sum, value) => sum + value, 0);
  const normalized =
    total > 0 ? timeOfDayPattern.map((value) => value / total) : timeOfDayPattern;

  const knownAddresses = new Set(
    history.map((entry) => entry.destinationAddress).filter((value) => value)
  );
  const lastRequestedAt = timestamps[0] ?? null;

  return {
    userId,
    currency,
    avgAmount,
    stdAmount,
    avgFrequencyHours,
    timeOfDayPattern: normalized,
    knownAddresses,
    lastRequestedAt,
    historyCount,
    computedAt: new Date()
  };
}

function computeAmountDeviation(amount: number, avg: number, std: number): number {
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(avg)) {
    return 0;
  }
  const sigma = std > 0 ? std : Math.max(1e-9, avg * 0.1);
  return Math.abs(amount - avg) / sigma;
}

async function countRecentWithdrawals(
  withdrawals: Collection<CryptoWithdrawalDocument>,
  userId: string,
  currency: string
): Promise<number> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  return withdrawals.countDocuments({
    userId,
    currency,
    requestedAt: { $gte: oneHourAgo },
    status: { $in: ["requested", "authorized", "broadcasted", "confirmed"] }
  });
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values: number[], avg: number): number {
  const variance =
    values.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / values.length;
  return Math.sqrt(variance);
}
