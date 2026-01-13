// Fastify server factory.
import fastify, { type FastifyInstance } from "fastify";
import { pino, type Logger } from "pino";
import type { AppConfig } from "../config.js";
import { registerMetricsRoutes } from "./metrics.js";

export function createServer({ logger, config }: { logger: Logger; config: AppConfig }): FastifyInstance {
  const app = fastify({
    logger: {
      level: config.logLevel,
      base: {
        service: config.serviceName,
        env: config.env
      },
      timestamp: pino.stdTimeFunctions.isoTime
    },
    trustProxy: true
  });

  registerMetricsRoutes(app, config);

  return app;
}
