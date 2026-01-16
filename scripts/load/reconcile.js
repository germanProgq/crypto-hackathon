// Ledger reconciliation check for load test users.
import { performance } from "node:perf_hooks";
import {
  buildRunId,
  buildUserList,
  computeStats,
  formatStats,
  parseArgs,
  reconcileUser,
  resolveConfig,
  readNumber,
  readText,
  runTasksWithLimit
} from "./lib.js";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = resolveConfig(args);
  const runId = buildRunId(args);
  const rawUsers = readText(args.users, process.env.RECONCILE_USERS, "");
  const prefix = readText(args["user-prefix"], process.env.RECONCILE_USER_PREFIX, "bot");
  const count = Math.max(1, Math.floor(readNumber(args.count, process.env.RECONCILE_COUNT, 20)));
  const concurrency = Math.max(
    1,
    Math.floor(readNumber(args.concurrency, process.env.RECONCILE_CONCURRENCY, 10))
  );
  const currency = config.currency;

  const users = rawUsers
    ? rawUsers.split(",").map((entry) => entry.trim()).filter(Boolean)
    : buildUserList({ prefix, runId, count });

  console.log("reconcile starting", { runId, count: users.length, currency });

  const durations = [];
  const issues = [];
  const tasks = users.map((userId) => async () => {
    const start = Date.now();
    const result = await reconcileUser({ ledgerUrl: config.ledgerUrl, userId, currency });
    durations.push(Date.now() - start);
    if (Array.isArray(result.issues) && result.issues.length > 0) {
      issues.push({ userId, issues: result.issues });
    }
    return result;
  });

  const loadStart = performance.now();
  await runTasksWithLimit(tasks, concurrency);
  const loadDurationMs = performance.now() - loadStart;

  console.log("reconcile complete", {
    stats: formatStats(computeStats(durations)),
    issueCount: issues.length,
    issues,
    loadDurationMs: Math.round(loadDurationMs)
  });

  if (issues.length > 0) {
    process.exitCode = 1;
  }
}

await main();
