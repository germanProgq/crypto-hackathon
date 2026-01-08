// MongoDB connection and schema setup.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MongoClient, type Db } from "mongodb";
import type { Logger } from "pino";
import type { AppConfig } from "../config";
import { mongoCollectionSpecs, mongoIndexSpecs } from "./mongoSchemas";

const execFileAsync = promisify(execFile);
const localHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const dockerImage = "mongo:7.0";
const dockerTimeoutMs = 20000;

export interface MongoDependencies {
  client: MongoClient;
  db: Db;
}

export async function connectMongo(config: AppConfig, logger: Logger): Promise<MongoDependencies> {
  await ensureLocalMongo(config.mongo.uri, logger);
  const client = new MongoClient(config.mongo.uri, {
    maxPoolSize: 50,
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

async function ensureLocalMongo(uri: string, logger: Logger): Promise<void> {
  const target = resolveLocalMongoTarget(uri);
  if (!target) {
    return;
  }

  await ensureDockerMongo(target.port, logger);
}

async function ensureDockerMongo(port: number, logger: Logger): Promise<void> {
  const containerName = `crypto-hack-mongo-${port}`;
  const exists = await dockerContainerExists(containerName);

  if (!exists) {
    await runDocker([
      "run",
      "-d",
      "--name",
      containerName,
      "-p",
      `${port}:27017`,
      dockerImage
    ]);
    logger.info({ container: containerName, port }, "Mongo docker container created");
    return;
  }

  const running = await dockerContainerRunning(containerName);
  if (!running) {
    await runDocker(["start", containerName]);
    logger.info({ container: containerName, port }, "Mongo docker container started");
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

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function getExecErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "";
}
