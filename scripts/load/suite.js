// Load test suite runner.
import { spawn } from "node:child_process";

const scripts = ["bot-sim.js", "stress-bids.js", "anti-sniping.js", "reconcile.js"];
const args = process.argv.slice(2);
const results = [];

for (const script of scripts) {
  console.log(`running ${script}`);
  const result = await runScript(script, args);
  const summary = parseSummary(script, result.output);
  results.push({ script, code: result.code, summary, durationMs: result.durationMs });
  if (result.code !== 0) {
    printSummary(results);
    process.exit(result.code ?? 1);
  }
}

printSummary(results);

async function runScript(script, args) {
  const scriptUrl = new URL(`./${script}`, import.meta.url);
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const child = spawn(process.execPath, [scriptUrl.pathname, ...args], {
      stdio: ["inherit", "pipe", "pipe"],
      env: process.env
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      resolve({ code: code ?? 0, output, durationMs });
    });
  });
}

function parseSummary(script, output) {
  switch (script) {
    case "bot-sim.js":
      return parseLoadResult(output, "Bot simulation");
    case "stress-bids.js":
      return parseLoadResult(output, "Stress bids");
    case "anti-sniping.js":
      return parseAntiSnipingResult(output);
    case "reconcile.js":
      return parseReconcileResult(output);
    default:
      return { title: script, lines: [] };
  }
}

function parseLoadResult(output, title) {
  const lines = [];
  const auctionId = extractAuctionId(output);
  const statsText = extractStatsText(output);
  const stats = parseStatsText(statsText);
  const status = parseStatusCounts(output);
  const loadDurationMs = extractLoadDurationMs(output);
  if (auctionId) {
    lines.push(`auctionId: ${auctionId}`);
  }
  if (stats?.count) {
    lines.push(`requests: ${stats.count}`);
  }
  const latency = formatLatency(stats);
  if (latency) {
    lines.push(`latency: ${latency}`);
  }
  const statusLine = formatStatusCounts(status);
  if (statusLine) {
    lines.push(`status: ${statusLine}`);
  }
  return { title, lines, stats, status, loadDurationMs };
}

function parseAntiSnipingResult(output) {
  const lines = [];
  const auctionId = extractAuctionId(output);
  const statsText = extractStatsText(output);
  const stats = parseStatsText(statsText);
  const loadDurationMs = extractLoadDurationMs(output);
  if (auctionId) {
    lines.push(`auctionId: ${auctionId}`);
  }
  const extensionParts = [];
  const extended = extractLastMatch(output, /extended:\s(\w+)/);
  const extensionCount = extractLastMatch(output, /extensionCount:\s(\d+)/);
  const extensionMs = extractLastMatch(output, /extensionMs:\s(\d+)/);
  if (extended) {
    extensionParts.push(`extended ${extended}`);
  }
  if (extensionCount) {
    extensionParts.push(`count ${extensionCount}`);
  }
  if (extensionMs) {
    extensionParts.push(`ms ${extensionMs}`);
  }
  if (extensionParts.length > 0) {
    lines.push(`extension: ${extensionParts.join(", ")}`);
  }
  if (stats?.count) {
    lines.push(`requests: ${stats.count}`);
  }
  const latency = formatLatency(stats);
  if (latency) {
    lines.push(`latency: ${latency}`);
  }
  return { title: "Anti-sniping", lines, stats, loadDurationMs };
}

function parseReconcileResult(output) {
  const lines = [];
  const statsText = extractStatsText(output);
  const stats = parseStatsText(statsText);
  const loadDurationMs = extractLoadDurationMs(output);
  if (stats?.count) {
    lines.push(`requests: ${stats.count}`);
  }
  const latency = formatLatency(stats);
  if (latency) {
    lines.push(`latency: ${latency}`);
  }
  const issueCount = extractLastMatch(output, /issueCount:\s(\d+)/);
  if (issueCount) {
    lines.push(`issues: ${issueCount}`);
  }
  return { title: "Reconcile", lines, stats, loadDurationMs };
}

function extractLastMatch(output, regex, group = 1) {
  if (!output) {
    return null;
  }
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  const pattern = new RegExp(regex.source, flags);
  let match;
  let last = null;
  while ((match = pattern.exec(output)) !== null) {
    last = match[group];
  }
  return last;
}

function extractAuctionId(output) {
  return extractLastMatch(output, /auctionId:\s'([^']+)'/);
}

function extractStatsText(output) {
  return extractLastMatch(output, /stats:\s'([^']+)'/);
}

function extractLoadDurationMs(output) {
  const value = extractLastMatch(output, /loadDurationMs:\s(\d+)/);
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseStatsText(text) {
  if (!text) {
    return null;
  }
  const read = (key) => {
    const match = text.match(new RegExp(`${key}=([0-9.]+)(ms)?`));
    if (!match) {
      return null;
    }
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  };
  return {
    count: read("count"),
    min: read("min"),
    mean: read("mean"),
    p50: read("p50"),
    p95: read("p95"),
    p99: read("p99"),
    max: read("max")
  };
}

function formatLatency(stats) {
  if (!stats) {
    return null;
  }
  const parts = [];
  if (stats.min !== null) parts.push(`min ${formatMs(stats.min)}`);
  if (stats.p50 !== null) parts.push(`p50 ${formatMs(stats.p50)}`);
  if (stats.mean !== null) parts.push(`mean ${formatMs(stats.mean)}`);
  if (stats.p95 !== null) parts.push(`p95 ${formatMs(stats.p95)}`);
  if (stats.p99 !== null) parts.push(`p99 ${formatMs(stats.p99)}`);
  if (stats.max !== null) parts.push(`max ${formatMs(stats.max)}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

function parseStatusCounts(output) {
  if (!output) {
    return null;
  }
  const statusPattern =
    /status:\s\{\s*ok:\s(\d+),\s*error:\s(\d+)(?:,\s*byStatus:\s\{([^}]+)\})?\s*\}/gs;
  let match;
  let last = null;
  while ((match = statusPattern.exec(output)) !== null) {
    last = match;
  }
  if (!last) {
    return null;
  }
  const status = {
    ok: Number(last[1]),
    error: Number(last[2]),
    byStatus: {}
  };
  if (last[3]) {
    const entries = last[3].split(",");
    for (const entry of entries) {
      const item = entry.match(/['"]?(\d{3})['"]?:\s*(\d+)/);
      if (item) {
        status.byStatus[item[1]] = Number(item[2]);
      }
    }
  }
  return status;
}

function formatStatusCounts(status) {
  if (!status) {
    return null;
  }
  const parts = [];
  if (status.ok !== null) parts.push(`ok ${status.ok}`);
  if (status.error !== null) parts.push(`error ${status.error}`);
  const keys = Object.keys(status.byStatus ?? {}).sort();
  if (keys.length > 0) {
    const byStatus = keys.map((code) => `${code}=${status.byStatus[code]}`).join(", ");
    parts.push(`byStatus ${byStatus}`);
  }
  return parts.join(", ");
}

function printSummary(results) {
  console.log("\n=== Load Suite Summary ===");
  for (const result of results) {
    const title = result.summary?.title ?? result.script;
    console.log(`\n${title}`);
    const lines = [];
    if (result.code !== 0) {
      lines.push(`status: failed (exit code ${result.code})`);
    }
    const loadDuration = formatDuration(result.summary?.loadDurationMs);
    if (loadDuration) {
      lines.push(`loadDuration: ${loadDuration}`);
    }
    const duration = formatDuration(result.durationMs);
    if (duration) {
      lines.push(`duration: ${duration}`);
    }
    const rpsDurationMs = result.summary?.loadDurationMs ?? result.durationMs;
    const rps = formatRps(result.summary?.stats?.count, rpsDurationMs);
    if (rps) {
      lines.push(`rps: ${rps}`);
    }
    if (result.summary?.lines?.length) {
      lines.push(...result.summary.lines);
    }
    if (lines.length === 0) {
      lines.push("status: no summary parsed");
    }
    for (const line of lines) {
      console.log(`- ${line}`);
    }
  }

  const overall = buildOverallSummary(results);
  if (overall) {
    console.log("\nOverall");
    const lines = [];
    const duration = formatDuration(overall.durationMs);
    if (duration) {
      lines.push(`duration: ${duration}`);
    }
    const loadDuration = formatDuration(overall.loadDurationMs);
    if (loadDuration) {
      lines.push(`loadDuration: ${loadDuration}`);
    }
    if (Number.isFinite(overall.count)) {
      lines.push(`requests: ${overall.count}`);
    }
    const rps = formatRps(
      overall.count,
      overall.loadDurationMs ?? overall.durationMs
    );
    if (rps) {
      lines.push(`rps: ${rps}`);
    }
    const latency = formatOverallLatency(overall);
    if (latency) {
      lines.push(`latency: ${latency}`);
    }
    const statusLine = formatStatusCounts(overall.status);
    if (statusLine) {
      lines.push(`status: ${statusLine}`);
    }
    for (const line of lines) {
      console.log(`- ${line}`);
    }
  }
}

function buildOverallSummary(results) {
  if (!results.length) {
    return null;
  }
  let durationMs = 0;
  let loadDurationMs = 0;
  let hasLoadDuration = false;
  let count = 0;
  let meanTotal = 0;
  let min = null;
  let max = null;
  const status = { ok: 0, error: 0, byStatus: {} };

  for (const result of results) {
    if (Number.isFinite(result.durationMs)) {
      durationMs += result.durationMs;
    }
    const loadDuration = result.summary?.loadDurationMs;
    if (Number.isFinite(loadDuration)) {
      loadDurationMs += loadDuration;
      hasLoadDuration = true;
    } else if (Number.isFinite(result.durationMs)) {
      loadDurationMs += result.durationMs;
    }
    const stats = result.summary?.stats;
    if (stats?.count) {
      count += stats.count;
      if (Number.isFinite(stats.mean)) {
        meanTotal += stats.mean * stats.count;
      }
      if (Number.isFinite(stats.min)) {
        min = min === null ? stats.min : Math.min(min, stats.min);
      }
      if (Number.isFinite(stats.max)) {
        max = max === null ? stats.max : Math.max(max, stats.max);
      }
    }
    const statusEntry = result.summary?.status;
    if (statusEntry) {
      status.ok += statusEntry.ok ?? 0;
      status.error += statusEntry.error ?? 0;
      for (const [code, value] of Object.entries(statusEntry.byStatus ?? {})) {
        status.byStatus[code] = (status.byStatus[code] ?? 0) + value;
      }
    }
  }

  const mean = count > 0 ? meanTotal / count : null;
  return {
    durationMs,
    loadDurationMs: hasLoadDuration ? loadDurationMs : null,
    count,
    mean,
    min,
    max,
    status: Object.keys(status.byStatus).length > 0 || count > 0 ? status : null
  };
}

function formatOverallLatency(overall) {
  if (!overall) {
    return null;
  }
  const parts = [];
  if (Number.isFinite(overall.mean)) {
    parts.push(`mean ${formatMs(overall.mean)}`);
  }
  if (Number.isFinite(overall.min)) {
    parts.push(`min ${formatMs(overall.min)}`);
  }
  if (Number.isFinite(overall.max)) {
    parts.push(`max ${formatMs(overall.max)}`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

function formatMs(value) {
  return `${value.toFixed(2)}ms`;
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs)) {
    return null;
  }
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }
  const seconds = durationMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(2)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${minutes}m ${remainder.toFixed(1)}s`;
}

function formatRps(count, durationMs) {
  if (!Number.isFinite(count) || !Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }
  const rps = count / (durationMs / 1000);
  return `${rps.toFixed(2)} req/s`;
}
