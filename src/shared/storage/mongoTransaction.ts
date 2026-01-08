// MongoDB transaction helper with retry handling.
import { MongoServerError, type ClientSession } from "mongodb";
import type { MongoDependencies } from "./mongo.js";

const transactionRetries = 3;

export async function runMongoTransaction<T>(
  mongo: MongoDependencies,
  work: (session: ClientSession) => Promise<T>
): Promise<T> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt < transactionRetries) {
    const session = mongo.client.startSession();
    try {
      let result: T | undefined;
      await session.withTransaction(
        async () => {
          result = await work(session);
        },
        {
          readConcern: { level: "snapshot" },
          writeConcern: { w: "majority" }
        }
      );

      if (result === undefined) {
        throw new Error("Transaction completed without a result.");
      }

      return result;
    } catch (error) {
      lastError = error;
      if (!isRetryableTransactionError(error) || attempt === transactionRetries - 1) {
        throw error;
      }
      attempt += 1;
    } finally {
      await session.endSession();
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Transaction failed.");
}

function isRetryableTransactionError(error: unknown): boolean {
  if (!(error instanceof MongoServerError)) {
    return false;
  }

  return (
    error.hasErrorLabel("TransientTransactionError") ||
    error.hasErrorLabel("UnknownTransactionCommitResult")
  );
}
