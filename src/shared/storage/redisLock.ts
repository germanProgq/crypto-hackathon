// Redis lock helper with token-based release.
import { randomUUID } from "node:crypto";
import type { RedisClient } from "./redis.js";

const releaseScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

export interface RedisLock {
  key: string;
  value: string;
  expiresAt: number;
}

export async function acquireRedisLock(
  client: RedisClient,
  key: string,
  ttlMs: number
): Promise<RedisLock | null> {
  const value = randomUUID();
  const result = await client.set(key, value, "PX", ttlMs, "NX");
  if (result !== "OK") {
    return null;
  }

  return {
    key,
    value,
    expiresAt: Date.now() + ttlMs
  };
}

export async function releaseRedisLock(client: RedisClient, lock: RedisLock): Promise<boolean> {
  const result = await client.eval(releaseScript, 1, lock.key, lock.value);
  return Number(result) > 0;
}
