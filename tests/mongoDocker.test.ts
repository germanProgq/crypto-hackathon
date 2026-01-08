// Local MongoDB URI detection tests.
import { describe, expect, it } from "vitest";
import { buildLocalMongoUri, resolveLocalMongoTarget } from "../src/shared/storage/mongo.js";

describe("resolveLocalMongoTarget", () => {
  it("detects localhost mongodb URI", () => {
    expect(resolveLocalMongoTarget("mongodb://localhost:27017")).toEqual({ port: 27017 });
    expect(resolveLocalMongoTarget("mongodb://127.0.0.1")).toEqual({ port: 27017 });
  });

  it("detects IPv6 localhost mongodb URI", () => {
    expect(resolveLocalMongoTarget("mongodb://[::1]:27017")).toEqual({ port: 27017 });
  });

  it("ignores remote or srv URIs", () => {
    expect(resolveLocalMongoTarget("mongodb://mongo:27017")).toBeNull();
    expect(resolveLocalMongoTarget("mongodb+srv://cluster.example.net/test")).toBeNull();
  });

  it("ignores multi-host URIs", () => {
    expect(resolveLocalMongoTarget("mongodb://localhost:27017,localhost:27018")).toBeNull();
  });

  it("builds local replica set URIs with fallback ports", () => {
    const uri = buildLocalMongoUri("mongodb://localhost:27017/crypto_hack", 27018);
    expect(uri).toBe(
      "mongodb://localhost:27018/crypto_hack?replicaSet=rs0&directConnection=true"
    );
  });

  it("preserves existing query parameters when adding replica set options", () => {
    const uri = buildLocalMongoUri(
      "mongodb://user:pass@127.0.0.1:27017/db?retryWrites=false",
      27019
    );
    expect(uri.startsWith("mongodb://user:pass@127.0.0.1:27019/db?")).toBe(true);
    const query = uri.split("?")[1] ?? "";
    const params = new URLSearchParams(query);
    expect(params.get("retryWrites")).toBe("false");
    expect(params.get("replicaSet")).toBe("rs0");
    expect(params.get("directConnection")).toBe("true");
  });
});
