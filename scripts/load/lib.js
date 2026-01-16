// Load test helpers for auction services.
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Agent, setGlobalDispatcher } from "undici";

export function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) {
      continue;
    }
    const trimmed = raw.slice(2);
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) {
      args[trimmed] = true;
    } else {
      const key = trimmed.slice(0, eqIndex);
      const value = trimmed.slice(eqIndex + 1);
      args[key] = value;
    }
  }
  return args;
}

export function resolveConfig(args) {
  return {
    auctionUrl: readText(args["auction-url"], process.env.AUCTION_URL, "http://localhost:4001"),
    ledgerUrl: readText(args["ledger-url"], process.env.LEDGER_URL, "http://localhost:4002"),
    webUrl: readText(args["web-url"], process.env.WEB_URL, "http://localhost:4005"),
    coreApiToken: readText(
      args["core-api-token"],
      process.env.CORE_API_TOKEN,
      ""
    ),
    currency: readText(args.currency, process.env.CURRENCY, "USDT"),
    timeoutMs: readNumber(args.timeoutMs ?? args.timeout, process.env.LOAD_TIMEOUT_MS, 10000)
  };
}

export function buildRunId(args) {
  const envId = readText(args["run-id"], process.env.LOAD_RUN_ID, "");
  if (envId) {
    return envId;
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function buildUserId(prefix, runId, index) {
  return `${prefix}-${runId}-${index}`;
}

export function buildForwardedIp(index) {
  const third = Math.floor(index / 250) % 250;
  const fourth = (index % 250) + 1;
  return `10.0.${third}.${fourth}`;
}

export async function sleep(timeoutMs) {
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

export function readNumber(value, fallback, defaultValue) {
  const candidate = value ?? fallback;
  if (candidate === undefined || candidate === null || candidate === "") {
    return defaultValue;
  }
  const parsed = Number(candidate);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  return parsed;
}

export function readText(value, fallback, defaultValue) {
  const candidate = value ?? fallback;
  if (candidate === undefined || candidate === null) {
    return defaultValue;
  }
  const trimmed = String(candidate).trim();
  return trimmed.length > 0 ? trimmed : defaultValue;
}

export function buildServiceHeaders(serviceToken, extraHeaders) {
  const headers = { ...(extraHeaders ?? {}) };
  if (serviceToken) {
    headers["x-service-token"] = serviceToken;
  }
  return headers;
}

export async function fetchRequest(url, options = {}) {
  const {
    method = "GET",
    body,
    headers = {},
    timeoutMs = 10000,
    parseJson = false
  } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestHeaders = {
      accept: "application/json",
      ...headers
    };
    let payload;
    if (body !== undefined) {
      requestHeaders["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }

    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: payload,
      signal: controller.signal
    });
    let data = null;
    if (parseJson) {
      const text = await response.text();
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
    } else {
      await drainResponse(response);
    }

    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchJson(url, options = {}) {
  return fetchRequest(url, { ...options, parseJson: true });
}

export async function timedJson(url, options) {
  const start = performance.now();
  const response = await fetchJson(url, options);
  const durationMs = performance.now() - start;
  return { ...response, durationMs };
}

export async function timedRequest(url, options) {
  const start = performance.now();
  const response = await fetchRequest(url, options);
  const durationMs = performance.now() - start;
  return { ...response, durationMs };
}

export async function createAuction({
  webUrl,
  title,
  currency,
  rounds,
  allocationSize,
  roundDurationSeconds,
  startOffsetSeconds,
  antiSniping
}) {
  const payload = {
    title,
    currency,
    rounds,
    allocationSize,
    roundDurationSeconds,
    startOffsetSeconds,
    antiSniping
  };
  let origin = webUrl;
  try {
    origin = new URL(webUrl).origin;
  } catch {
    // Keep the provided webUrl if it is not a valid URL.
  }
  const telegramInitData = readText(
    process.env.LOAD_TELEGRAM_INIT_DATA,
    process.env.TELEGRAM_INIT_DATA,
    ""
  );
  const demoUserId = telegramInitData
    ? ""
    : readText(process.env.LOAD_DEMO_USER_ID, process.env.WEB_DEMO_USER_ID, "demo");
  const headers = { origin };
  if (telegramInitData) {
    headers["x-telegram-init-data"] = telegramInitData;
  } else if (demoUserId) {
    headers["x-demo-user-id"] = demoUserId;
  }
  const response = await fetchJson(`${webUrl}/api/auctions`, {
    method: "POST",
    body: payload,
    headers
  });
  if (!response.ok || !response.data || !response.data._id) {
    throw new Error(
      `Auction creation failed (${response.status}): ${JSON.stringify(response.data)}`
    );
  }
  return { auctionId: response.data._id, status: response.data.status };
}

export async function waitForRoundStatus({
  auctionUrl,
  auctionId,
  roundIndex,
  status,
  timeoutMs,
  pollMs,
  serviceToken
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetchJson(
      `${auctionUrl}/auctions/${auctionId}/rounds/${roundIndex}/state`,
      { headers: buildServiceHeaders(serviceToken) }
    );
    if (response.ok && response.data && response.data.state) {
      const current = response.data.state.status;
      if (current === status) {
        return response.data.state;
      }
    }
    await sleep(pollMs);
  }
  throw new Error(`Round ${roundIndex} did not reach status ${status} in time.`);
}

export async function getRoundState({ auctionUrl, auctionId, roundIndex, serviceToken }) {
  const response = await fetchJson(
    `${auctionUrl}/auctions/${auctionId}/rounds/${roundIndex}/state`,
    { headers: buildServiceHeaders(serviceToken) }
  );
  if (!response.ok || !response.data || !response.data.state) {
    throw new Error(`Round state fetch failed: ${response.status}`);
  }
  return response.data.state;
}

export async function seedDeposits({
  ledgerUrl,
  users,
  amount,
  currency,
  concurrency,
  timeoutMs,
  serviceToken
}) {
  const tasks = users.map((userId) => async () => {
    const payload = {
      userId,
      amount,
      currency,
      idempotencyKey: `deposit-${userId}-${Date.now()}-${randomUUID()}`,
      entryType: "deposit_confirmed"
    };
    const response = await fetchRequest(`${ledgerUrl}/ledger/entries`, {
      method: "POST",
      body: payload,
      headers: buildServiceHeaders(serviceToken),
      timeoutMs
    });
    if (!response.ok) {
      throw new Error(`Deposit failed for ${userId}: ${response.status}`);
    }
    return response.data;
  });
  return runTasksWithLimit(tasks, concurrency);
}

export async function placeBid({
  auctionUrl,
  auctionId,
  userId,
  amount,
  idempotencyKey,
  ip,
  timeoutMs,
  parseJson = false,
  serviceToken
}) {
  const headers = buildServiceHeaders(
    serviceToken,
    ip ? { "x-forwarded-for": ip } : undefined
  );
  return timedRequest(`${auctionUrl}/auctions/${auctionId}/bids`, {
    method: "POST",
    body: { userId, amount, idempotencyKey },
    headers,
    timeoutMs,
    parseJson
  });
}

export async function reconcileUser({ ledgerUrl, userId, currency, serviceToken }) {
  const response = await fetchJson(
    `${ledgerUrl}/ledger/${encodeURIComponent(userId)}/reconcile?currency=${encodeURIComponent(
      currency
    )}`,
    { headers: buildServiceHeaders(serviceToken) }
  );
  if (!response.ok) {
    throw new Error(`Reconcile failed for ${userId}: ${response.status}`);
  }
  return response.data;
}

export function computeStats(samples) {
  if (!samples.length) {
    return null;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: total / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99)
  };
}

export function formatStats(stats) {
  if (!stats) {
    return "no samples";
  }
  return [
    `count=${stats.count}`,
    `min=${stats.min.toFixed(2)}ms`,
    `mean=${stats.mean.toFixed(2)}ms`,
    `p50=${stats.p50.toFixed(2)}ms`,
    `p95=${stats.p95.toFixed(2)}ms`,
    `p99=${stats.p99.toFixed(2)}ms`,
    `max=${stats.max.toFixed(2)}ms`
  ].join(" ");
}

export function buildUserList({ prefix, runId, count }) {
  return Array.from({ length: count }).map((_, index) => buildUserId(prefix, runId, index));
}

export function buildStatusCounts() {
  return { ok: 0, error: 0, byStatus: {} };
}

export function recordStatus(statusCounts, response) {
  const status = response?.status ?? "unknown";
  if (response?.ok) {
    statusCounts.ok += 1;
  } else {
    statusCounts.error += 1;
  }
  statusCounts.byStatus[status] = (statusCounts.byStatus[status] ?? 0) + 1;
}

export async function runTasksWithLimit(tasks, limit) {
  const resolvedLimit = Math.max(1, Math.floor(limit));
  const results = new Array(tasks.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(resolvedLimit, tasks.length) }).map(
    async () => {
      while (index < tasks.length) {
        const current = index;
        index += 1;
        results[current] = await tasks[current]();
      }
    }
  );
  await Promise.all(workers);
  return results;
}

export function randomBetween(min, max) {
  const minValue = Math.min(min, max);
  const maxValue = Math.max(min, max);
  return minValue + Math.random() * (maxValue - minValue);
}

function percentile(sorted, fraction) {
  if (!sorted.length) {
    return 0;
  }
  const index = Math.ceil((sorted.length - 1) * fraction);
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))];
}

export function formatStatusCounts(statusCounts) {
  const entries = Object.entries(statusCounts.byStatus).sort((a, b) => {
    const left = Number(a[0]);
    const right = Number(b[0]);
    if (!Number.isNaN(left) && !Number.isNaN(right)) {
      return left - right;
    }
    return String(a[0]).localeCompare(String(b[0]));
  });
  return {
    ok: statusCounts.ok,
    error: statusCounts.error,
    byStatus: Object.fromEntries(entries)
  };
}

async function drainResponse(response) {
  if (!response?.body) {
    return;
  }
  try {
    await response.arrayBuffer();
  } catch {
    try {
      await response.body.cancel();
    } catch {
      // Ignore body teardown errors.
    }
  }
}

configureLoadHttp();

function configureLoadHttp() {
  const connections = Math.max(
    1,
    Math.floor(readNumber(process.env.LOAD_HTTP_CONNECTIONS, undefined, 200))
  );
  const pipelining = Math.max(
    1,
    Math.floor(readNumber(process.env.LOAD_HTTP_PIPELINING, undefined, 1))
  );
  const keepAliveTimeout = Math.max(
    1000,
    Math.floor(readNumber(process.env.LOAD_HTTP_KEEP_ALIVE_TIMEOUT_MS, undefined, 10000))
  );
  const keepAliveMaxTimeout = Math.max(
    1000,
    Math.floor(readNumber(process.env.LOAD_HTTP_KEEP_ALIVE_MAX_TIMEOUT_MS, undefined, 60000))
  );
  const headersTimeout = Math.max(
    1000,
    Math.floor(readNumber(process.env.LOAD_HTTP_HEADERS_TIMEOUT_MS, undefined, 30000))
  );
  const bodyTimeout = Math.max(
    1000,
    Math.floor(readNumber(process.env.LOAD_HTTP_BODY_TIMEOUT_MS, undefined, 30000))
  );

  if (!Number.isFinite(connections) || connections <= 0) {
    return;
  }

  setGlobalDispatcher(
    new Agent({
      connections,
      pipelining,
      keepAliveTimeout,
      keepAliveMaxTimeout,
      headersTimeout,
      bodyTimeout
    })
  );
}
