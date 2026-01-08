// Structured logger configuration.
import pino, { type Logger } from "pino";
import type { AppConfig } from "./config";

export function createLogger(config: AppConfig): Logger {
  return pino({
    level: config.logLevel,
    base: {
      service: config.serviceName,
      env: config.env
    },
    timestamp: pino.stdTimeFunctions.isoTime
  });
}
