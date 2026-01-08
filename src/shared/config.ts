// Service configuration schema and loader.
import { z } from "zod";

const localeValues = ["en", "ru"] as const;
const logLevels = ["fatal", "error", "warn", "info", "debug", "trace"] as const;

export type Locale = (typeof localeValues)[number];
export type LogLevel = (typeof logLevels)[number];
export type NodeEnv = "development" | "test" | "production";

export interface AppConfig {
  env: NodeEnv;
  serviceName: string;
  http: {
    host: string;
    port: number;
  };
  logLevel: LogLevel;
  mongo: {
    uri: string;
    dbName: string;
  };
  redis: {
    url: string;
    prefix: string;
  };
  rateLimits: {
    userPerSecond: number;
    auctionUserPerSecond: number;
    ipPerSecond: number;
  };
  i18n: {
    defaultLocale: Locale;
    supportedLocales: Locale[];
  };
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  serviceName?: string;
  defaultPort?: number;
}

function isMongoUri(value: string): boolean {
  return value.startsWith("mongodb://") || value.startsWith("mongodb+srv://");
}

function isRedisUrl(value: string): boolean {
  return value.startsWith("redis://") || value.startsWith("rediss://");
}

function parseLocales(value: string): Locale[] {
  const entries = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  const unique = new Set<Locale>();

  for (const entry of entries) {
    if (!localeValues.includes(entry as Locale)) {
      throw new Error(`Unsupported locale: ${entry}`);
    }

    unique.add(entry as Locale);
  }

  if (unique.size === 0) {
    throw new Error("At least one locale must be configured.");
  }

  return Array.from(unique);
}

function createEnvSchema(defaultPort: number) {
  return z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    SERVICE_NAME: z.string().min(1),
    HTTP_HOST: z.string().min(1).default("0.0.0.0"),
    HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(defaultPort),
    LOG_LEVEL: z.enum(logLevels).default("info"),
    MONGO_URI: z
      .string()
      .min(1)
      .refine(isMongoUri, "MONGO_URI must start with mongodb:// or mongodb+srv://")
      .default("mongodb://127.0.0.1:27017"),
    MONGO_DB: z.string().min(1).default("crypto_hack"),
    REDIS_URL: z
      .string()
      .min(1)
      .refine(isRedisUrl, "REDIS_URL must start with redis:// or rediss://")
      .default("redis://127.0.0.1:6379"),
    REDIS_PREFIX: z.string().min(1).default("crypto-hack"),
    RATE_LIMIT_USER_PER_SECOND: z.coerce.number().int().min(1).default(5),
    RATE_LIMIT_AUCTION_USER_PER_SECOND: z.coerce.number().int().min(1).default(3),
    RATE_LIMIT_IP_PER_SECOND: z.coerce.number().int().min(1).default(20),
    I18N_DEFAULT_LOCALE: z.enum(localeValues).default("en"),
    I18N_SUPPORTED_LOCALES: z.string().default("en,ru")
  });
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env;
  const serviceName = options.serviceName ?? env.SERVICE_NAME ?? "auction-engine";
  const defaultPort = options.defaultPort ?? 3000;
  const schema = createEnvSchema(defaultPort);
  const normalizedEnv = {
    ...env,
    MONGO_URI: env.MONGODB_URI ?? env.MONGO_URI
  };

  const parsed = schema.parse({
    ...normalizedEnv,
    SERVICE_NAME: serviceName
  });

  const supportedLocales = parseLocales(parsed.I18N_SUPPORTED_LOCALES);

  if (!supportedLocales.includes(parsed.I18N_DEFAULT_LOCALE)) {
    throw new Error("I18N_DEFAULT_LOCALE must be included in I18N_SUPPORTED_LOCALES.");
  }

  return {
    env: parsed.NODE_ENV,
    serviceName,
    http: {
      host: parsed.HTTP_HOST,
      port: parsed.HTTP_PORT
    },
    logLevel: parsed.LOG_LEVEL,
    mongo: {
      uri: parsed.MONGO_URI,
      dbName: parsed.MONGO_DB
    },
    redis: {
      url: parsed.REDIS_URL,
      prefix: parsed.REDIS_PREFIX
    },
    rateLimits: {
      userPerSecond: parsed.RATE_LIMIT_USER_PER_SECOND,
      auctionUserPerSecond: parsed.RATE_LIMIT_AUCTION_USER_PER_SECOND,
      ipPerSecond: parsed.RATE_LIMIT_IP_PER_SECOND
    },
    i18n: {
      defaultLocale: parsed.I18N_DEFAULT_LOCALE,
      supportedLocales
    }
  };
}
