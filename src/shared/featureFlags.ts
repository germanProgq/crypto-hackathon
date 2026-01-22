// Feature flags system for gradual rollout and A/B testing
import type { Redis } from "ioredis";

export interface FeatureFlags {
  // Performance features
  fastBidPath: boolean;           // Redis Lua script for high-throughput bids
  wsTurboMode: boolean;           // WebSocket direct bid path (30K+ RPS)
  redisLeaderboardCache: boolean; // Redis sorted sets for ranking
  
  // Business features
  cutoffPricing: boolean;         // Vickrey-style cutoff pricing
  proxyBidding: boolean;          // Auto-increment bidding (max amount)
  antiSniping: boolean;           // Round extension on late bids
  
  // Security features
  mlAnomalyDetection: boolean;    // ML-based fraud detection
  withdrawalAllowlist: boolean;   // Require address whitelisting
  twoFactorWithdrawal: boolean;   // 2FA for large withdrawals
  
  // Integrations
  webhookNotifications: boolean;  // Webhook event delivery
  graphqlApi: boolean;            // GraphQL endpoint
  telegramBot: boolean;           // Telegram bot integration
  
  // Experimental
  experimentalFeatures: boolean;  // Enable all experimental features
  debugMode: boolean;             // Enhanced logging and diagnostics
}

const DEFAULT_FLAGS: FeatureFlags = {
  // Performance - all enabled by default
  fastBidPath: true,
  wsTurboMode: true,
  redisLeaderboardCache: true,
  
  // Business - all enabled by default
  cutoffPricing: true,
  proxyBidding: true,
  antiSniping: true,
  
  // Security - all enabled by default
  mlAnomalyDetection: true,
  withdrawalAllowlist: true,
  twoFactorWithdrawal: false,
  
  // Integrations - selective
  webhookNotifications: true,
  graphqlApi: false,
  telegramBot: true,
  
  // Experimental - off by default
  experimentalFeatures: false,
  debugMode: false
};

type FlagKey = keyof FeatureFlags;
type FlagOverrides = Partial<Record<FlagKey, boolean>>;

export interface FeatureFlagService {
  getFlags(userId?: string): Promise<FeatureFlags>;
  getFlag(flag: FlagKey, userId?: string): Promise<boolean>;
  setGlobalFlag(flag: FlagKey, value: boolean): Promise<void>;
  setUserFlag(userId: string, flag: FlagKey, value: boolean): Promise<void>;
  removeUserFlag(userId: string, flag: FlagKey): Promise<void>;
  setPercentageRollout(flag: FlagKey, percentage: number): Promise<void>;
  getAllOverrides(): Promise<{ global: FlagOverrides; rollouts: Record<FlagKey, number> }>;
}

const GLOBAL_FLAGS_KEY = "flags:global";
const USER_FLAGS_PREFIX = "flags:user:";
const ROLLOUT_FLAGS_KEY = "flags:rollout";

export function createFeatureFlagService(redis: Redis): FeatureFlagService {
  return {
    async getFlags(userId?: string): Promise<FeatureFlags> {
      const [globalOverrides, userOverrides, rollouts] = await Promise.all([
        getGlobalOverrides(),
        userId ? getUserOverrides(userId) : Promise.resolve({}),
        getRolloutConfig()
      ]);

      const flags = { ...DEFAULT_FLAGS };

      // Apply global overrides
      for (const [key, value] of Object.entries(globalOverrides)) {
        if (key in flags) {
          flags[key as FlagKey] = value;
        }
      }

      // Apply percentage rollouts
      if (userId) {
        for (const [key, percentage] of Object.entries(rollouts)) {
          if (key in flags && percentage > 0 && percentage < 100) {
            const hash = simpleHash(userId + key);
            flags[key as FlagKey] = (hash % 100) < percentage;
          }
        }
      }

      // Apply user-specific overrides (highest priority)
      for (const [key, value] of Object.entries(userOverrides)) {
        if (key in flags && typeof value === "boolean") {
          flags[key as FlagKey] = value;
        }
      }

      return flags;
    },

    async getFlag(flag: FlagKey, userId?: string): Promise<boolean> {
      const flags = await this.getFlags(userId);
      return flags[flag];
    },

    async setGlobalFlag(flag: FlagKey, value: boolean): Promise<void> {
      await redis.hset(GLOBAL_FLAGS_KEY, flag, value ? "1" : "0");
    },

    async setUserFlag(userId: string, flag: FlagKey, value: boolean): Promise<void> {
      await redis.hset(`${USER_FLAGS_PREFIX}${userId}`, flag, value ? "1" : "0");
    },

    async removeUserFlag(userId: string, flag: FlagKey): Promise<void> {
      await redis.hdel(`${USER_FLAGS_PREFIX}${userId}`, flag);
    },

    async setPercentageRollout(flag: FlagKey, percentage: number): Promise<void> {
      if (percentage < 0 || percentage > 100) {
        throw new Error("Percentage must be between 0 and 100");
      }
      await redis.hset(ROLLOUT_FLAGS_KEY, flag, percentage.toString());
    },

    async getAllOverrides(): Promise<{ global: FlagOverrides; rollouts: Record<FlagKey, number> }> {
      const [globalRaw, rolloutsRaw] = await Promise.all([
        redis.hgetall(GLOBAL_FLAGS_KEY),
        redis.hgetall(ROLLOUT_FLAGS_KEY)
      ]);

      const global: FlagOverrides = {};
      for (const [key, value] of Object.entries(globalRaw)) {
        global[key as FlagKey] = value === "1";
      }

      const rollouts: Record<string, number> = {};
      for (const [key, value] of Object.entries(rolloutsRaw)) {
        rollouts[key] = parseInt(value, 10);
      }

      return { global, rollouts: rollouts as Record<FlagKey, number> };
    }
  };

  async function getGlobalOverrides(): Promise<FlagOverrides> {
    const raw = await redis.hgetall(GLOBAL_FLAGS_KEY);
    const overrides: FlagOverrides = {};
    for (const [key, value] of Object.entries(raw)) {
      overrides[key as FlagKey] = value === "1";
    }
    return overrides;
  }

  async function getUserOverrides(userId: string): Promise<FlagOverrides> {
    const raw = await redis.hgetall(`${USER_FLAGS_PREFIX}${userId}`);
    const overrides: FlagOverrides = {};
    for (const [key, value] of Object.entries(raw)) {
      overrides[key as FlagKey] = value === "1";
    }
    return overrides;
  }

  async function getRolloutConfig(): Promise<Record<string, number>> {
    const raw = await redis.hgetall(ROLLOUT_FLAGS_KEY);
    const config: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw)) {
      config[key] = parseInt(value, 10);
    }
    return config;
  }
}

// Simple deterministic hash for percentage rollouts
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

// Helper to check multiple flags at once
export async function checkFlags(
  service: FeatureFlagService,
  flags: FlagKey[],
  userId?: string
): Promise<Record<FlagKey, boolean>> {
  const allFlags = await service.getFlags(userId);
  const result: Partial<Record<FlagKey, boolean>> = {};
  for (const flag of flags) {
    result[flag] = allFlags[flag];
  }
  return result as Record<FlagKey, boolean>;
}

// Middleware factory for feature-gated routes
export function requireFeature(service: FeatureFlagService, flag: FlagKey) {
  return async (request: { userId?: string }, reply: { code: (n: number) => { send: (o: object) => void } }) => {
    const enabled = await service.getFlag(flag, request.userId);
    if (!enabled) {
      reply.code(403).send({
        error: "feature_disabled",
        message: `Feature '${flag}' is not enabled for this user`
      });
      return false;
    }
    return true;
  };
}
