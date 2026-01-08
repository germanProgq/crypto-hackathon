// Service bootstrap with dependency checks and health routes.
import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";
import type { AppConfig } from "./config";
import { loadConfig } from "./config";
import { createLogger } from "./logger";
import { createServer } from "./http/server";
import { registerHealthRoutes, type HealthCheck } from "./http/health";
import { connectMongo, ensureMongoCollections, ensureMongoIndexes, type MongoDependencies } from "./storage/mongo";
import { createRedisClient, type RedisClient } from "./storage/redis";

export interface ServiceDependencies {
  config: AppConfig;
  logger: Logger;
  mongo: MongoDependencies;
  redis: RedisClient;
}

export interface StartServiceOptions {
  serviceName: string;
  defaultPort: number;
  registerRoutes?: (app: FastifyInstance, deps: ServiceDependencies) => Promise<void> | void;
}

export async function startService(options: StartServiceOptions): Promise<void> {
  const config = loadConfig({
    serviceName: options.serviceName,
    defaultPort: options.defaultPort
  });
  const logger = createLogger(config);

  try {
    const mongo = await connectMongo(config, logger);
    await ensureMongoCollections(mongo.db, logger);
    await ensureMongoIndexes(mongo.db, logger);
    const redis = await createRedisClient(config, logger);

    const app = createServer({ logger, config });
    const dependencies: ServiceDependencies = { config, logger, mongo, redis };

    registerHealthRoutes(app, {
      serviceName: config.serviceName,
      checks: createDependencyChecks(dependencies)
    });

    if (options.registerRoutes) {
      await options.registerRoutes(app, dependencies);
    }

    app.addHook("onClose", async () => {
      await redis.quit();
      await mongo.client.close();
    });

    const address = await app.listen({
      host: config.http.host,
      port: config.http.port
    });

    logger.info({ address }, "Service started");

    const shutdown = async (signal: string) => {
      logger.info({ signal }, "Service stopping");
      await app.close();
      process.exit(0);
    };

    process.on("SIGINT", () => {
      void shutdown("SIGINT");
    });

    process.on("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
  } catch (error) {
    logger.error({ err: error }, "Service failed to start");
    process.exit(1);
  }
}

function createDependencyChecks(deps: ServiceDependencies): HealthCheck[] {
  return [
    {
      name: "mongo",
      check: () => checkMongo(deps.mongo)
    },
    {
      name: "redis",
      check: () => checkRedis(deps.redis)
    }
  ];
}

async function checkMongo(mongo: MongoDependencies) {
  try {
    await withTimeout(mongo.db.command({ ping: 1 }), 2000);
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: getErrorMessage(error) };
  }
}

async function checkRedis(redis: RedisClient) {
  try {
    await withTimeout(redis.ping(), 2000);
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: getErrorMessage(error) };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error("Health check timed out."));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}
