// Local MongoDB URI detection tests.
import { describe, expect, it } from "vitest";
import { resolveLocalMongoTarget } from "../src/shared/storage/mongo";

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
});
