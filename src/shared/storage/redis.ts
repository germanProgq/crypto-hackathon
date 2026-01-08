// Redis connection helper.
import Redis from "ioredis";
import type { Logger } from "pino";
import type { AppConfig } from "../config";

export type RedisClient = Redis;

export async function createRedisClient(config: AppConfig, logger: Logger): Promise<RedisClient> {
  const client = new Redis(config.redis.url, {
    keyPrefix: `${config.redis.prefix}:`,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false
  });

  client.on("error", (error) => {
    logger.error({ err: error }, "Redis error");
  });

  await client.connect();
  await client.ping();
  logger.info("Redis connected");

  return client;
}
