// Metrics instrumentation and /metrics endpoint.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { AppConfig } from "../config.js";

interface MetricsRequest extends FastifyRequest {
  metricsStart?: bigint;
  metricsRoute?: string;
  metricsMethod?: string;
}

const httpRequestDurationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export function registerMetricsRoutes(app: FastifyInstance, config: AppConfig): void {
  const registry = new Registry();
  registry.setDefaultLabels({
    service: config.serviceName,
    env: config.env
  });
  collectDefaultMetrics({ register: registry });

  const httpRequestsTotal = new Counter({
    name: "http_requests_total",
    help: "Total number of HTTP requests.",
    labelNames: ["method", "route", "status_code"],
    registers: [registry]
  });

  const httpRequestDuration = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds.",
    labelNames: ["method", "route", "status_code"],
    buckets: httpRequestDurationBuckets,
    registers: [registry]
  });

  const httpRequestsInFlight = new Gauge({
    name: "http_requests_in_flight",
    help: "Number of HTTP requests currently in flight.",
    labelNames: ["method", "route"],
    registers: [registry]
  });

  app.addHook("onRequest", async (request) => {
    const metricsRequest = request as MetricsRequest;
    metricsRequest.metricsStart = process.hrtime.bigint();
  });

  app.addHook("preHandler", async (request) => {
    const metricsRequest = request as MetricsRequest;
    const route = getRouteLabel(request);
    metricsRequest.metricsRoute = route;
    metricsRequest.metricsMethod = request.method;
    httpRequestsInFlight.inc({ method: request.method, route });
  });

  app.addHook("onResponse", async (request, reply) => {
    const metricsRequest = request as MetricsRequest;
    const route = metricsRequest.metricsRoute ?? getRouteLabel(request);
    const method = metricsRequest.metricsMethod ?? request.method;
    const statusCode = reply.statusCode.toString();

    httpRequestsTotal.inc({ method, route, status_code: statusCode });

    if (metricsRequest.metricsStart) {
      const durationSeconds =
        Number(process.hrtime.bigint() - metricsRequest.metricsStart) / 1e9;
      httpRequestDuration.observe({ method, route, status_code: statusCode }, durationSeconds);
    }

    if (metricsRequest.metricsRoute) {
      httpRequestsInFlight.dec({ method, route: metricsRequest.metricsRoute });
    }
  });

  app.get("/metrics", async (_, reply) => {
    const body = await registry.metrics();
    reply.header("Content-Type", registry.contentType);
    return reply.send(body);
  });
}

function getRouteLabel(request: FastifyRequest): string {
  if (request.is404) {
    return "not_found";
  }

  const route = request.routeOptions?.url ?? request.url;
  return route ?? "unknown";
}
