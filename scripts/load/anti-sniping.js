// Anti-sniping edge case test for round extensions.
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  buildForwardedIp,
  buildRunId,
  computeStats,
  formatStats,
  parseArgs,
  placeBid,
  resolveConfig,
  seedDeposits,
  waitForRoundStatus,
  createAuction,
  getRoundState,
  readNumber,
  readText
} from "./lib.js";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = resolveConfig(args);
  const runId = buildRunId(args);
  const roundDurationSeconds = Math.max(
    30,
    Math.floor(readNumber(args.roundDuration, process.env.ANTI_ROUND_DURATION, 30))
  );
  const triggerWindowSeconds = Math.max(
    2,
    Math.floor(readNumber(args.triggerWindow, process.env.ANTI_TRIGGER_WINDOW, roundDurationSeconds))
  );
  const extensionSeconds = Math.max(
    1,
    Math.floor(readNumber(args.extensionSeconds, process.env.ANTI_EXTENSION_SECONDS, 4))
  );
  const depositAmount = readNumber(args.deposit, process.env.ANTI_DEPOSIT, 200);
  const baseBid = readNumber(args.baseBid, process.env.ANTI_BASE_BID, 80);
  const userId = readText(args.userId, process.env.ANTI_USER_ID, `sniper-${runId}`);

  console.log("anti-sniping test starting", {
    runId,
    triggerWindowSeconds,
    extensionSeconds,
    roundDurationSeconds
  });

  const { auctionId } = await createAuction({
    webUrl: config.webUrl,
    title: `Anti-sniping ${runId}`,
    currency: config.currency,
    rounds: 1,
    allocationSize: 1,
    roundDurationSeconds,
    startOffsetSeconds: 0,
    antiSniping: {
      triggerWindowSeconds,
      extensionSeconds,
      maxExtensions: 1
    }
  });

  await waitForRoundStatus({
    auctionUrl: config.auctionUrl,
    auctionId,
    roundIndex: 0,
    status: "live",
    timeoutMs: 30000,
    pollMs: 100
  });

  await seedDeposits({
    ledgerUrl: config.ledgerUrl,
    users: [userId],
    amount: depositAmount,
    currency: config.currency,
    concurrency: 1,
    timeoutMs: config.timeoutMs
  });

  const stateBefore = await getRoundState({
    auctionUrl: config.auctionUrl,
    auctionId,
    roundIndex: 0
  });

  const loadStart = performance.now();
  const response = await placeBid({
    auctionUrl: config.auctionUrl,
    auctionId,
    userId,
    amount: baseBid,
    idempotencyKey: `anti-${userId}-${randomUUID()}`,
    ip: buildForwardedIp(1),
    timeoutMs: config.timeoutMs,
    parseJson: true
  });
  const loadDurationMs = performance.now() - loadStart;

  if (!response.ok || !response.data) {
    throw new Error(`Bid failed: ${response.status}`);
  }

  const stateAfter = await getRoundState({
    auctionUrl: config.auctionUrl,
    auctionId,
    roundIndex: 0
  });

  const beforeEnd = new Date(stateBefore.effectiveEndAt).getTime();
  const afterEnd = new Date(stateAfter.effectiveEndAt).getTime();
  const extensionApplied = afterEnd - beforeEnd;

  console.log("anti-sniping result", {
    auctionId,
    extended: response.data.extended,
    extensionCount: stateAfter.extensionCount,
    extensionMs: extensionApplied,
    loadDurationMs: Math.round(loadDurationMs)
  });

  const durations = [response.durationMs];
  console.log("request stats", { stats: formatStats(computeStats(durations)) });

  if (!response.data.extended || stateAfter.extensionCount <= stateBefore.extensionCount) {
    throw new Error("Anti-sniping extension did not trigger as expected.");
  }
}

await main();
