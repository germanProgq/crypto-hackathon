// Load test suite runner.
import { spawn } from "node:child_process";

const scripts = ["bot-sim.js", "stress-bids.js", "anti-sniping.js", "reconcile.js"];
const args = process.argv.slice(2);

for (const script of scripts) {
  console.log(`running ${script}`);
  const result = await runScript(script, args);
  if (result !== 0) {
    process.exit(result ?? 1);
  }
}

async function runScript(script, args) {
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
