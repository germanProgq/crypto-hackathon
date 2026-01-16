// Retention helpers for computing expiry dates.
const msPerDay = 24 * 60 * 60 * 1000;

export function resolveRetentionMs(days: number): number {
  if (!Number.isFinite(days) || days <= 0) {
    return 0;
  }
  return Math.floor(days) * msPerDay;
}

export function computeExpiresAt(from: Date, retentionMs: number): Date | undefined {
  if (!retentionMs || retentionMs <= 0) {
    return undefined;
  }
  return new Date(from.getTime() + retentionMs);
}
