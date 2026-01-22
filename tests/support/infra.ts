// Test infra detection for containerized and loopback dependencies.
import { execFileSync } from "node:child_process";

export function hasDocker(): boolean {
  const override = process.env.RUN_DOCKER_TESTS;
  if (override === "true") {
    return true;
  }
  if (override === "false") {
    return false;
  }
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

export function canListenLoopback(): boolean {
  const override = process.env.RUN_NETWORK_TESTS;
  if (override === "true") {
    return true;
  }
  if (override === "false") {
    return false;
  }
  const script = [
    "const net=require('net');",
    "const server=net.createServer();",
    "let done=false;",
    "const finish=(code)=>{",
    "if(done)return;done=true;",
    "try{server.close(()=>process.exit(code));}catch{process.exit(code);}",
    "};",
    "server.once('error',()=>finish(1));",
    "server.listen(0,'127.0.0.1',()=>finish(0));",
    "setTimeout(()=>finish(1),300);"
  ].join("");
  try {
    execFileSync(process.execPath, ["-e", script], { stdio: "ignore", timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}
