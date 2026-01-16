// Bot simulation load test for auction bidding.
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
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
  randomBetween,
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
  const userCount = Math.max(1, Math.floor(readNumber(args.users, process.env.BOT_USERS, 40)));
  const bidsPerUser = Math.max(1, Math.floor(readNumber(args.bids, process.env.BOT_BIDS, 6)));
  const depositAmount = readNumber(args.deposit, process.env.BOT_DEPOSIT, 500);
  const baseBid = readNumber(args.baseBid, process.env.BOT_BASE_BID, 50);
  const minIncrement = readNumber(args.minIncrement, process.env.BOT_MIN_INCREMENT, 5);
  const maxIncrement = readNumber(args.maxIncrement, process.env.BOT_MAX_INCREMENT, 25);
  const concurrency = Math.max(
    1,
    Math.floor(
      readNumber(
        args.concurrency,
        process.env.BOT_CONCURRENCY,
        Math.min(userCount, 80)
      )
    )
  );
  const prefix = readText(args["user-prefix"], process.env.BOT_USER_PREFIX, "bot");

  console.log("bot simulation starting", {
    runId,
    userCount,
    bidsPerUser,
    depositAmount,
    baseBid
  });

  const { auctionId } = await createAuction({
    webUrl: config.webUrl,
    title: `Load bots ${runId}`,
    currency: config.currency,
    rounds: 2,
    allocationSize: Math.max(1, Math.floor(userCount / 5)),
    roundDurationSeconds: Math.max(30, bidsPerUser * 2),
    startOffsetSeconds: 0,
    antiSniping: {
      triggerWindowSeconds: 10,
      extensionSeconds: 15,
      maxExtensions: 2
    }
  });

  console.log("auction created", { auctionId });

  await waitForRoundStatus({
    auctionUrl: config.auctionUrl,
    auctionId,
    roundIndex: 0,
    status: "live",
    timeoutMs: 30000,
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

  const tasks = users.map((userId, index) => async () => {
    const ip = buildForwardedIp(index);
    let amount = baseBid + randomBetween(0, minIncrement);
    for (let bidIndex = 0; bidIndex < bidsPerUser; bidIndex += 1) {
      amount += randomBetween(minIncrement, maxIncrement);
      const response = await placeBid({
        auctionUrl: config.auctionUrl,
        auctionId,
        userId,
        amount: Math.round(amount * 100) / 100,
        idempotencyKey: `bot-${userId}-${bidIndex}-${randomUUID()}`,
        ip,
        timeoutMs: config.timeoutMs
      }).catch((error) => ({ ok: false, status: "error", error }));

      recordResponse(response, durations, statusCounts);
    }
  });

  const loadStart = performance.now();
  await runTasksWithLimit(tasks, concurrency);
  const loadDurationMs = performance.now() - loadStart;

  const stats = computeStats(durations);
  console.log("bot simulation complete", {
    auctionId,
    stats: formatStats(stats),
    status: formatStatusCounts(statusCounts),
    loadDurationMs: Math.round(loadDurationMs)
  });
}

function recordResponse(response, durations, statusCounts) {
  if (typeof response.durationMs === "number") {
    durations.push(response.durationMs);
  }
  statusCounts.byStatus[response.status] = (statusCounts.byStatus[response.status] ?? 0) + 1;
  if (response.ok) {
    statusCounts.ok += 1;
  } else {
    statusCounts.error += 1;
  }
}

await main();
