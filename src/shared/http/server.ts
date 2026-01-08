// Fastify server factory.
import fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";

export function createServer({ logger }: { logger: Logger; config: AppConfig }): FastifyInstance {
  return fastify({
    logger: logger as unknown as FastifyBaseLogger,
    trustProxy: true
  });
}
