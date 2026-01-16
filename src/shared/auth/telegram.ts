import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type TelegramWebUser = {
  id: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
  displayName: string;
};

export type TelegramAuthPayload = {
  user: TelegramWebUser;
  authDate: number;
  raw: Record<string, string>;
};

type ParsedInitData = {
  data: Record<string, string>;
  hash: string | null;
};

export function extractTelegramInitData(
  headers: Record<string, string | string[] | undefined>
): string | null {
  const direct = getHeader(headers, "x-telegram-init-data");
  if (direct) {
    return direct;
  }
  const alt = getHeader(headers, "x-telegram-web-app-data");
  if (alt) {
    return alt;
  }
  const authorization = getHeader(headers, "authorization");
  if (authorization && authorization.toLowerCase().startsWith("tma ")) {
    return authorization.slice(4).trim();
  }
  return null;
}

export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds: number
): TelegramAuthPayload | null {
  const parsed = parseInitData(initData);
  if (!parsed.hash) {
    return null;
  }

  const dataCheckString = Object.keys(parsed.data)
    .filter((key) => key !== "hash")
    .sort()
    .map((key) => `${key}=${parsed.data[key]}`)
    .join("\n");

  const secret = createHash("sha256").update(botToken).digest();
  const computedHash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  if (!isHashMatch(computedHash, parsed.hash)) {
    return null;
  }

  const authDate = Number(parsed.data.auth_date);
  if (!Number.isFinite(authDate)) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 60) {
    return null;
  }
  if (maxAgeSeconds > 0 && now - authDate > maxAgeSeconds) {
    return null;
  }

  const rawUser = parsed.data.user;
  if (!rawUser) {
    return null;
  }

  const user = parseTelegramUser(rawUser);
  if (!user) {
    return null;
  }

  return { user, authDate, raw: parsed.data };
}

function parseInitData(initData: string): ParsedInitData {
  const params = new URLSearchParams(initData);
  const data: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    data[key] = value;
  }
  return { data, hash: data.hash ?? null };
}

function parseTelegramUser(rawUser: string): TelegramWebUser | null {
  try {
    const parsed = JSON.parse(rawUser) as {
      id?: number | string;
      first_name?: string;
      last_name?: string;
      username?: string;
      language_code?: string;
    };
    if (!parsed || parsed.id === undefined || parsed.id === null) {
      return null;
    }
    const firstName = typeof parsed.first_name === "string" ? parsed.first_name.trim() : "";
    const lastName = typeof parsed.last_name === "string" ? parsed.last_name.trim() : "";
    const displayName = [firstName, lastName].filter(Boolean).join(" ").trim();
    return {
      id: String(parsed.id),
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      username: typeof parsed.username === "string" ? parsed.username : undefined,
      languageCode: typeof parsed.language_code === "string" ? parsed.language_code : undefined,
      displayName: displayName || (typeof parsed.username === "string" ? parsed.username : "Telegram user")
    };
  } catch {
    return null;
  }
}

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  key: string
): string | null {
  const value = headers[key];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function isHashMatch(computed: string, provided: string): boolean {
  const computedBuffer = Buffer.from(computed, "hex");
  const providedBuffer = Buffer.from(provided, "hex");
  if (computedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return timingSafeEqual(computedBuffer, providedBuffer);
}
