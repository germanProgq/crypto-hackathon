// Localization fallback tests.
import { describe, expect, it } from "vitest";
import { resolveLocale, t } from "../src/shared/i18n";

describe("i18n", () => {
  it("resolves locale from Accept-Language", () => {
    expect(resolveLocale("ru-RU,ru;q=0.9,en;q=0.8", "en")).toBe("ru");
    expect(resolveLocale("en-US,en;q=0.8", "ru")).toBe("en");
  });

  it("falls back to English for unsupported locales", () => {
    expect(t("common.ok", "de")).toBe("OK");
  });

  it("returns key when missing in all catalogs", () => {
    expect(t("missing.key", "ru")).toBe("missing.key");
  });
});
