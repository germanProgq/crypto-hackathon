// Performance test helpers: load runner + Prometheus metrics parsing.
import { performance } from "node:perf_hooks";
import { buildStatusCounts, computeStats, recordStatus } from "./lib.js";

const DEFAULT_MAX_SAMPLES = 200000;

export function createLatencyTracker({ maxSamples = DEFAULT_MAX_SAMPLES } = {}) {
  let count = 0;
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const samples = [];

  return {
    record(value) {
      if (!Number.isFinite(value)) {
        return;
      }
      count += 1;
      sum += value;
      if (value < min) {
        min = value;
      }
      if (value > max) {
        max = value;
      }

      if (samples.length < maxSamples) {
        samples.push(value);
      } else {
        const index = Math.floor(Math.random() * count);
        if (index < maxSamples) {
          samples[index] = value;
        }
      }
    },
    summary() {
      if (!count) {
        return null;
      }
      const sampleStats = samples.length > 0 ? computeStats(samples) : null;
      return {
        count,
        min: Number.isFinite(min) ? min : 0,
        max: Number.isFinite(max) ? max : 0,
        mean: sum / count,
        p50: sampleStats?.p50 ?? 0,
        p95: sampleStats?.p95 ?? 0,
        p99: sampleStats?.p99 ?? 0,
        sampleCount: samples.length
      };
    }
  };
}

export async function timedFetch(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = 10000
  } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal
    });
    const durationMs = performance.now() - start;
    if (response.body && typeof response.body.cancel === "function") {
      await response.body.cancel();
    }
    return {
      ok: response.ok,
      status: response.status,
      durationMs
    };
  } catch (error) {
    const durationMs = performance.now() - start;
    return { ok: false, status: "error", durationMs, error };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runLoadTest({
  concurrency,
  durationMs,
  maxRequests,
  requestFactory,
  maxSamples = DEFAULT_MAX_SAMPLES
}) {
  const statusCounts = buildStatusCounts();
  const latency = createLatencyTracker({ maxSamples });
  const rpsBuckets = [];
  let started = 0;
  let completed = 0;
  const startWall = Date.now();
  const start = performance.now();
  const endTime = durationMs ? start + durationMs : null;
  const requestLimit = maxRequests && maxRequests > 0 ? maxRequests : null;

  function shouldStop() {
    if (endTime && performance.now() >= endTime) {
      return true;
    }
    if (requestLimit && started >= requestLimit) {
      return true;
    }
    return false;
  }

  function recordRps() {
    const bucket = Math.floor((Date.now() - startWall) / 1000);
    rpsBuckets[bucket] = (rpsBuckets[bucket] ?? 0) + 1;
  }

  async function worker(workerId) {
    let workerRequestIndex = 0;
    while (!shouldStop()) {
      if (requestLimit && started >= requestLimit) {
        break;
      }
      const index = started;
      started += 1;
      let response;
      try {
        response = await requestFactory(index, workerId, workerRequestIndex);
      } catch (error) {
        response = { ok: false, status: "error", error };
      }
      if (typeof response?.durationMs === "number") {
        latency.record(response.durationMs);
      }
      recordStatus(statusCounts, response);
      recordRps();
      completed += 1;
      workerRequestIndex += 1;
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, (_, workerId) =>
    worker(workerId)
  );
  await Promise.all(workers);

  const elapsedMs = performance.now() - start;
  const rps = elapsedMs > 0 ? completed / (elapsedMs / 1000) : 0;
  const peakRps = rpsBuckets.length ? Math.max(...rpsBuckets.filter(Boolean)) : 0;

  return {
    startedAt: new Date(startWall).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: elapsedMs,
    attempted: started,
    completed,
    rps,
    peakRps,
    rpsSeries: rpsBuckets.map((count, index) => ({
      second: index,
      count: count ?? 0
    })),
    latency: latency.summary(),
    statusCounts
  };
}

export function parsePrometheus(text) {
  const types = new Map();
  const helps = new Map();
  const samples = new Map();
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    if (!line) {
      continue;
    }
    if (line.startsWith("# HELP ")) {
      const rest = line.slice(7);
      const spaceIndex = rest.indexOf(" ");
      if (spaceIndex !== -1) {
        const name = rest.slice(0, spaceIndex).trim();
        const help = rest.slice(spaceIndex + 1).trim();
        if (name) {
          helps.set(name, help);
        }
      }
      continue;
    }
    if (line.startsWith("# TYPE ")) {
      const rest = line.slice(7);
      const [name, type] = rest.split(/\s+/);
      if (name && type) {
        types.set(name.trim(), type.trim());
      }
      continue;
    }
    if (line.startsWith("#")) {
      continue;
    }

    const match = line.match(
      /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[+-]?(?:Inf|Infinity)|NaN)(?:\s+[-+]?\d+)?$/
    );
    if (!match) {
      continue;
    }
    const name = match[1];
    const labelRaw = match[3];
    const valueRaw = match[4];
    const labels = labelRaw ? parseLabelString(labelRaw) : {};
    const value = parsePromValue(valueRaw);
    if (!Number.isFinite(value)) {
      continue;
    }
    if (!samples.has(name)) {
      samples.set(name, []);
    }
    samples.get(name).push({ labels, value });
  }

  return { types, helps, samples };
}

export function buildSeriesKey(name, labels) {
  const keys = Object.keys(labels ?? {}).sort();
  if (!keys.length) {
    return name;
  }
  const labelKey = keys.map((key) => `${key}=${labels[key]}`).join(",");
  return `${name}{${labelKey}}`;
}

export function getMetricType(types, sampleName) {
  if (!types) {
    return undefined;
  }
  if (types.has(sampleName)) {
    return types.get(sampleName);
  }
  const suffixMatch = sampleName.match(/^(.*)_(bucket|sum|count)$/);
  if (suffixMatch) {
    const base = suffixMatch[1];
    if (types.has(base)) {
      return types.get(base);
    }
  }
  return undefined;
}

export function snapshotToSeries(snapshot) {
  const series = new Map();
  if (!snapshot) {
    return series;
  }
  for (const [name, entries] of snapshot.samples) {
    for (const entry of entries) {
      const key = buildSeriesKey(name, entry.labels);
      series.set(key, { name, labels: entry.labels, value: entry.value });
    }
  }
  return series;
}

export function updateGaugeStats(statsMap, snapshot) {
  if (!snapshot) {
    return;
  }
  for (const [name, entries] of snapshot.samples) {
    const type = getMetricType(snapshot.types, name);
    if (!shouldTrackGauge(type, name)) {
      continue;
    }
    for (const entry of entries) {
      const key = buildSeriesKey(name, entry.labels);
      const current = statsMap.get(key) ?? {
        name,
        labels: entry.labels,
        min: entry.value,
        max: entry.value,
        sum: 0,
        count: 0
      };
      current.min = Math.min(current.min, entry.value);
      current.max = Math.max(current.max, entry.value);
      current.sum += entry.value;
      current.count += 1;
      statsMap.set(key, current);
    }
  }
}

export function summarizeMetrics({ start, end, gaugeStats }) {
  if (!start || !end) {
    return null;
  }
  const types = new Map([...start.types, ...end.types]);
  const startSeries = snapshotToSeries(start);
  const endSeries = snapshotToSeries(end);
  const deltas = new Map();

  for (const [key, endSample] of endSeries) {
    const startSample = startSeries.get(key);
    const delta = endSample.value - (startSample?.value ?? 0);
    const type = getMetricType(types, endSample.name);
    deltas.set(key, {
      name: endSample.name,
      labels: endSample.labels,
      delta,
      type
    });
  }

  const counters = [];
  const histograms = summarizeHistograms(deltas, types);
  const gauges = summarizeGauges(gaugeStats);

  for (const entry of deltas.values()) {
    if (entry.delta === 0) {
      continue;
    }
    if (entry.type === "histogram") {
      continue;
    }
    if (entry.type === "counter" || entry.type === "summary") {
      if (isHistogramSeries(entry.name, types)) {
        continue;
      }
      if (entry.type === "summary" && entry.name.endsWith("_sum")) {
        counters.push({
          name: entry.name,
          labels: entry.labels,
          delta: entry.delta
        });
        continue;
      }
      if (entry.type === "summary" && entry.name.endsWith("_count")) {
        counters.push({
          name: entry.name,
          labels: entry.labels,
          delta: entry.delta
        });
        continue;
      }
      if (entry.type === "counter") {
        counters.push({
          name: entry.name,
          labels: entry.labels,
          delta: entry.delta
        });
      }
      continue;
    }
    if (entry.type === undefined) {
      if (!shouldTrackGauge(entry.type, entry.name)) {
        counters.push({
          name: entry.name,
          labels: entry.labels,
          delta: entry.delta
        });
      }
    }
  }

  return { counters, histograms, gauges };
}

export async function fetchMetricsTarget(target, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs ?? 10000);
  try {
    const response = await fetch(target.url, {
      headers: { accept: "text/plain" },
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        target,
        ok: false,
        status: response.status,
        error: text
      };
    }
    const parsed = parsePrometheus(text);
    return { target, ok: true, status: response.status, parsed };
  } catch (error) {
    return {
      target,
      ok: false,
      status: "error",
      error
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchMetricsTargets(targets, timeoutMs) {
  const results = await Promise.all(
    targets.map((target) => fetchMetricsTarget(target, timeoutMs))
  );
  return results;
}

export function createMetricsSampler({ targets, intervalMs, timeoutMs }) {
  const errors = [];
  const gaugeStatsByTarget = new Map();
  const startSnapshots = new Map();
  const endSnapshots = new Map();
  let interval = null;
  let stopped = false;
  let sampling = false;

  async function sampleOnce({ markStart = false } = {}) {
    if (sampling) {
      return;
    }
    sampling = true;
    try {
      const results = await fetchMetricsTargets(targets, timeoutMs);
      for (const result of results) {
        if (!result.ok) {
          errors.push({
            target: result.target,
            status: result.status,
            error: result.error
          });
          continue;
        }
        const targetName = result.target.name;
        const stats =
          gaugeStatsByTarget.get(targetName) ?? new Map();
        updateGaugeStats(stats, result.parsed);
        gaugeStatsByTarget.set(targetName, stats);
        if (markStart && !startSnapshots.has(targetName)) {
          startSnapshots.set(targetName, result.parsed);
        }
        endSnapshots.set(targetName, result.parsed);
      }
    } finally {
      sampling = false;
    }
  }

  return {
    async start() {
      if (!targets.length) {
        return;
      }
      await sampleOnce({ markStart: true });
      if (intervalMs && intervalMs > 0) {
        interval = setInterval(() => {
          if (stopped) {
            return;
          }
          sampleOnce().catch((error) => {
            errors.push({ target: { name: "sampler" }, status: "error", error });
          });
        }, intervalMs);
      }
    },
    async stop() {
      if (!targets.length) {
        return {
          errors: [],
          startSnapshots,
          endSnapshots,
          gaugeStatsByTarget
        };
      }
      stopped = true;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      await sampleOnce();
      return {
        errors,
        startSnapshots,
        endSnapshots,
        gaugeStatsByTarget
      };
    }
  };
}

function parseLabelString(raw) {
  const labels = {};
  let index = 0;
  while (index < raw.length) {
    while (index < raw.length && (raw[index] === " " || raw[index] === ",")) {
      index += 1;
    }
    let keyStart = index;
    while (index < raw.length && raw[index] !== "=") {
      index += 1;
    }
    const key = raw.slice(keyStart, index).trim();
    index += 1;
    if (raw[index] !== "\"") {
      break;
    }
    index += 1;
    let value = "";
    while (index < raw.length) {
      const ch = raw[index];
      if (ch === "\\") {
        index += 1;
        const next = raw[index];
        if (next === "n") {
          value += "\n";
        } else if (next === "t") {
          value += "\t";
        } else if (next === "r") {
          value += "\r";
        } else if (next !== undefined) {
          value += next;
        }
        index += 1;
        continue;
      }
      if (ch === "\"") {
        index += 1;
        break;
      }
      value += ch;
      index += 1;
    }
    if (key) {
      labels[key] = value;
    }
    while (index < raw.length && raw[index] !== ",") {
      index += 1;
    }
    if (raw[index] === ",") {
      index += 1;
    }
  }
  return labels;
}

function parsePromValue(raw) {
  if (raw === "NaN") {
    return NaN;
  }
  if (raw === "+Inf" || raw === "Inf" || raw === "Infinity" || raw === "+Infinity") {
    return Infinity;
  }
  if (raw === "-Inf" || raw === "-Infinity") {
    return -Infinity;
  }
  return Number(raw);
}

function shouldTrackGauge(type, name) {
  if (type === "gauge") {
    return true;
  }
  if (type === "summary") {
    return !(name.endsWith("_sum") || name.endsWith("_count"));
  }
  if (type === "histogram" || type === "counter") {
    return false;
  }
  if (!type) {
    if (name.endsWith("_bucket") || name.endsWith("_sum") || name.endsWith("_count")) {
      return false;
    }
    if (name.endsWith("_total")) {
      return false;
    }
    return true;
  }
  return false;
}

function isHistogramSeries(name, types) {
  const suffixMatch = name.match(/^(.*)_(bucket|sum|count)$/);
  if (!suffixMatch) {
    return false;
  }
  const base = suffixMatch[1];
  return types.get(base) === "histogram";
}

function summarizeGauges(statsMap) {
  if (!statsMap) {
    return [];
  }
  const gauges = [];
  for (const entry of statsMap.values()) {
    if (!entry.count) {
      continue;
    }
    gauges.push({
      name: entry.name,
      labels: entry.labels,
      min: entry.min,
      max: entry.max,
      mean: entry.sum / entry.count
    });
  }
  return gauges;
}

function summarizeHistograms(deltas, types) {
  const histogramBases = new Set(
    [...types.entries()].filter(([, type]) => type === "histogram").map(([name]) => name)
  );
  const bucketsByKey = new Map();
  const countsByKey = new Map();
  const sumsByKey = new Map();

  for (const entry of deltas.values()) {
    const match = entry.name.match(/^(.*)_(bucket|sum|count)$/);
    if (!match) {
      continue;
    }
    const base = match[1];
    const suffix = match[2];
    if (!histogramBases.has(base)) {
      continue;
    }
    const labels = { ...entry.labels };
    const groupKey = buildSeriesKey(base, stripLeLabel(labels));

    if (suffix === "bucket") {
      const leRaw = entry.labels?.le ?? "";
      const leValue = parsePromValue(leRaw);
      if (!bucketsByKey.has(groupKey)) {
        bucketsByKey.set(groupKey, {
          name: base,
          labels: stripLeLabel({ ...entry.labels }),
          buckets: []
        });
      }
      bucketsByKey.get(groupKey).buckets.push({
        le: Number.isFinite(leValue) ? leValue : Infinity,
        count: entry.delta
      });
    } else if (suffix === "count") {
      countsByKey.set(groupKey, entry.delta);
    } else if (suffix === "sum") {
      sumsByKey.set(groupKey, entry.delta);
    }
  }

  const summaries = [];
  for (const [groupKey, bucketGroup] of bucketsByKey.entries()) {
    const buckets = bucketGroup.buckets.sort((a, b) => a.le - b.le);
    const count = countsByKey.get(groupKey) ?? 0;
    const sum = sumsByKey.get(groupKey) ?? 0;
    const mean = count > 0 ? sum / count : 0;
    const quantiles = computeHistogramQuantiles(buckets, [0.5, 0.9, 0.95, 0.99]);
    summaries.push({
      name: bucketGroup.name,
      labels: bucketGroup.labels,
      count,
      sum,
      mean,
      p50: quantiles[0],
      p90: quantiles[1],
      p95: quantiles[2],
      p99: quantiles[3],
      buckets
    });
  }
  return summaries;
}

function stripLeLabel(labels) {
  if (!labels) {
    return {};
  }
  const { le, ...rest } = labels;
  return rest;
}

function computeHistogramQuantiles(buckets, quantiles) {
  if (!buckets.length) {
    return quantiles.map(() => 0);
  }
  const total = buckets[buckets.length - 1].count;
  if (!total) {
    return quantiles.map(() => 0);
  }
  return quantiles.map((q) => histogramQuantile(q, buckets, total));
}

function histogramQuantile(quantile, buckets, total) {
  const target = total * quantile;
  let prevCount = 0;
  let prevLe = 0;
  for (const bucket of buckets) {
    if (bucket.count >= target) {
      if (!Number.isFinite(bucket.le)) {
        return prevLe;
      }
      const bucketCount = bucket.count - prevCount;
      if (bucketCount <= 0) {
        return bucket.le;
      }
      const fraction = (target - prevCount) / bucketCount;
      return prevLe + (bucket.le - prevLe) * fraction;
    }
    prevCount = bucket.count;
    prevLe = bucket.le;
  }
  return buckets[buckets.length - 1].le;
}
