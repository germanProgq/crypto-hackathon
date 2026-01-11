// Withdrawal safety controls: cooldowns, thresholds, allowlists, and anomaly detection.
import type { Collection } from "mongodb";
import type { MongoDependencies } from "../../shared/storage/mongo.js";
import {
  mongoCollections,
  type WithdrawalRequestDocument
} from "../../shared/storage/mongoSchemas.js";
import type {
  WithdrawalRequest,
  WithdrawalSafetyChecks,
  WithdrawalSafetyValidator
} from "./withdrawalService.js";

export interface SafetyValidatorConfig {
  cooldownSeconds: number;
  dailyLimitUSD: number;
  minAmount: Record<string, number>;
  addressAllowlist?: Map<string, Set<string>>;
  anomalyThresholds: {
    maxWithdrawalsPerHour: number;
    maxWithdrawalAmountMultiplier: number;
  };
}

export function createWithdrawalSafetyValidator(
  mongo: MongoDependencies,
  config: SafetyValidatorConfig
): WithdrawalSafetyValidator {
  const collection = mongo.db.collection<WithdrawalRequestDocument>(
    mongoCollections.withdrawalRequests
  );

  async function validateWithdrawal(
    request: WithdrawalRequest
  ): Promise<{ valid: boolean; checks: WithdrawalSafetyChecks }> {
    const checks: WithdrawalSafetyChecks = {
      addressAllowlisted: true,
      underDailyLimit: true,
      cooldownPassed: true,
      anomalyDetected: false,
      anomalyReasons: []
    };

    checks.addressAllowlisted = validateAddressAllowlist(request, config);

    const cooldownCheck = await validateCooldown(request, config, collection);
    checks.cooldownPassed = cooldownCheck;

    const dailyLimitCheck = await validateDailyLimit(request, config, collection);
    checks.underDailyLimit = dailyLimitCheck;

    const anomalyCheck = await detectAnomalies(request, config, collection);
    checks.anomalyDetected = anomalyCheck.detected;
    checks.anomalyReasons = anomalyCheck.reasons;

    const minAmount = config.minAmount[request.currency];
    if (minAmount !== undefined && request.amount < minAmount) {
      checks.anomalyDetected = true;
      checks.anomalyReasons?.push(`Amount below minimum: ${minAmount}`);
    }

    const valid =
      checks.addressAllowlisted &&
      checks.underDailyLimit &&
      checks.cooldownPassed &&
      !checks.anomalyDetected;

    return { valid, checks };
  }

  return { validateWithdrawal };
}

function validateAddressAllowlist(
  request: WithdrawalRequest,
  config: SafetyValidatorConfig
): boolean {
  if (!config.addressAllowlist) {
    return true;
  }

  const userAllowlist = config.addressAllowlist.get(request.userId);
  if (!userAllowlist) {
    return false;
  }

  return userAllowlist.has(request.destinationAddress);
}

async function validateCooldown(
  request: WithdrawalRequest,
  config: SafetyValidatorConfig,
  collection: Collection<WithdrawalRequestDocument>
): Promise<boolean> {
  if (config.cooldownSeconds === 0) {
    return true;
  }

  const cooldownThreshold = new Date(Date.now() - config.cooldownSeconds * 1000);

  const recentWithdrawal = await collection.findOne(
    {
      userId: request.userId,
      currency: request.currency,
      status: { $in: ["requested", "authorized", "broadcasted", "confirmed"] },
      requestedAt: { $gte: cooldownThreshold }
    },
    { sort: { requestedAt: -1 } }
  );

  return !recentWithdrawal;
}

async function validateDailyLimit(
  request: WithdrawalRequest,
  config: SafetyValidatorConfig,
  collection: Collection<WithdrawalRequestDocument>
): Promise<boolean> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const recentWithdrawals = await collection
    .find({
      userId: request.userId,
      status: { $in: ["requested", "authorized", "broadcasted", "confirmed"] },
      requestedAt: { $gte: oneDayAgo }
    })
    .toArray();

  const totalUSD = recentWithdrawals.reduce((sum, w) => {
    const usdValue = estimateUSDValue(w.amount, w.currency);
    return sum + usdValue;
  }, 0);

  const requestUSD = estimateUSDValue(request.amount, request.currency);
  const projectedTotal = totalUSD + requestUSD;

  return projectedTotal <= config.dailyLimitUSD;
}

async function detectAnomalies(
  request: WithdrawalRequest,
  config: SafetyValidatorConfig,
  collection: Collection<WithdrawalRequestDocument>
): Promise<{ detected: boolean; reasons: string[] }> {
  const reasons: string[] = [];

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recentCount = await collection.countDocuments({
    userId: request.userId,
    requestedAt: { $gte: oneHourAgo }
  });

  if (recentCount >= config.anomalyThresholds.maxWithdrawalsPerHour) {
    reasons.push(`Too many withdrawals in the last hour: ${recentCount}`);
  }

  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const historicalWithdrawals = await collection
    .find({
      userId: request.userId,
      currency: request.currency,
      status: "confirmed",
      requestedAt: { $gte: oneWeekAgo }
    })
    .toArray();

  if (historicalWithdrawals.length > 0) {
    const avgAmount =
      historicalWithdrawals.reduce((sum, w) => sum + w.amount, 0) / historicalWithdrawals.length;
    const threshold = avgAmount * config.anomalyThresholds.maxWithdrawalAmountMultiplier;

    if (request.amount > threshold) {
      reasons.push(
        `Amount significantly higher than average: ${request.amount} vs avg ${avgAmount.toFixed(2)}`
      );
    }
  }

  const uniqueAddresses = new Set(
    await collection
      .find({
        userId: request.userId,
        requestedAt: { $gte: oneHourAgo }
      })
      .toArray()
      .then((withdrawals) => withdrawals.map((w) => w.destinationAddress))
  );

  if (uniqueAddresses.size > 3) {
    reasons.push(`Multiple destination addresses in short period: ${uniqueAddresses.size}`);
  }

  return {
    detected: reasons.length > 0,
    reasons
  };
}

function estimateUSDValue(amount: number, currency: string): number {
  const rates: Record<string, number> = {
    BTC: 50000,
    ETH: 3000,
    USDT: 1,
    USDC: 1
  };

  return amount * (rates[currency] ?? 0);
}
