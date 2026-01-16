// Interactive performance test CLI with RPS + metrics coverage.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  buildForwardedIp,
  buildRunId,
  buildServiceHeaders,
  buildUserList,
  createAuction,
  formatStatusCounts,
  parseArgs,
  placeBid,
  readNumber,
  readText,
  resolveConfig,
  seedDeposits,
  sleep,
  timedJson,
  waitForRoundStatus
} from "./lib.js";
import {
  createMetricsSampler,
  runLoadTest,
  summarizeMetrics,
  timedFetch
} from "./perf-utils.js";

const PROFILES = {
  smoke: {
    durationMs: 5000,
    concurrency: 5,
    metricsIntervalMs: 1000,
    maxSamples: 20000
  },
  load: {
    durationMs: 30000,
    concurrency: 50,
    metricsIntervalMs: 2000,
    maxSamples: 100000
  },
  massive: {
    durationMs: 120000,
    concurrency: 200,
    metricsIntervalMs: 5000,
    maxSamples: 200000
  }
};

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  printUsage();
  process.exit(0);
}

const config = resolveConfig(args);
const runId = buildRunId(args);
const rawArgs = process.argv.slice(2);
let mode = readText(args.mode, process.env.PERF_MODE, "");
let interactiveOverrides = {};
let profileOverrides = {};

if (!mode) {
  const interactive = await runInteractive();
  mode = interactive.mode;
  interactiveOverrides = interactive.overrides;
  profileOverrides = interactive.profileOverrides;
}

const mergedArgs = { ...args, ...interactiveOverrides, ...profileOverrides };
const profile = resolveProfile(mergedArgs);
const outputPath = readText(mergedArgs.output, process.env.PERF_OUTPUT, "");
const metricsTimeoutMs = Math.max(
  1000,
  Math.floor(
    readNumber(
      readArg(mergedArgs, ["metrics-timeout", "metricsTimeout"]),
      process.env.PERF_METRICS_TIMEOUT_MS,
      10000
    )
  )
);
const verbose = Boolean(mergedArgs.verbose || mergedArgs["metrics-verbose"]);
const failOnError = Boolean(mergedArgs["fail-on-error"]);

const report = {
  runId,
  mode,
  startedAt: new Date().toISOString(),
  profile,
  config: {
    auctionUrl: config.auctionUrl,
    ledgerUrl: config.ledgerUrl,
    webUrl: config.webUrl,
    currency: config.currency
  },
  scenarios: []
};

if (mode === "all") {
  await runScenarioSequence([
    buildScenario("bid-rps", mergedArgs),
    buildScenario("auction-read", mergedArgs),
    buildScenario("ledger-deposits", mergedArgs),
    buildScenario("web-auctions", mergedArgs)
  ]);
} else if (mode === "suite" || isChildMode(mode)) {
  await runChildScenario(mode);
} else if (mode === "metrics") {
  await runScenario(buildMetricsScenario(mergedArgs));
} else {
  await runScenario(buildScenario(mode, mergedArgs));
}

report.finishedAt = new Date().toISOString();

if (outputPath) {
  await writeFile(outputPath, JSON.stringify(report, null, 2));
  console.log(`report written to ${outputPath}`);
}

if (failOnError) {
  const failed = report.scenarios.some(
    (scenario) => scenario.client?.statusCounts?.error > 0
  );
  if (failed) {
    process.exitCode = 1;
  }
}

async function runScenarioSequence(scenarios) {
  for (const scenario of scenarios) {
    await runScenario(scenario);
  }
}

async function runScenario(scenario) {
  if (!scenario) {
    throw new Error("Unknown scenario. Use --help for options.");
  }
  const startedAt = new Date().toISOString();
  const metricsTargets = scenario.metricsTargets ?? [];
  const sampler = createMetricsSampler({
    targets: metricsTargets,
    intervalMs: profile.metricsIntervalMs,
    timeoutMs: metricsTimeoutMs
  });
  await sampler.start();
  let client = null;
  let actionError = null;
  let metricsSnapshot = null;
  try {
    client = await scenario.action();
  } catch (error) {
    actionError = error;
  } finally {
    metricsSnapshot = await sampler.stop();
  }
  const metrics = buildMetricsReport(metricsSnapshot, metricsTargets);

  const scenarioReport = {
    name: scenario.name,
    description: scenario.description,
    startedAt,
    finishedAt: new Date().toISOString(),
    config: scenario.config ?? {},
    client,
    metrics,
    error: actionError ? { message: actionError.message ?? String(actionError) } : null
  };
  report.scenarios.push(scenarioReport);
  printScenarioSummary(scenarioReport, { verbose });
  if (actionError) {
    throw actionError;
  }
}

function buildScenario(modeName, args) {
  switch (modeName) {
    case "bid-rps":
      return buildBidRpsScenario(args);
    case "auction-read":
      return buildAuctionReadScenario(args);
    case "ledger-deposits":
      return buildLedgerDepositScenario(args);
    case "web-auctions":
      return buildWebAuctionsScenario(args);
    case "generic-rps":
      return buildGenericScenario(args);
    default:
      return null;
  }
}

function buildMetricsScenario(args) {
  const durationMs = profile.durationMs;
  return {
    name: "metrics",
    description: "Metrics-only sampling",
    metricsTargets: resolveMetricsTargets(
      readMetricsRaw(args),
      defaultMetricsTargets("all")
    ),
    config: { durationMs },
    action: async () => {
      await sleep(durationMs);
      return {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs
      };
    }
  };
}

function buildBidRpsScenario(args) {
  const userCount = Math.max(
    1,
    Math.floor(
      readNumber(
        readArg(args, ["users", "userCount"]),
        process.env.PERF_USERS,
        Math.max(50, profile.concurrency * 2)
      )
    )
  );
  const depositAmount = readNumber(
    readArg(args, ["deposit", "depositAmount"]),
    process.env.PERF_DEPOSIT,
    500
  );
  const baseBid = readNumber(
    readArg(args, ["baseBid", "base-bid"]),
    process.env.PERF_BASE_BID,
    20
  );
  const bidStep = readNumber(
    readArg(args, ["bidStep", "bid-step"]),
    process.env.PERF_BID_STEP,
    0.5
  );
  const userPrefix = readText(
    readArg(args, ["user-prefix", "userPrefix"]),
    process.env.PERF_USER_PREFIX,
    "perf"
  );
  const durationSeconds = Math.max(
    10,
    Math.ceil((profile.durationMs || 0) / 1000) + 10
  );
  const roundDurationSeconds = Math.max(
    30,
    Math.floor(
      readNumber(
        readArg(args, ["roundDuration", "round-duration"]),
        process.env.PERF_ROUND_DURATION,
        durationSeconds
      )
    )
  );
  const seedConcurrency = Math.max(
    1,
    Math.floor(
      readNumber(
        readArg(args, ["seedConcurrency", "seed-concurrency"]),
        process.env.PERF_SEED_CONCURRENCY,
        Math.min(profile.concurrency, 50)
      )
    )
  );

  return {
    name: "bid-rps",
    description: "Auction bid RPS + metrics under load",
    metricsTargets: resolveMetricsTargets(
      readMetricsRaw(args),
      defaultMetricsTargets("auction")
    ),
    config: {
      userCount,
      depositAmount,
      baseBid,
      bidStep,
      concurrency: profile.concurrency,
      durationMs: profile.durationMs
    },
    action: async () => {
      const { auctionId } = await createAuction({
        webUrl: config.webUrl,
        title: `Perf bids ${runId}`,
        currency: config.currency,
        rounds: 1,
        allocationSize: Math.max(1, Math.floor(userCount / 4)),
        roundDurationSeconds,
        startOffsetSeconds: 0,
        antiSniping: {
          triggerWindowSeconds: 10,
          extensionSeconds: 15,
          maxExtensions: 2
        }
      });

      await waitForRoundStatus({
        auctionUrl: config.auctionUrl,
        auctionId,
        roundIndex: 0,
        status: "live",
        timeoutMs: 30000,
        pollMs: 100,
        serviceToken: config.coreApiToken
      });

      const users = buildUserList({ prefix: userPrefix, runId, count: userCount });
      await seedDeposits({
        ledgerUrl: config.ledgerUrl,
        users,
        amount: depositAmount,
        currency: config.currency,
        concurrency: seedConcurrency,
        timeoutMs: config.timeoutMs,
        serviceToken: config.coreApiToken
      });

      const result = await runLoadTest({
        concurrency: profile.concurrency,
        durationMs: profile.durationMs,
        maxRequests: profile.maxRequests,
        maxSamples: profile.maxSamples,
        requestFactory: async (index, workerId, workerRequestIndex) => {
          const resolvedWorkerId = Number.isFinite(workerId) ? workerId : 0;
          const resolvedIndex = Number.isFinite(workerRequestIndex)
            ? workerRequestIndex
            : index;
          const userId = users[resolvedWorkerId % users.length];
          const amount = Math.round((baseBid + bidStep * resolvedIndex) * 100) / 100;
          return placeBid({
            auctionUrl: config.auctionUrl,
            auctionId,
            userId,
            amount,
            idempotencyKey: `perf-${runId}-${userId}-${index}-${randomUUID()}`,
            ip: buildForwardedIp(index),
            timeoutMs: config.timeoutMs,
            serviceToken: config.coreApiToken
          });
        }
      });

      return {
        ...result,
        meta: {
          auctionId,
          userCount
        }
      };
    }
  };
}

function buildAuctionReadScenario(args) {
  const durationSeconds = Math.max(
    10,
    Math.ceil((profile.durationMs || 0) / 1000) + 10
  );
  const roundDurationSeconds = Math.max(
    30,
    Math.floor(
      readNumber(
        readArg(args, ["roundDuration", "round-duration"]),
        process.env.PERF_ROUND_DURATION,
        durationSeconds
      )
    )
  );

  return {
    name: "auction-read",
    description: "Auction round state reads under load",
    metricsTargets: resolveMetricsTargets(
      readMetricsRaw(args),
      defaultMetricsTargets("auction-only")
    ),
    config: {
      concurrency: profile.concurrency,
      durationMs: profile.durationMs
    },
    action: async () => {
      const { auctionId } = await createAuction({
        webUrl: config.webUrl,
        title: `Perf reads ${runId}`,
        currency: config.currency,
        rounds: 1,
        allocationSize: 1,
        roundDurationSeconds,
        startOffsetSeconds: 0,
        antiSniping: {
          triggerWindowSeconds: 10,
          extensionSeconds: 15,
          maxExtensions: 2
        }
      });

      await waitForRoundStatus({
        auctionUrl: config.auctionUrl,
        auctionId,
        roundIndex: 0,
        status: "live",
        timeoutMs: 30000,
        pollMs: 100,
        serviceToken: config.coreApiToken
      });

      const result = await runLoadTest({
        concurrency: profile.concurrency,
        durationMs: profile.durationMs,
        maxRequests: profile.maxRequests,
        maxSamples: profile.maxSamples,
        requestFactory: async () =>
          timedJson(`${config.auctionUrl}/auctions/${auctionId}/rounds/0/state`, {
            timeoutMs: config.timeoutMs,
            headers: buildServiceHeaders(config.coreApiToken)
          })
      });

      return {
        ...result,
        meta: { auctionId }
      };
    }
  };
}

function buildLedgerDepositScenario(args) {
  const userCount = Math.max(
    1,
    Math.floor(
      readNumber(
        readArg(args, ["users", "userCount"]),
        process.env.PERF_USERS,
        Math.max(50, profile.concurrency * 2)
      )
    )
  );
  const depositAmount = readNumber(
    readArg(args, ["deposit", "depositAmount"]),
    process.env.PERF_DEPOSIT,
    250
  );
  const userPrefix = readText(
    readArg(args, ["user-prefix", "userPrefix"]),
    process.env.PERF_USER_PREFIX,
    "perf"
  );

  return {
    name: "ledger-deposits",
    description: "Ledger deposit entry RPS under load",
    metricsTargets: resolveMetricsTargets(
      readMetricsRaw(args),
      defaultMetricsTargets("ledger")
    ),
    config: {
      userCount,
      depositAmount,
      concurrency: profile.concurrency,
      durationMs: profile.durationMs
    },
    action: async () => {
      const users = buildUserList({ prefix: userPrefix, runId, count: userCount });
      const result = await runLoadTest({
        concurrency: profile.concurrency,
        durationMs: profile.durationMs,
        maxRequests: profile.maxRequests,
        maxSamples: profile.maxSamples,
        requestFactory: async (index) => {
          const userId = users[index % users.length];
          const payload = {
            userId,
            amount: depositAmount,
            currency: config.currency,
            idempotencyKey: `perf-deposit-${runId}-${userId}-${index}-${randomUUID()}`,
            entryType: "deposit_confirmed"
          };
          return timedJson(`${config.ledgerUrl}/ledger/entries`, {
            method: "POST",
            body: payload,
            timeoutMs: config.timeoutMs,
            headers: buildServiceHeaders(config.coreApiToken)
          });
        }
      });

      return {
        ...result,
        meta: {
          userCount
        }
      };
    }
  };
}

function buildWebAuctionsScenario(args) {
  const limit = Math.max(
    1,
    Math.floor(
      readNumber(
        readArg(args, ["limit"]),
        process.env.PERF_LIST_LIMIT,
        20
      )
    )
  );
  const status = readText(readArg(args, ["status"]), process.env.PERF_LIST_STATUS, "active");

  return {
    name: "web-auctions",
    description: "Web auction list RPS under load",
    metricsTargets: resolveMetricsTargets(
      readMetricsRaw(args),
      defaultMetricsTargets("web")
    ),
    config: {
      status,
      limit,
      concurrency: profile.concurrency,
      durationMs: profile.durationMs
    },
    action: async () => {
      const url = `${config.webUrl}/api/auctions?status=${encodeURIComponent(
        status
      )}&limit=${encodeURIComponent(String(limit))}`;
      return runLoadTest({
        concurrency: profile.concurrency,
        durationMs: profile.durationMs,
        maxRequests: profile.maxRequests,
        maxSamples: profile.maxSamples,
        requestFactory: async () =>
          timedFetch(url, { timeoutMs: config.timeoutMs })
      });
    }
  };
}

function buildGenericScenario(args) {
  const targetUrl = readText(
    readArg(args, ["url", "target", "target-url"]),
    process.env.PERF_TARGET_URL,
    ""
  );
  if (!targetUrl) {
    throw new Error("generic-rps requires --url=<target>");
  }
  const method = readText(
    readArg(args, ["method"]),
    process.env.PERF_METHOD,
    "GET"
  ).toUpperCase();
  const bodyRaw = readText(readArg(args, ["body"]), process.env.PERF_BODY, "");
  const headers = parseHeaders(readText(readArg(args, ["headers", "header"]), "", ""));
  const jsonMode = Boolean(args.json || args["body-json"]);
  let body = bodyRaw;
  if (bodyRaw && jsonMode) {
    body = JSON.stringify(JSON.parse(bodyRaw));
    headers["content-type"] = "application/json";
  }

  return {
    name: "generic-rps",
    description: "Generic HTTP RPS under load",
    metricsTargets: resolveMetricsTargets(
      readMetricsRaw(args),
      defaultMetricsTargetsFromUrl(targetUrl)
    ),
    config: {
      targetUrl,
      method,
      concurrency: profile.concurrency,
      durationMs: profile.durationMs
    },
    action: async () =>
      runLoadTest({
        concurrency: profile.concurrency,
        durationMs: profile.durationMs,
        maxRequests: profile.maxRequests,
        maxSamples: profile.maxSamples,
        requestFactory: async () =>
          timedFetch(targetUrl, {
            method,
            headers,
            body: body || undefined,
            timeoutMs: config.timeoutMs
          })
      })
  };
}

async function runChildScenario(modeName) {
  const script = resolveChildScript(modeName);
  const metricsTargets = resolveMetricsTargets(
    readMetricsRaw(mergedArgs),
    defaultMetricsTargets("all")
  );
  const sampler = createMetricsSampler({
    targets: metricsTargets,
    intervalMs: profile.metricsIntervalMs,
    timeoutMs: metricsTimeoutMs
  });

  await sampler.start();
  let exitCode = 1;
  let metricsSnapshot = null;
  try {
    exitCode = await runChildScript(script, filterChildArgs(rawArgs));
  } finally {
    metricsSnapshot = await sampler.stop();
  }

  const scenarioReport = {
    name: modeName,
    description: `Child load script: ${script}`,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    config: {},
    client: { exitCode },
    metrics: buildMetricsReport(metricsSnapshot, metricsTargets)
  };
  report.scenarios.push(scenarioReport);
  printScenarioSummary(scenarioReport, { verbose });
}

function buildMetricsReport(metricsSnapshot, targets) {
  if (!metricsSnapshot || !targets.length) {
    return null;
  }
  const targetReports = targets.map((target) => {
    const start = metricsSnapshot.startSnapshots.get(target.name);
    const end = metricsSnapshot.endSnapshots.get(target.name);
    const gaugeStats = metricsSnapshot.gaugeStatsByTarget.get(target.name);
    const summary = summarizeMetrics({ start, end, gaugeStats });
    return {
      name: target.name,
      url: target.url,
      summary
    };
  });

  return {
    targets: targetReports,
    errors: metricsSnapshot.errors
  };
}

function resolveProfile(args) {
  const profileName = readText(
    readArg(args, ["profile"]),
    process.env.PERF_PROFILE,
    "load"
  );
  const base = PROFILES[profileName] ?? PROFILES.load;
  const durationMs = Math.max(
    0,
    Math.floor(
      readNumber(
        readArg(args, ["duration", "durationMs", "duration-ms"]),
        process.env.PERF_DURATION_MS,
        base.durationMs
      )
    )
  );
  const concurrency = Math.max(
    1,
    Math.floor(
      readNumber(
        readArg(args, ["concurrency"]),
        process.env.PERF_CONCURRENCY,
        base.concurrency
      )
    )
  );
  const metricsIntervalMs = Math.max(
    250,
    Math.floor(
      readNumber(
        readArg(args, ["metrics-interval", "metricsInterval"]),
        process.env.PERF_METRICS_INTERVAL_MS,
        base.metricsIntervalMs
      )
    )
  );
  const maxSamples = Math.max(
    1000,
    Math.floor(
      readNumber(
        readArg(args, ["max-samples", "maxSamples"]),
        process.env.PERF_MAX_SAMPLES,
        base.maxSamples
      )
    )
  );
  const maxRequests = Math.max(
    0,
    Math.floor(
      readNumber(
        readArg(args, ["requests", "maxRequests"]),
        process.env.PERF_REQUESTS,
        0
      )
    )
  );
  return {
    name: profileName,
    durationMs,
    concurrency,
    metricsIntervalMs,
    maxSamples,
    maxRequests
  };
}

function resolveMetricsTargets(raw, defaults) {
  const resolvedDefaults = Array.isArray(defaults) ? defaults : [];
  if (typeof raw === "string") {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === "none" || trimmed === "off" || trimmed === "false") {
      return [];
    }
  }
  const entries = raw
    ? raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : resolvedDefaults;
  return entries.map((entry) => {
    if (typeof entry === "object") {
      return entry;
    }
    const [maybeName, maybeUrl] = entry.split("=");
    const url = maybeUrl ? maybeUrl : entry;
    const name = maybeUrl ? maybeName : inferTargetName(url);
    return {
      name,
      url: normalizeMetricsUrl(url)
    };
  });
}

function defaultMetricsTargets(modeName) {
  switch (modeName) {
    case "auction":
      return [
        { name: "auction-engine", url: normalizeMetricsUrl(config.auctionUrl) },
        { name: "ledger", url: normalizeMetricsUrl(config.ledgerUrl) },
        { name: "web", url: normalizeMetricsUrl(config.webUrl) }
      ];
    case "auction-only":
      return [{ name: "auction-engine", url: normalizeMetricsUrl(config.auctionUrl) }];
    case "ledger":
      return [{ name: "ledger", url: normalizeMetricsUrl(config.ledgerUrl) }];
    case "web":
      return [{ name: "web", url: normalizeMetricsUrl(config.webUrl) }];
    default:
      return [
        { name: "auction-engine", url: normalizeMetricsUrl(config.auctionUrl) },
        { name: "ledger", url: normalizeMetricsUrl(config.ledgerUrl) },
        { name: "web", url: normalizeMetricsUrl(config.webUrl) }
      ];
  }
}

function defaultMetricsTargetsFromUrl(targetUrl) {
  return [{ name: inferTargetName(targetUrl), url: normalizeMetricsUrl(targetUrl) }];
}

function normalizeMetricsUrl(raw) {
  const parsed = new URL(raw);
  if (parsed.pathname.endsWith("/metrics")) {
    return parsed.toString();
  }
  return `${parsed.origin}/metrics`;
}

function inferTargetName(raw) {
  try {
    const parsed = new URL(raw);
    return parsed.host || parsed.hostname || "metrics";
  } catch {
    return "metrics";
  }
}

function parseHeaders(raw) {
  if (!raw) {
    return {};
  }
  return raw.split(",").reduce((headers, entry) => {
    const [key, ...rest] = entry.split(":");
    if (!key) {
      return headers;
    }
    headers[key.trim()] = rest.join(":").trim();
    return headers;
  }, {});
}

function formatMetricLabels(labels) {
  const entries = Object.entries(labels ?? {});
  if (!entries.length) {
    return "";
  }
  return entries.map(([key, value]) => `${key}=${value}`).join(" ");
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(digits);
}

function printScenarioSummary(scenario, { verbose }) {
  console.log(`\n=== ${scenario.name} ===`);
  if (scenario.description) {
    console.log(scenario.description);
  }
  if (scenario.error?.message) {
    console.log(`error: ${scenario.error.message}`);
  }
  if (scenario.client?.exitCode !== undefined) {
    console.log(`exit code: ${scenario.client.exitCode}`);
  }
  if (scenario.client?.completed !== undefined) {
    const { completed, attempted, durationMs, rps, peakRps, latency, statusCounts } =
      scenario.client;
    console.log(
      `requests: completed=${completed} attempted=${attempted} duration=${formatNumber(
        durationMs,
        0
      )}ms rps=${formatNumber(rps)} peakRps=${formatNumber(peakRps)}`
    );
    if (latency) {
      console.log(
        `latency: count=${latency.count} min=${formatNumber(
          latency.min
        )}ms mean=${formatNumber(latency.mean)}ms p50=${formatNumber(
          latency.p50
        )}ms p95=${formatNumber(latency.p95)}ms p99=${formatNumber(
          latency.p99
        )}ms max=${formatNumber(latency.max)}ms samples=${latency.sampleCount}`
      );
    }
    if (statusCounts) {
      console.log(`status: ${JSON.stringify(formatStatusCounts(statusCounts))}`);
    }
  }

  if (scenario.metrics?.targets?.length) {
    for (const target of scenario.metrics.targets) {
      console.log(`metrics: ${target.name} (${target.url})`);
      if (!target.summary) {
        console.log("metrics: no summary available");
        continue;
      }
      printMetricsSummary(target.summary, { verbose });
    }
    if (scenario.metrics.errors?.length) {
      console.log(`metrics errors: ${scenario.metrics.errors.length}`);
    }
  }
}

function printMetricsSummary(summary, { verbose }) {
  const { counters = [], histograms = [], gauges = [] } = summary;
  const httpCounters = counters
    .filter((entry) => entry.name === "http_requests_total")
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 12);
  if (httpCounters.length) {
    console.log("http_requests_total:");
    for (const entry of httpCounters) {
      console.log(
        `  ${formatMetricLabels(entry.labels)} delta=${formatNumber(entry.delta, 0)}`
      );
    }
  }

  const httpHist = histograms.filter(
    (entry) => entry.name === "http_request_duration_seconds"
  );
  if (httpHist.length) {
    console.log("http_request_duration_seconds:");
    for (const entry of httpHist) {
      console.log(
        `  ${formatMetricLabels(entry.labels)} count=${formatNumber(
          entry.count,
          0
        )} mean=${formatNumber(entry.mean)} p95=${formatNumber(
          entry.p95
        )} p99=${formatNumber(entry.p99)}`
      );
    }
  }

  const keyGauges = gauges.filter((entry) =>
    ["http_requests_in_flight", "process_resident_memory_bytes"].includes(entry.name) ||
    entry.name.startsWith("nodejs_eventloop_lag")
  );
  if (keyGauges.length) {
    console.log("gauges:");
    for (const entry of keyGauges) {
      console.log(
        `  ${entry.name} ${formatMetricLabels(entry.labels)} min=${formatNumber(
          entry.min
        )} max=${formatNumber(entry.max)} mean=${formatNumber(entry.mean)}`
      );
    }
  }

  if (!verbose) {
    return;
  }

  if (counters.length) {
    console.log("counters:");
    for (const entry of counters) {
      console.log(
        `  ${entry.name} ${formatMetricLabels(entry.labels)} delta=${formatNumber(
          entry.delta,
          0
        )}`
      );
    }
  }

  if (histograms.length) {
    console.log("histograms:");
    for (const entry of histograms) {
      console.log(
        `  ${entry.name} ${formatMetricLabels(entry.labels)} count=${formatNumber(
          entry.count,
          0
        )} mean=${formatNumber(entry.mean)} p50=${formatNumber(
          entry.p50
        )} p95=${formatNumber(entry.p95)} p99=${formatNumber(entry.p99)}`
      );
    }
  }

  if (gauges.length) {
    console.log("all gauges:");
    for (const entry of gauges) {
      console.log(
        `  ${entry.name} ${formatMetricLabels(entry.labels)} min=${formatNumber(
          entry.min
        )} max=${formatNumber(entry.max)} mean=${formatNumber(entry.mean)}`
      );
    }
  }
}

function resolveChildScript(modeName) {
  const scripts = {
    suite: "suite.js",
    "bot-sim": "bot-sim.js",
    "stress-bids": "stress-bids.js",
    "anti-sniping": "anti-sniping.js",
    reconcile: "reconcile.js"
  };
  return scripts[modeName] ?? scripts.suite;
}

function isChildMode(modeName) {
  return ["bot-sim", "stress-bids", "anti-sniping", "reconcile"].includes(modeName);
}

async function runChildScript(script, args) {
  const scriptUrl = new URL(`./${script}`, import.meta.url);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptUrl.pathname, ...args], {
      stdio: "inherit",
      env: process.env
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });
}

function filterChildArgs(rawArgs) {
  return rawArgs.filter(
    (arg) =>
      !arg.startsWith("--mode") &&
      !arg.startsWith("--output") &&
      !arg.startsWith("--profile") &&
      !arg.startsWith("--metrics") &&
      !arg.startsWith("--metrics-interval") &&
      !arg.startsWith("--metrics-timeout") &&
      !arg.startsWith("--max-samples") &&
      !arg.startsWith("--fail-on-error") &&
      !arg.startsWith("--verbose")
  );
}

async function runInteractive() {
  const rl = createInterface({ input, output });
  try {
    console.log("Performance test CLI");
    console.log("1) Auction bids RPS + metrics");
    console.log("2) Auction reads RPS + metrics");
    console.log("3) Ledger deposits RPS + metrics");
    console.log("4) Web auctions list RPS + metrics");
    console.log("5) Generic HTTP RPS");
    console.log("6) Metrics sampling only");
    console.log("7) Existing load suite");
    console.log("q) Quit");
    const choice = (await rl.question("Select test: ")).trim().toLowerCase();
    if (choice === "q") {
      process.exit(0);
    }
    const mode = {
      "1": "bid-rps",
      "2": "auction-read",
      "3": "ledger-deposits",
      "4": "web-auctions",
      "5": "generic-rps",
      "6": "metrics",
      "7": "suite"
    }[choice];
    if (!mode) {
      throw new Error("Unknown selection.");
    }

    const profileName = (
      await rl.question("Profile (smoke/load/massive/custom) [load]: ")
    )
      .trim()
      .toLowerCase();
    const overrides = {};
    const profileOverrides = {};
    if (profileName) {
      profileOverrides.profile = profileName;
    }

    if (profileName === "custom") {
      profileOverrides["duration"] = await askNumber(rl, "Duration seconds", 30);
      profileOverrides["duration"] = Number(profileOverrides["duration"]) * 1000;
      profileOverrides["concurrency"] = await askNumber(rl, "Concurrency", 50);
      profileOverrides["requests"] = await askNumber(rl, "Max requests (0=unlimited)", 0);
      profileOverrides["metrics-interval"] = await askNumber(
        rl,
        "Metrics interval seconds",
        2
      );
      profileOverrides["metrics-interval"] =
        Number(profileOverrides["metrics-interval"]) * 1000;
      profileOverrides["max-samples"] = await askNumber(
        rl,
        "Max latency samples",
        100000
      );
    }

    if (mode === "generic-rps") {
      overrides.url = (await rl.question("Target URL: ")).trim();
      overrides.method = (await rl.question("HTTP method [GET]: ")).trim() || "GET";
    }

    return { mode, overrides, profileOverrides };
  } finally {
    rl.close();
  }
}

async function askNumber(rl, label, fallback) {
  const answer = (await rl.question(`${label} [${fallback}]: `)).trim();
  if (!answer) {
    return fallback;
  }
  const value = Number(answer);
  return Number.isFinite(value) ? value : fallback;
}

function readArg(args, keys) {
  for (const key of keys) {
    if (args[key] !== undefined) {
      return args[key];
    }
  }
  return undefined;
}

function readMetricsRaw(args) {
  return readText(
    readArg(args, ["metrics", "metrics-url", "metricsUrl"]),
    process.env.PERF_METRICS,
    ""
  );
}

function printUsage() {
  console.log(`Usage: node scripts/load/perf-cli.js [options]

Modes:
  --mode=bid-rps         Auction bid load + metrics
  --mode=auction-read    Auction round read load + metrics
  --mode=ledger-deposits Ledger deposit load + metrics
  --mode=web-auctions    Web auctions list load + metrics
  --mode=generic-rps     Generic HTTP load + metrics
  --mode=metrics         Metrics-only sampling
  --mode=suite           Run existing load suite
  --mode=all             Run all built-in scenarios

Profiles:
  --profile=smoke|load|massive

Common options:
  --duration=ms          Duration in milliseconds
  --concurrency=n        Concurrent workers
  --requests=n           Max requests (0=unlimited)
  --metrics=<urls>       Comma-separated metrics URLs or name=url entries
  --metrics-interval=ms  Metrics sampling interval
  --metrics-timeout=ms   Metrics request timeout
  --max-samples=n        Max latency samples to keep
  --output=path          Write JSON report
  --fail-on-error        Exit non-zero if any errors
  --verbose              Print full metrics details

Generic mode:
  --url=<target>         Target URL
  --method=GET|POST      HTTP method
  --body='{}'            Request body
  --json                 Treat body as JSON
  --headers=key:val,...  Extra headers
`);
}
