// Configuration schema tests.
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/shared/config";

const baseOptions = {
  serviceName: "auction-engine",
  defaultPort: 4100
};

describe("loadConfig", () => {
  it("applies defaults with minimal environment", () => {
    const config = loadConfig({ ...baseOptions, env: {} });

    expect(config.serviceName).toBe("auction-engine");
    expect(config.http.port).toBe(4100);
    expect(config.mongo.uri).toBe("mongodb://127.0.0.1:27017");
    expect(config.redis.url).toBe("redis://127.0.0.1:6379");
    expect(config.i18n.defaultLocale).toBe("en");
    expect(config.i18n.supportedLocales).toEqual(["en", "ru"]);
  });

  it("rejects unsupported locales", () => {
    expect(() =>
      loadConfig({
        ...baseOptions,
        env: {
          I18N_SUPPORTED_LOCALES: "en,es"
        }
      })
    ).toThrow(/Unsupported locale/);
  });

  it("requires default locale to be supported", () => {
    expect(() =>
      loadConfig({
        ...baseOptions,
        env: {
          I18N_SUPPORTED_LOCALES: "ru",
          I18N_DEFAULT_LOCALE: "en"
        }
      })
    ).toThrow(/I18N_DEFAULT_LOCALE/);
  });

  it("rejects invalid port", () => {
    expect(() =>
      loadConfig({
        ...baseOptions,
        env: {
          HTTP_PORT: "0"
        }
      })
    ).toThrow();
  });

  it("prefers MONGODB_URI when provided", () => {
    const config = loadConfig({
      ...baseOptions,
      env: {
        MONGO_URI: "mongodb://ignored:27017",
        MONGODB_URI: "mongodb://mongo:27017"
      }
    });

    expect(config.mongo.uri).toBe("mongodb://mongo:27017");
  });
});
