// Detailed TON RPC connectivity test using the actual RPC client
import { loadConfig } from "../src/shared/config.js";
import { createTonRpcClient } from "../src/services/observer/tonRpcClient.js";

async function testTonRpcDetailed() {
  console.log("🔍 TON RPC Detailed Test\n");
  console.log("Loading configuration...\n");

  const config = loadConfig({ serviceName: "rpc-test" });

  if (!config.rpc.ton) {
    console.error("❌ RPC_TON_URL is not configured");
    console.log("\nPlease set RPC_TON_URL in your .env file:");
    console.log("RPC_TON_URL=https://your-ton-endpoint.quicknode.com/...");
    process.exit(1);
  }

  console.log("Configuration:");
  console.log(`  RPC URL: ${config.rpc.ton}`);
  console.log(`  Fallbacks: ${config.rpc.tonFallbacks.length > 0 ? config.rpc.tonFallbacks.join(", ") : "none"}`);
  console.log(`  Timeout: ${config.rpc.tonTimeoutMs}ms`);
  console.log(`  Max RPS: ${config.rpc.tonMaxRps}`);
  console.log(`  Retry: ${config.rpc.tonRetry.maxAttempts} attempts`);
  console.log(`  USDT Jetton: ${config.usdtContracts.ton}`);
  console.log();

  console.log("Creating TON RPC client...\n");

  const tonClient = createTonRpcClient({
    rpcUrl: config.rpc.ton,
    fallbackUrls: config.rpc.tonFallbacks,
    timeoutMs: config.rpc.tonTimeoutMs,
    maxRps: config.rpc.tonMaxRps,
    retry: config.rpc.tonRetry,
    usdtJettonAddress: config.usdtContracts.ton
  });

  const tests = [
    {
      name: "Health Check",
      test: async () => {
        const start = Date.now();
        const healthy = await tonClient.healthCheck();
        const latency = Date.now() - start;
        return {
          success: healthy,
          latency,
          message: healthy ? "RPC is healthy" : "RPC is unhealthy"
        };
      }
    },
    {
      name: "Get Masterchain Info",
      test: async () => {
        const start = Date.now();
        const info = await tonClient.getMasterchainInfo();
        const latency = Date.now() - start;
        return {
          success: info.ok && info.result.last.seqno > 0,
          latency,
          message: `Last seqno: ${info.result.last.seqno}, Workchain: ${info.result.last.workchain}`,
          data: {
            seqno: info.result.last.seqno,
            workchain: info.result.last.workchain,
            shard: info.result.last.shard
          }
        };
      }
    },
    {
      name: "Get Current Block Seqno",
      test: async () => {
        const start = Date.now();
        const seqno = await tonClient.getCurrentBlockSeqno();
        const latency = Date.now() - start;
        return {
          success: seqno > 0,
          latency,
          message: `Current block seqno: ${seqno}`,
          data: { seqno }
        };
      }
    },
    {
      name: "Get USDT Jetton Address Info",
      test: async () => {
        const start = Date.now();
        const info = await tonClient.getAddressInfo(config.usdtContracts.ton);
        const latency = Date.now() - start;
        return {
          success: info.ok,
          latency,
          message: `Balance: ${info.result.balance}, State: ${info.result["@type"]}`,
          data: {
            balance: info.result.balance,
            state: info.result["@type"]
          }
        };
      }
    }
  ];

  console.log("Running tests...\n");

  let passed = 0;
  let failed = 0;

  for (const { name, test } of tests) {
    try {
      const result = await test();
      const icon = result.success ? "✅" : "❌";
      const status = result.success ? "PASS" : "FAIL";

      console.log(`${icon} ${name} (${result.latency}ms)`);
      console.log(`   Status: ${status}`);
      console.log(`   ${result.message}`);
      if (result.data) {
        console.log(`   Data: ${JSON.stringify(result.data)}`);
      }
      console.log();

      if (result.success) {
        passed++;
      } else {
        failed++;
      }
    } catch (error) {
      console.log(`❌ ${name}`);
      console.log(`   Error: ${error instanceof Error ? error.message : String(error)}`);
      console.log();
      failed++;
    }
  }

  console.log("=".repeat(50));
  console.log("Summary:");
  console.log(`  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`  📊 Total:  ${tests.length}`);
  console.log();

  if (failed > 0) {
    console.log("⚠️  Some tests failed. Please check your RPC configuration.");
    process.exit(1);
  } else {
    console.log("🎉 All tests passed! TON RPC is working correctly.");
  }
}

testTonRpcDetailed().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});
