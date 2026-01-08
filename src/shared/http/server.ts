// Fastify server factory.
import fastify, { type FastifyInstance } from "fastify";
import type { Logger } from "pino";
import type { AppConfig } from "../config";

export function createServer({ logger }: { logger: Logger; config: AppConfig }): FastifyInstance {
  return fastify({
    logger,
    trustProxy: true
  });
}
