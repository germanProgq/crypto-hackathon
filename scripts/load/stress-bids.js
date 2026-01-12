// Concurrent bid stress test for auction engine.
import { randomUUID } from "node:crypto";
import {
  buildForwardedIp,
  buildRunId,
  buildStatusCounts,
  buildUserList,
  computeStats,
  formatStats,
  formatStatusCounts,
  parseArgs,
  placeBid,
  resolveConfig,
  seedDeposits,
  waitForRoundStatus,
  createAuction,
  readNumber,
  readText,
  runTasksWithLimit
} from "./lib.js";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = resolveConfig(args);
  const runId = buildRunId(args);
  const totalBids = Math.max(1, Math.floor(readNumber(args.bids, process.env.STRESS_BIDS, 200)));
  const concurrency = Math.max(
    1,
    Math.floor(readNumber(args.concurrency, process.env.STRESS_CONCURRENCY, 50))
  );
  const userCount = Math.max(
    1,
    Math.floor(readNumber(args.users, process.env.STRESS_USERS, totalBids))
  );
  const depositAmount = readNumber(args.deposit, process.env.STRESS_DEPOSIT, 500);
  const baseBid = readNumber(args.baseBid, process.env.STRESS_BASE_BID, 25);
  const prefix = readText(args["user-prefix"], process.env.STRESS_USER_PREFIX, "stress");

  console.log("stress test starting", { runId, totalBids, concurrency, userCount });

  const { auctionId } = await createAuction({
    webUrl: config.webUrl,
    title: `Stress ${runId}`,
    currency: config.currency,
    rounds: 1,
    allocationSize: Math.max(1, Math.floor(userCount / 4)),
    roundDurationSeconds: Math.max(6, Math.ceil(totalBids / Math.max(1, concurrency)) + 2),
    startOffsetSeconds: 0,
    antiSniping: {
      triggerWindowSeconds: 8,
      extensionSeconds: 12,
      maxExtensions: 2
    }
  });

  await waitForRoundStatus({
    auctionUrl: config.auctionUrl,
    auctionId,
    roundIndex: 0,
    status: "live",
    timeoutMs: 8000,
    pollMs: 100
  });

  const users = buildUserList({ prefix, runId, count: userCount });
  await seedDeposits({
    ledgerUrl: config.ledgerUrl,
    users,
    amount: depositAmount,
    currency: config.currency,
    concurrency,
    timeoutMs: config.timeoutMs
  });

  const statusCounts = buildStatusCounts();
  const durations = [];
  const tasks = Array.from({ length: totalBids }).map((_, index) => async () => {
    const userId = users[index % users.length];
    const ip = buildForwardedIp(index);
    const amount = baseBid + index * 0.25;
    const response = await placeBid({
      auctionUrl: config.auctionUrl,
      auctionId,
      userId,
      amount: Math.round(amount * 100) / 100,
      idempotencyKey: `stress-${userId}-${index}-${randomUUID()}`,
      ip,
      timeoutMs: config.timeoutMs
    }).catch((error) => ({ ok: false, status: "error", error }));

    if (typeof response.durationMs === "number") {
      durations.push(response.durationMs);
    }
    statusCounts.byStatus[response.status] = (statusCounts.byStatus[response.status] ?? 0) + 1;
    if (response.ok) {
      statusCounts.ok += 1;
    } else {
      statusCounts.error += 1;
    }
  });

  await runTasksWithLimit(tasks, concurrency);

  const stats = computeStats(durations);
  console.log("stress test complete", {
    auctionId,
    stats: formatStats(stats),
    status: formatStatusCounts(statusCounts)
  });
}

await main();
