// Service configuration schema and loader.
import { z } from "zod";

const localeValues = ["en", "ru"] as const;
const logLevels = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
const walletStrategyValues = ["address_pool", "memo_tag", "address_per_user"] as const;

export type Locale = (typeof localeValues)[number];
export type LogLevel = (typeof logLevels)[number];
export type NodeEnv = "development" | "test" | "production";
export type WalletStrategy = (typeof walletStrategyValues)[number];

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
    poolMax: number;
  };
  redis: {
    url: string;
    prefix: string;
  };
  coreApi: {
    token: string;
  };
  rateLimits: {
    userPerSecond: number;
    auctionUserPerSecond: number;
    ipPerSecond: number;
  };
  dataRetention: {
    bidsDays: number;
    ledgerDays: number;
    notificationsDays: number;
  };
  i18n: {
    defaultLocale: Locale;
    supportedLocales: Locale[];
  };
  telegram: {
    botToken: string;
    apiBaseUrl: string;
    webAppMaxAgeSeconds: number;
  };
  web: {
    allowedOrigins: string[];
    allowDemoUser: boolean;
    publicUrl?: string;
  };
  bids: {
    minIncrement: number;
    proxyAutoRaise: boolean;
    mode: "safe" | "fast" | "auto";
    fastSyncIntervalMs: number;
    fastSyncBatchSize: number;
  };
  crypto: {
    supportedCurrencies: string[];
    walletStrategy: WalletStrategy;
    observerUrl: string;
    signerUrl: string;
    signerToken: string;
    adminToken: string;
    usdRates: Record<string, number>;
    deposit: {
      confirmations: number;
      pollIntervalMs: number;
      addressPool: Record<string, string[]>;
      memoDepositAddresses: Record<string, string>;
      hdMasterPublicKeys: Record<string, string>;
      hdDerivationPathPrefix: string;
    };
    withdrawal: {
      confirmations: number;
      pollIntervalMs: number;
      broadcastIntervalMs: number;
      hotWalletAddresses: Record<string, string>;
      minAmount: number;
      maxAmount: number;
      dailyLimit: number;
      cooldownSeconds: number;
      allowlistRequired: boolean;
      autoAuthorizeMaxAmount: number;
      anomalyMultiplier: number;
      maxRequestsPerHour: number;
      maxRequestsPerDay: number;
    };
  };
  signer: {
    apiToken: string;
    allowedIps: string[];
    privateKey: string;
    privateKeys: string[];
    multisigThreshold: number;
    kmsUrl?: string;
    kmsKeyId?: string;
    kmsToken?: string;
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

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isOptionalHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized.length === 0 || normalized === "mock") {
    return true;
  }
  return isHttpUrl(trimmed);
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

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parseOrigins(value: string): string[] {
  const entries = parseCsv(value).map((entry) => entry.replace(/\/+$/, ""));
  return Array.from(new Set(entries));
}

function parseCurrencies(value: string): string[] {
  const entries = parseCsv(value).map((entry) => entry.toUpperCase());
  const unique = new Set<string>();
  for (const entry of entries) {
    if (!/^[A-Z0-9]{2,10}$/.test(entry)) {
      throw new Error(`Unsupported currency: ${entry}`);
    }
    unique.add(entry);
  }
  if (unique.size === 0) {
    throw new Error("At least one currency must be configured.");
  }
  return Array.from(unique);
}

function parseUsdRates(value: string): Record<string, number> {
  const entries = parseCsv(value);
  const result: Record<string, number> = {};
  for (const entry of entries) {
    const [currencyRaw, rateRaw] = entry.split(":", 2);
    const currency = (currencyRaw ?? "").trim().toUpperCase();
    const rateText = (rateRaw ?? "").trim();
    if (!currency || !rateText) {
      throw new Error(`Invalid CRYPTO_USD_RATES entry: ${entry}`);
    }
    if (!/^[A-Z0-9]{2,10}$/.test(currency)) {
      throw new Error(`Unsupported currency in CRYPTO_USD_RATES: ${currency}`);
    }
    const rate = Number(rateText);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`Invalid USD rate for ${currency}.`);
    }
    result[currency] = rate;
  }
  return result;
}

function parseAddressPool(value: string, defaultCurrency: string): Record<string, string[]> {
  const entries = parseCsv(value);
  const result: Record<string, string[]> = {};
  for (const entry of entries) {
    const [currencyCandidateRaw, addressCandidateRaw] = entry.includes(":")
      ? entry.split(":", 2)
      : [defaultCurrency, entry];
    const currency = (currencyCandidateRaw ?? defaultCurrency).trim().toUpperCase();
    const address = (addressCandidateRaw ?? "").trim();
    if (!currency || !address) {
      continue;
    }
    if (!result[currency]) {
      result[currency] = [];
    }
    result[currency]?.push(address);
  }
  return result;
}

function parseCurrencyValueMap(
  value: string,
  defaultCurrency: string
): Record<string, string> {
  const entries = parseCsv(value);
  const result: Record<string, string> = {};
  for (const entry of entries) {
    const [currencyCandidateRaw, addressCandidateRaw] = entry.includes(":")
      ? entry.split(":", 2)
      : [defaultCurrency, entry];
    const currency = (currencyCandidateRaw ?? defaultCurrency).trim().toUpperCase();
    const address = (addressCandidateRaw ?? "").trim();
    if (!currency || !address) {
      continue;
    }
    result[currency] = address;
  }
  return result;
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
    MONGO_POOL_MAX: z.coerce.number().int().min(10).max(1000).default(200),
    REDIS_URL: z
      .string()
      .min(1)
      .refine(isRedisUrl, "REDIS_URL must start with redis:// or rediss://")
      .default("redis://127.0.0.1:6379"),
    REDIS_PREFIX: z.string().min(1).default("crypto-hack"),
    CORE_API_TOKEN: z.string().default(""),
    RATE_LIMIT_USER_PER_SECOND: z.coerce.number().int().min(1).default(5),
    RATE_LIMIT_AUCTION_USER_PER_SECOND: z.coerce.number().int().min(1).default(3),
    RATE_LIMIT_IP_PER_SECOND: z.coerce.number().int().min(1).default(20),
    RETENTION_BIDS_DAYS: z.coerce.number().int().min(0).default(90),
    RETENTION_LEDGER_DAYS: z.coerce.number().int().min(0).default(365),
    RETENTION_NOTIFICATIONS_DAYS: z.coerce.number().int().min(0).default(30),
    I18N_DEFAULT_LOCALE: z.enum(localeValues).default("en"),
    I18N_SUPPORTED_LOCALES: z.string().default("en,ru"),
    TELEGRAM_BOT_TOKEN: z.string().default(""),
    TELEGRAM_API_BASE: z.string().url().default("https://api.telegram.org"),
    TELEGRAM_WEBAPP_MAX_AGE_SECONDS: z.coerce.number().int().min(0).default(86400),
    WEB_ALLOWED_ORIGINS: z.string().default(""),
    WEB_ALLOW_DEMO_USER: z.string().optional(),
    WEB_PUBLIC_URL: z
      .string()
      .default("")
      .transform((value) => value.trim())
      .refine((value) => isOptionalHttpUrl(value), "WEB_PUBLIC_URL must be http(s) or empty"),
    BID_MIN_INCREMENT: z.coerce.number().min(0).default(0.01),
    BID_PROXY_AUTO_RAISE: z.string().optional(),
    BID_MODE: z.enum(["safe", "fast", "auto"]).default("safe"),
    BID_FAST_SYNC_INTERVAL_MS: z.coerce.number().int().min(50).default(1000),
    BID_FAST_SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
    CRYPTO_SUPPORTED_CURRENCIES: z.string().default("USDT"),
    CRYPTO_WALLET_STRATEGY: z.enum(walletStrategyValues).default("address_pool"),
    CRYPTO_OBSERVER_URL: z
      .string()
      .default("")
      .transform((value) => value.trim())
      .refine(
        (value) => isOptionalHttpUrl(value),
        "CRYPTO_OBSERVER_URL must be http(s), empty, or 'mock'"
      ),
    CRYPTO_SIGNER_URL: z
      .string()
      .default("")
      .transform((value) => value.trim())
      .refine(
        (value) => isOptionalHttpUrl(value),
        "CRYPTO_SIGNER_URL must be http(s), empty, or 'mock'"
      ),
    CRYPTO_SIGNER_TOKEN: z.string().default(""),
    CRYPTO_ADMIN_TOKEN: z.string().default(""),
    CRYPTO_USD_RATES: z.string().default(""),
    CRYPTO_DEPOSIT_CONFIRMATIONS: z.coerce.number().int().min(1).default(6),
    CRYPTO_WITHDRAWAL_CONFIRMATIONS: z.coerce.number().int().min(1).default(6),
    CRYPTO_DEPOSIT_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
    CRYPTO_WITHDRAWAL_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
    CRYPTO_WITHDRAWAL_BROADCAST_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
    CRYPTO_DEPOSIT_ADDRESS_POOL: z.string().default(""),
    CRYPTO_MEMO_DEPOSIT_ADDRESS: z.string().default(""),
    CRYPTO_HD_MASTER_PUBLIC_KEY: z.string().default(""),
    CRYPTO_HD_DERIVATION_PATH_PREFIX: z.string().default("m/0"),
    CRYPTO_HOT_WALLET_ADDRESS: z.string().default(""),
    CRYPTO_WITHDRAWAL_MIN_AMOUNT: z.coerce.number().positive().default(1),
    CRYPTO_WITHDRAWAL_MAX_AMOUNT: z.coerce.number().positive().default(1000000),
    CRYPTO_WITHDRAWAL_DAILY_LIMIT: z.coerce.number().positive().default(1000000),
    CRYPTO_WITHDRAWAL_COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(60),
    CRYPTO_WITHDRAWAL_ALLOWLIST_REQUIRED: z.coerce.boolean().default(false),
    CRYPTO_WITHDRAWAL_AUTO_AUTHORIZE_MAX_AMOUNT: z.coerce.number().positive().default(1000),
    CRYPTO_WITHDRAWAL_ANOMALY_MULTIPLIER: z.coerce.number().positive().default(3),
    CRYPTO_WITHDRAWAL_MAX_REQUESTS_PER_HOUR: z.coerce.number().int().min(1).default(5),
    CRYPTO_WITHDRAWAL_MAX_REQUESTS_PER_DAY: z.coerce.number().int().min(1).default(20),
    SIGNER_API_TOKEN: z.string().default(""),
    SIGNER_ALLOWED_IPS: z.string().default(""),
    SIGNER_PRIVATE_KEY: z.string().default(""),
    SIGNER_PRIVATE_KEYS: z.string().default(""),
    SIGNER_MULTISIG_THRESHOLD: z.coerce.number().int().min(1).default(1),
    SIGNER_KMS_URL: z.string().default(""),
    SIGNER_KMS_KEY_ID: z.string().default(""),
    SIGNER_KMS_TOKEN: z.string().default("")
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
  const supportedCurrencies = parseCurrencies(parsed.CRYPTO_SUPPORTED_CURRENCIES);
  const defaultCurrency = supportedCurrencies[0] ?? "USDT";
  const coreApiToken = parsed.CORE_API_TOKEN.trim();
  const usdRates = parseUsdRates(parsed.CRYPTO_USD_RATES);
  const addressPool = parseAddressPool(parsed.CRYPTO_DEPOSIT_ADDRESS_POOL, defaultCurrency);
  const memoDepositAddresses = parseCurrencyValueMap(
    parsed.CRYPTO_MEMO_DEPOSIT_ADDRESS,
    defaultCurrency
  );
  const hdMasterPublicKeys = parseCurrencyValueMap(
    parsed.CRYPTO_HD_MASTER_PUBLIC_KEY,
    defaultCurrency
  );
  const hdDerivationPathPrefix =
    parsed.CRYPTO_HD_DERIVATION_PATH_PREFIX.trim() || "m/0";
  const hotWalletAddresses = parseCurrencyValueMap(
    parsed.CRYPTO_HOT_WALLET_ADDRESS,
    defaultCurrency
  );
  const signerAllowedIps = parseCsv(parsed.SIGNER_ALLOWED_IPS);
  const signerPrivateKeys = parseCsv(parsed.SIGNER_PRIVATE_KEYS);
  const signerKmsUrl = parsed.SIGNER_KMS_URL.trim();
  const signerKmsKeyId = parsed.SIGNER_KMS_KEY_ID.trim();
  const signerKmsToken = parsed.SIGNER_KMS_TOKEN.trim();
  const webAllowedOrigins = parseOrigins(parsed.WEB_ALLOWED_ORIGINS);
  const allowDemoUser =
    parseOptionalBoolean(parsed.WEB_ALLOW_DEMO_USER) ??
    parsed.NODE_ENV !== "production";
  const webPublicUrl = parsed.WEB_PUBLIC_URL.trim();
  const proxyAutoRaise = parseOptionalBoolean(parsed.BID_PROXY_AUTO_RAISE) ?? true;

  if (!supportedLocales.includes(parsed.I18N_DEFAULT_LOCALE)) {
    throw new Error("I18N_DEFAULT_LOCALE must be included in I18N_SUPPORTED_LOCALES.");
  }

  if (
    ["auction-engine", "ledger", "crypto-gateway"].includes(serviceName) &&
    coreApiToken.length === 0
  ) {
    throw new Error("CORE_API_TOKEN must be set for core services.");
  }

  if (serviceName === "crypto-gateway") {
    const missingRates = supportedCurrencies.filter((currency) => usdRates[currency] === undefined);
    if (missingRates.length > 0) {
      throw new Error(`CRYPTO_USD_RATES must include rates for: ${missingRates.join(", ")}`);
    }
  }

  if (
    serviceName === "crypto-gateway" &&
    parsed.CRYPTO_WALLET_STRATEGY === "address_pool" &&
    Object.values(addressPool).every((entries) => entries.length === 0)
  ) {
    throw new Error("CRYPTO_DEPOSIT_ADDRESS_POOL must include at least one address.");
  }

  if (
    serviceName === "crypto-gateway" &&
    parsed.CRYPTO_WALLET_STRATEGY === "memo_tag" &&
    supportedCurrencies.some((currency) => !memoDepositAddresses[currency])
  ) {
    throw new Error("CRYPTO_MEMO_DEPOSIT_ADDRESS must be set for memo_tag strategy.");
  }

  if (
    serviceName === "crypto-gateway" &&
    parsed.CRYPTO_WALLET_STRATEGY === "address_per_user" &&
    supportedCurrencies.some((currency) => !hdMasterPublicKeys[currency])
  ) {
    throw new Error("CRYPTO_HD_MASTER_PUBLIC_KEY must be set for address_per_user.");
  }

  if (
    serviceName === "crypto-gateway" &&
    supportedCurrencies.some((currency) => !hotWalletAddresses[currency])
  ) {
    throw new Error("CRYPTO_HOT_WALLET_ADDRESS must be set for all currencies.");
  }

  if (serviceName === "crypto-gateway" && parsed.CRYPTO_SIGNER_TOKEN.length === 0) {
    throw new Error("CRYPTO_SIGNER_TOKEN must be set for crypto-gateway.");
  }

  if (parsed.CRYPTO_WITHDRAWAL_MAX_AMOUNT < parsed.CRYPTO_WITHDRAWAL_MIN_AMOUNT) {
    throw new Error("CRYPTO_WITHDRAWAL_MAX_AMOUNT must be >= CRYPTO_WITHDRAWAL_MIN_AMOUNT.");
  }

  if (serviceName === "signer" && parsed.SIGNER_API_TOKEN.length === 0) {
    throw new Error("SIGNER_API_TOKEN must be set for signer.");
  }

  if (signerKmsUrl.length > 0 && !isHttpUrl(signerKmsUrl)) {
    throw new Error("SIGNER_KMS_URL must be a valid http(s) URL.");
  }

  if (serviceName === "signer") {
    const keyMaterial = [parsed.SIGNER_PRIVATE_KEY, ...signerPrivateKeys].filter(
      (entry) => entry.length > 0
    );
    const signerKeyCount = keyMaterial.length + (signerKmsUrl.length > 0 ? 1 : 0);
    if (signerKeyCount === 0) {
      throw new Error("Signer requires SIGNER_PRIVATE_KEY, SIGNER_PRIVATE_KEYS, or SIGNER_KMS_URL.");
    }
    if (parsed.SIGNER_MULTISIG_THRESHOLD > signerKeyCount) {
      throw new Error("SIGNER_MULTISIG_THRESHOLD exceeds configured signer key count.");
    }
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
      dbName: parsed.MONGO_DB,
      poolMax: parsed.MONGO_POOL_MAX
    },
    redis: {
      url: parsed.REDIS_URL,
      prefix: parsed.REDIS_PREFIX
    },
    coreApi: {
      token: coreApiToken
    },
    rateLimits: {
      userPerSecond: parsed.RATE_LIMIT_USER_PER_SECOND,
      auctionUserPerSecond: parsed.RATE_LIMIT_AUCTION_USER_PER_SECOND,
      ipPerSecond: parsed.RATE_LIMIT_IP_PER_SECOND
    },
    dataRetention: {
      bidsDays: parsed.RETENTION_BIDS_DAYS,
      ledgerDays: parsed.RETENTION_LEDGER_DAYS,
      notificationsDays: parsed.RETENTION_NOTIFICATIONS_DAYS
    },
    i18n: {
      defaultLocale: parsed.I18N_DEFAULT_LOCALE,
      supportedLocales
    },
    telegram: {
      botToken: parsed.TELEGRAM_BOT_TOKEN,
      apiBaseUrl: parsed.TELEGRAM_API_BASE,
      webAppMaxAgeSeconds: parsed.TELEGRAM_WEBAPP_MAX_AGE_SECONDS
    },
    web: {
      allowedOrigins: webAllowedOrigins,
      allowDemoUser,
      publicUrl: webPublicUrl.length > 0 ? webPublicUrl : undefined
    },
    bids: {
      minIncrement: parsed.BID_MIN_INCREMENT,
      proxyAutoRaise,
      mode: parsed.BID_MODE,
      fastSyncIntervalMs: parsed.BID_FAST_SYNC_INTERVAL_MS,
      fastSyncBatchSize: parsed.BID_FAST_SYNC_BATCH_SIZE
    },
    crypto: {
      supportedCurrencies,
      walletStrategy: parsed.CRYPTO_WALLET_STRATEGY,
      observerUrl: parsed.CRYPTO_OBSERVER_URL,
      signerUrl: parsed.CRYPTO_SIGNER_URL,
      signerToken: parsed.CRYPTO_SIGNER_TOKEN,
      adminToken: parsed.CRYPTO_ADMIN_TOKEN,
      usdRates,
      deposit: {
        confirmations: parsed.CRYPTO_DEPOSIT_CONFIRMATIONS,
        pollIntervalMs: parsed.CRYPTO_DEPOSIT_POLL_INTERVAL_MS,
        addressPool,
        memoDepositAddresses,
        hdMasterPublicKeys,
        hdDerivationPathPrefix
      },
      withdrawal: {
        confirmations: parsed.CRYPTO_WITHDRAWAL_CONFIRMATIONS,
        pollIntervalMs: parsed.CRYPTO_WITHDRAWAL_POLL_INTERVAL_MS,
        broadcastIntervalMs: parsed.CRYPTO_WITHDRAWAL_BROADCAST_INTERVAL_MS,
        hotWalletAddresses,
        minAmount: parsed.CRYPTO_WITHDRAWAL_MIN_AMOUNT,
        maxAmount: parsed.CRYPTO_WITHDRAWAL_MAX_AMOUNT,
        dailyLimit: parsed.CRYPTO_WITHDRAWAL_DAILY_LIMIT,
        cooldownSeconds: parsed.CRYPTO_WITHDRAWAL_COOLDOWN_SECONDS,
        allowlistRequired: parsed.CRYPTO_WITHDRAWAL_ALLOWLIST_REQUIRED,
        autoAuthorizeMaxAmount: parsed.CRYPTO_WITHDRAWAL_AUTO_AUTHORIZE_MAX_AMOUNT,
        anomalyMultiplier: parsed.CRYPTO_WITHDRAWAL_ANOMALY_MULTIPLIER,
        maxRequestsPerHour: parsed.CRYPTO_WITHDRAWAL_MAX_REQUESTS_PER_HOUR,
        maxRequestsPerDay: parsed.CRYPTO_WITHDRAWAL_MAX_REQUESTS_PER_DAY
      }
    },
    signer: {
      apiToken: parsed.SIGNER_API_TOKEN,
      allowedIps: signerAllowedIps,
      privateKey: parsed.SIGNER_PRIVATE_KEY,
      privateKeys: signerPrivateKeys,
      multisigThreshold: parsed.SIGNER_MULTISIG_THRESHOLD,
      kmsUrl: signerKmsUrl.length > 0 ? signerKmsUrl : undefined,
      kmsKeyId: signerKmsKeyId.length > 0 ? signerKmsKeyId : undefined,
      kmsToken: signerKmsToken.length > 0 ? signerKmsToken : undefined
    }
  };
}
