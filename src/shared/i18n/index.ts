// Localization helpers with fallback support.
import type { Locale } from "../config";
import enCatalog from "./en";
import ruCatalog from "./ru";

export type Catalog = Record<string, string>;

const defaultLocale: Locale = "en";
const supportedLocales: Locale[] = ["en", "ru"];
const catalogs: Record<Locale, Catalog> = {
  en: enCatalog,
  ru: ruCatalog
};

function parseLocaleCandidate(value: string): string {
  const cleaned = value.toLowerCase().trim();
  const normalized = cleaned.replace("_", "-");
  return normalized.split("-")[0] ?? normalized;
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) {
    return template;
  }

  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      return String(params[key]);
    }

    return match;
  });
}

export function resolveLocale(
  input: string | undefined,
  fallback: Locale = defaultLocale,
  supported: Locale[] = supportedLocales
): Locale {
  if (!input) {
    return fallback;
  }

  const candidates = input
    .split(",")
    .map((entry) => entry.split(";")[0] ?? entry)
    .map((entry) => parseLocaleCandidate(entry))
    .filter((entry) => entry.length > 0);

  for (const candidate of candidates) {
    if (supported.includes(candidate as Locale)) {
      return candidate as Locale;
    }
  }

  return fallback;
}

export function t(
  key: string,
  locale: string | undefined,
  params?: Record<string, string | number>,
  fallback: Locale = defaultLocale
): string {
  const resolved = resolveLocale(locale, fallback);
  const primaryCatalog = catalogs[resolved] ?? catalogs[fallback];
  const fallbackCatalog = catalogs[fallback];
  const template = primaryCatalog[key] ?? fallbackCatalog[key] ?? key;

  return interpolate(template, params);
}
