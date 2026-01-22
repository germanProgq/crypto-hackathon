// Purpose: MongoDB connection and schema setup.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MongoClient, type Db } from "mongodb";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import { mongoCollectionSpecs, mongoIndexSpecs } from "./mongoSchemas.js";

const execFileAsync = promisify(execFile);
const localHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const dockerImage = "mongo:7.0";
const dockerTimeoutMs = 60000;
const replicaSetName = "rs0";

export interface MongoDependencies {
  client: MongoClient;
  db: Db;
}

type LocalMongoOverride = {
  uri: string;
  port: number;
  fallback: boolean;
};

export async function connectMongo(config: AppConfig, logger: Logger): Promise<MongoDependencies> {
  const localOverride = await ensureLocalMongo(config.mongo.uri, logger);
  const mongoUri = localOverride?.uri ?? config.mongo.uri;
  if (localOverride?.fallback) {
    logger.warn(
      { port: localOverride.port },
      "Mongo replica set fallback active for local development."
    );
  }
  const client = new MongoClient(mongoUri, {
    maxPoolSize: config.mongo.poolMax,
    serverSelectionTimeoutMS: 5000,
    appName: config.serviceName
  });

  await client.connect();
  const db = client.db(config.mongo.dbName);
  await db.command({ ping: 1 });

  logger.info({ db: config.mongo.dbName }, "Mongo connected");

  return { client, db };
}

export async function ensureMongoCollections(db: Db, logger: Logger): Promise<void> {
  const existing = await db.listCollections().toArray();
  const existingNames = new Set(existing.map((collection) => collection.name));

  for (const spec of mongoCollectionSpecs) {
    if (!existingNames.has(spec.name)) {
      await db.createCollection(spec.name, {
        validator: spec.validator,
        validationLevel: "moderate",
        validationAction: "error"
      });
      logger.info({ collection: spec.name }, "Mongo collection created");
      continue;
    }

    if (spec.validator) {
      await db.command({
        collMod: spec.name,
        validator: spec.validator,
        validationLevel: "moderate",
        validationAction: "error"
      });
      logger.info({ collection: spec.name }, "Mongo collection validator updated");
    }
  }
}

export async function ensureMongoIndexes(db: Db, logger: Logger): Promise<void> {
  for (const spec of mongoIndexSpecs) {
    const collection = db.collection(spec.collection);
    const created = await collection.createIndexes(spec.indexes, { background: true });
    logger.info({ collection: spec.collection, indexes: created }, "Mongo indexes ensured");
  }
}

export function resolveLocalMongoTarget(uri: string): { port: number } | null {
  if (uri.startsWith("mongodb+srv://")) {
    return null;
  }

  if (!uri.startsWith("mongodb://")) {
    return null;
  }

  const withoutProtocol = uri.slice("mongodb://".length);
  const hostSection = withoutProtocol.split("/")[0] ?? "";
  const hostPart = hostSection.split("@").pop() ?? "";
  const hosts = hostPart.split(",").map((entry) => entry.trim()).filter(Boolean);

  if (hosts.length !== 1) {
    return null;
  }

  const hostEntry = hosts[0] ?? "";

  if (hostEntry.startsWith("[")) {
    const closing = hostEntry.indexOf("]");
    if (closing === -1) {
      return null;
    }

    const host = hostEntry.slice(1, closing);
    if (!localHosts.has(host)) {
      return null;
    }

    const portPart = hostEntry.slice(closing + 1);
    const port = portPart.startsWith(":") ? Number(portPart.slice(1)) : 27017;
    return isValidPort(port) ? { port } : null;
  }

  const [host, portPart] = hostEntry.split(":");
  if (!host || !localHosts.has(host)) {
    return null;
  }

  const port = portPart ? Number(portPart) : 27017;

  return isValidPort(port) ? { port } : null;
}

export function buildLocalMongoUri(uri: string, port: number): string {
  return applyReplicaSetParams(updateLocalMongoUriPort(uri, port));
}

async function isMongoAvailable(uri: string): Promise<boolean> {
  try {
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 2000,
      connectTimeoutMS: 2000
    });
    await client.connect();
    await client.db().command({ ping: 1 });
    await client.close();
    return true;
  } catch {
    return false;
  }
}

async function ensureLocalMongo(
  uri: string,
  logger: Logger
): Promise<LocalMongoOverride | null> {
  const target = resolveLocalMongoTarget(uri);
  if (!target) {
    return null;
  }

  // Check if MongoDB is already available (e.g., via docker-compose)
  const directUri = buildLocalMongoUri(uri, target.port);
  if (await isMongoAvailable(directUri)) {
    logger.info({ port: target.port }, "MongoDB already available, skipping Docker setup");
    return {
      uri: directUri,
      port: target.port,
      fallback: false
    };
  }

  const port = await ensureDockerMongo(target.port, logger);
  const updatedUri = buildLocalMongoUri(uri, port);
  return {
    uri: updatedUri,
    port,
    fallback: port !== target.port
  };
}

async function ensureDockerMongo(port: number, logger: Logger): Promise<number> {
  const candidatePorts = buildCandidatePorts(port);
  let lastError: Error | undefined;

  for (const candidate of candidatePorts) {
    const result = await ensureDockerMongoReplica(candidate, logger);
    if (result.ok) {
      return candidate;
    }
    lastError = result.error;
  }

  throw lastError ?? new Error("Mongo replica set unavailable.");
}

type ReplicaEnsureResult =
  | { ok: true }
  | { ok: false; error: Error; reason: "replication_disabled" | "port_in_use" };

async function ensureDockerMongoReplica(
  port: number,
  logger: Logger
): Promise<ReplicaEnsureResult> {
  const containerName = `crypto-hack-mongo-${port}`;
  const exists = await dockerContainerExists(containerName);
  let containerReady = exists;

  if (!exists) {
    try {
      await runDocker([
        "run",
        "-d",
        "--name",
        containerName,
        "-p",
        `${port}:27017`,
        dockerImage,
        "--replSet",
        replicaSetName,
        "--bind_ip_all"
      ]);
      logger.info({ container: containerName, port }, "Mongo docker container created");
      containerReady = true;
    } catch (error) {
      if (isPortInUseError(error)) {
        return {
          ok: false,
          error: error instanceof Error ? error : new Error("Mongo port already in use."),
          reason: "port_in_use"
        };
      }
      if (isContainerNameConflictError(error)) {
        containerReady = true;
      } else {
        throw error;
      }
    }
  }

  if (containerReady) {
    const running = await dockerContainerRunning(containerName);
    if (!running) {
      await runDocker(["start", containerName]);
      logger.info({ container: containerName, port }, "Mongo docker container started");
    }
  }

  try {
    await ensureReplicaSet(containerName, logger);
    return { ok: true };
  } catch (error) {
    if (isReplicationNotEnabledError(error)) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error("Mongo replica set not enabled."),
        reason: "replication_disabled"
      };
    }
    throw error;
  }
}

async function dockerContainerExists(name: string): Promise<boolean> {
  const names = await listDockerContainers(name, true);
  return names.includes(name);
}

async function dockerContainerRunning(name: string): Promise<boolean> {
  const names = await listDockerContainers(name, false);
  return names.includes(name);
}

async function listDockerContainers(name: string, includeStopped: boolean): Promise<string[]> {
  const args = ["ps"];
  if (includeStopped) {
    args.push("-a");
  }

  args.push("--filter", `name=^${name}$`, "--format", "{{.Names}}");

  const { stdout } = await runDocker(args);
  return stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function runDocker(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("docker", args, { timeout: dockerTimeoutMs });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    const detail = getExecErrorMessage(error);
    throw new Error(`Docker command failed: docker ${args.join(" ")}${detail ? ` (${detail})` : ""}`);
  }
}

async function ensureReplicaSet(containerName: string, logger: Logger): Promise<void> {
  const status = await getReplicaSetStatus(containerName);
  if (status?.ok === 1 && status.set === replicaSetName) {
    return;
  }

  const replicaHost = "127.0.0.1:27017";
  try {
    await runDocker([
      "exec",
      containerName,
      "mongosh",
      "--quiet",
      "--eval",
      `rs.initiate({_id:"${replicaSetName}",members:[{_id:0,host:"${replicaHost}"}]})`
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("already initialized") && !message.includes("already initiated")) {
      throw error;
    }
  }

  await waitForReplicaSet(containerName, logger);
}

function buildCandidatePorts(port: number): number[] {
  const candidates: number[] = [];
  for (let offset = 0; offset <= 3; offset += 1) {
    const candidate = port + offset;
    if (isValidPort(candidate)) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function updateLocalMongoUriPort(uri: string, port: number): string {
  if (!uri.startsWith("mongodb://")) {
    return uri;
  }

  const protocol = "mongodb://";
  const remainder = uri.slice(protocol.length);
  const hostEnd = findHostTerminator(remainder);
  const hostSection = remainder.slice(0, hostEnd);
  const tail = remainder.slice(hostEnd);
  const atIndex = hostSection.lastIndexOf("@");
  const credentials = atIndex >= 0 ? `${hostSection.slice(0, atIndex)}@` : "";
  const hostPart = atIndex >= 0 ? hostSection.slice(atIndex + 1) : hostSection;
  const updatedHost = replaceHostPort(hostPart, port);

  return `${protocol}${credentials}${updatedHost}${tail}`;
}

function replaceHostPort(hostPart: string, port: number): string {
  if (hostPart.startsWith("[")) {
    const closing = hostPart.indexOf("]");
    if (closing === -1) {
      return hostPart;
    }
    return `${hostPart.slice(0, closing + 1)}:${port}`;
  }

  const [host] = hostPart.split(":");
  if (!host) {
    return hostPart;
  }
  return `${host}:${port}`;
}

function findHostTerminator(value: string): number {
  const slashIndex = value.indexOf("/");
  const queryIndex = value.indexOf("?");
  const candidates = [slashIndex, queryIndex].filter((index) => index !== -1);
  if (candidates.length === 0) {
    return value.length;
  }
  return Math.min(...candidates);
}

function applyReplicaSetParams(uri: string): string {
  const [base = uri, query = ""] = uri.split("?");
  const params = new URLSearchParams(query);
  if (!params.has("replicaSet")) {
    params.set("replicaSet", replicaSetName);
  }
  if (!params.has("directConnection")) {
    params.set("directConnection", "true");
  }
  const paramString = params.toString();
  return paramString ? `${base}?${paramString}` : base;
}

function isReplicationNotEnabledError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("not started with replication enabled");
}

function isPortInUseError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes("port is already allocated") ||
    error.message.includes("address already in use") ||
    error.message.includes("bind: address already in use")
  );
}

function isContainerNameConflictError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("container name") && error.message.includes("already in use");
}

async function getReplicaSetStatus(
  containerName: string
): Promise<{ ok: number; set?: string; myState?: number } | null> {
  try {
    const result = await runDocker([
      "exec",
      containerName,
      "mongosh",
      "--quiet",
      "--eval",
      "JSON.stringify(rs.status())"
    ]);
    const trimmed = result.stdout.trim();
    if (!trimmed) {
      return null;
    }
    return JSON.parse(trimmed) as { ok: number; set?: string; myState?: number };
  } catch (error) {
    return null;
  }
}

async function waitForReplicaSet(containerName: string, logger: Logger): Promise<void> {
  const attempts = 30;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = await getReplicaSetStatus(containerName);
    if (status?.ok === 1 && status.myState === 1) {
      logger.info({ container: containerName }, "Mongo replica set ready");
      return;
    }

    await delay(1000);
  }

  throw new Error("Mongo replica set initialization timed out.");
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function getExecErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "";
}
