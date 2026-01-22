// ML-based anomaly detection for withdrawal security using online learning.
import type { Logger } from "pino";
import type { MongoDependencies } from "../../shared/storage/mongo.js";
import { mongoCollections } from "../../shared/storage/mongoSchemas.js";

type WithdrawalEvent = {
  userId: string;
  amount: number;
  destinationAddress: string;
  currency: string;
  timestamp: Date;
};

type WithdrawalProfile = {
  userId: string;
  currency: string;
  features: {
    avgAmount: number;
    stdAmount: number;
    avgFrequency: number;
    uniqueAddressCount: number;
    timeOfDayPattern: number[];
  };
  lastUpdated: Date;
};

type AnomalyResult = {
  isAnomaly: boolean;
  score: number;
  reasons: string[];
};

type WithdrawalHistoryEntry = {
  userId: string;
  amount: number;
  destinationAddress: string;
  timestamp: Date;
  status: string;
  currency: string;
};

const profileCacheTtl = 3600000;
const anomalyThreshold = 50;
const learningRate = 0.1;
const historyLookback = 100;

export class MLAnomalyDetector {
  private profiles = new Map<string, { profile: WithdrawalProfile; cachedAt: number }>();

  constructor(
    private readonly logger: Logger,
    private readonly mongo: MongoDependencies
  ) {}

  async detectAnomaly(withdrawal: WithdrawalEvent): Promise<AnomalyResult> {
    const profileKey = buildProfileKey(withdrawal.userId, withdrawal.currency);
    const profile = await this.getOrBuildProfile(profileKey, withdrawal.userId, withdrawal.currency);
    const reasons: string[] = [];
    let anomalyScore = 0;

    const amountZScore = computeZScore(
      withdrawal.amount,
      profile.features.avgAmount,
      profile.features.stdAmount
    );
    if (amountZScore > 3) {
      anomalyScore += 40;
      const formatted = amountZScore.toFixed(2);
      reasons.push(`amount_deviation: ${formatted}σ`);
    }

    const history = await this.getWithdrawalHistory(withdrawal.userId, withdrawal.currency);
    const knownAddresses = new Set(history.map((entry) => entry.destinationAddress));
    if (!knownAddresses.has(withdrawal.destinationAddress)) {
      anomalyScore += 25;
      reasons.push("new_destination_address");
    }

    const lastWithdrawal = history[0] ?? null;
    if (lastWithdrawal) {
      const hoursSince =
        (withdrawal.timestamp.getTime() - lastWithdrawal.timestamp.getTime()) / 3600000;
      const frequencyThreshold = profile.features.avgFrequency * 0.2;
      if (hoursSince < frequencyThreshold && profile.features.avgFrequency > 0) {
        anomalyScore += 30;
        const hoursFormatted = hoursSince.toFixed(1);
        const avgFormatted = profile.features.avgFrequency.toFixed(1);
        reasons.push(`high_frequency: ${hoursFormatted}h vs ${avgFormatted}h avg`);
      }
    }

    const hour = withdrawal.timestamp.getHours();
    const typicalHourActivity = profile.features.timeOfDayPattern[hour] ?? 0;
    if (typicalHourActivity < 0.1 && history.length > 10) {
      const mostActiveHour = profile.features.timeOfDayPattern.indexOf(
        Math.max(...profile.features.timeOfDayPattern)
      );
      anomalyScore += 15;
      reasons.push(`unusual_time: ${hour}:00 (typical: ${mostActiveHour}:00)`);
    }

    const recentCount = history.filter(
      (entry) => withdrawal.timestamp.getTime() - entry.timestamp.getTime() < 3600000
    ).length;
    if (recentCount > 3) {
      anomalyScore += 20;
      reasons.push(`rapid_succession: ${recentCount} in 1h`);
    }

    const isAnomaly = anomalyScore >= anomalyThreshold;

    this.logger.info(
      {
        userId: withdrawal.userId,
        amount: withdrawal.amount,
        currency: withdrawal.currency,
        anomalyScore,
        isAnomaly,
        reasons
      },
      "Anomaly detection completed"
    );

    void this.updateProfile(profileKey, withdrawal.userId, withdrawal.currency, withdrawal);

    return { isAnomaly, score: anomalyScore, reasons };
  }

  private async getOrBuildProfile(
    profileKey: string,
    userId: string,
    currency: string
  ): Promise<WithdrawalProfile> {
    const cached = this.profiles.get(profileKey);
    const now = Date.now();
    if (cached && now - cached.cachedAt < profileCacheTtl) {
      return cached.profile;
    }

    const history = await this.getWithdrawalHistory(userId, currency);
    const profile = buildProfileFromHistory(userId, currency, history);
    this.profiles.set(profileKey, { profile, cachedAt: now });
    return profile;
  }

  private async updateProfile(
    profileKey: string,
    _userId: string,
    _currency: string,
    withdrawal: WithdrawalEvent
  ): Promise<void> {
    try {
      const cached = this.profiles.get(profileKey);
      if (!cached) {
        return;
      }

      const profile = cached.profile;
      profile.features.avgAmount =
        profile.features.avgAmount * (1 - learningRate) + withdrawal.amount * learningRate;

      const deviation = Math.abs(withdrawal.amount - profile.features.avgAmount);
      profile.features.stdAmount =
        profile.features.stdAmount * (1 - learningRate) + deviation * learningRate;

      profile.lastUpdated = new Date();
      this.profiles.set(profileKey, { profile, cachedAt: Date.now() });
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to update anomaly profile");
    }
  }

  private async getWithdrawalHistory(
    userId: string,
    currency: string
  ): Promise<WithdrawalHistoryEntry[]> {
    try {
      const withdrawals = this.mongo.db.collection(mongoCollections.cryptoWithdrawals);
      const results = await withdrawals
        .find({ userId, currency, status: { $in: ["confirmed", "broadcasted"] } })
        .sort({ createdAt: -1 })
        .limit(historyLookback)
        .project<WithdrawalHistoryEntry>({
          userId: 1,
          amount: 1,
          destinationAddress: 1,
          timestamp: "$createdAt",
          status: 1,
          currency: 1
        })
        .toArray();

      return results.map((entry) => ({
        userId: entry.userId,
        amount: entry.amount,
        destinationAddress: entry.destinationAddress,
        timestamp: entry.timestamp ?? new Date(0),
        status: entry.status,
        currency: entry.currency
      }));
    } catch (error) {
      this.logger.warn({ err: error, userId, currency }, "Failed to load withdrawal history");
      return [];
    }
  }
}

function buildProfileKey(userId: string, currency: string): string {
  return `${userId}:${currency}`;
}

function buildProfileFromHistory(
  userId: string,
  currency: string,
  history: WithdrawalHistoryEntry[]
): WithdrawalProfile {
  const amounts = history.map((entry) => entry.amount);
  const avgAmount = amounts.length > 0 ? amounts.reduce((sum, val) => sum + val, 0) / amounts.length : 0;
  const variance =
    amounts.length > 0
      ? amounts.reduce((sum, val) => sum + Math.pow(val - avgAmount, 2), 0) / amounts.length
      : 0;
  const stdAmount = Math.sqrt(variance);

  const timestamps = history.map((entry) => entry.timestamp.getTime());
  const intervals =
    timestamps.length > 1
      ? timestamps.slice(1).map((time, index) => {
          const prev = timestamps[index];
          return prev !== undefined ? (time - prev) / 3600000 : 0;
        })
      : [];
  const avgFrequency =
    intervals.length > 0 ? intervals.reduce((sum, val) => sum + val, 0) / intervals.length : 24;

  const uniqueAddresses = new Set(history.map((entry) => entry.destinationAddress)).size;

  const timeOfDayPattern = new Array(24).fill(0);
  history.forEach((entry) => {
    const hour = entry.timestamp.getHours();
    timeOfDayPattern[hour]++;
  });
  const total = timeOfDayPattern.reduce((sum, count) => sum + count, 0) || 1;
  const normalizedPattern = timeOfDayPattern.map((count) => count / total);

  return {
    userId,
    currency,
    features: {
      avgAmount,
      stdAmount,
      avgFrequency,
      uniqueAddressCount: uniqueAddresses,
      timeOfDayPattern: normalizedPattern
    },
    lastUpdated: new Date()
  };
}

function computeZScore(value: number, mean: number, stdDev: number): number {
  if (stdDev === 0 || !Number.isFinite(stdDev)) {
    return 0;
  }
  return Math.abs((value - mean) / stdDev);
}
