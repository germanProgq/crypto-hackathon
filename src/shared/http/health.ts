// Health and readiness endpoints.
import type { FastifyInstance } from "fastify";

export interface HealthCheckResult {
  ok: boolean;
  detail?: string;
}

export interface HealthCheck {
  name: string;
  check: () => Promise<HealthCheckResult>;
}

export function registerHealthRoutes(
  app: FastifyInstance,
  options: { serviceName: string; checks: HealthCheck[] }
): void {
  app.get("/health/live", async () => {
    return {
      status: "ok",
      service: options.serviceName,
      timestamp: new Date().toISOString()
    };
  });

  app.get("/health/ready", async (_, reply) => {
    const checks = await runChecks(options.checks);
    const failed = checks.filter((check) => !check.ok);

    if (failed.length > 0) {
      reply.code(503);
    }

    return {
      status: failed.length > 0 ? "degraded" : "ok",
      service: options.serviceName,
      timestamp: new Date().toISOString(),
      checks
    };
  });
}

async function runChecks(checks: HealthCheck[]) {
  const results = await Promise.all(
    checks.map(async (check) => {
      const result = await check.check();

      return {
        name: check.name,
        ok: result.ok,
        detail: result.detail
      };
    })
  );

  return results;
}
