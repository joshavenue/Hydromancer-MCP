/**
 * Friendly time inputs. Non-technical users (and models) should not have to compute
 * Unix milliseconds, so every time argument accepts:
 *   - a relative span back from now: "30m", "6h", "24h", "7d", "2w"
 *   - a date or date-time: "2026-10-01", "2026-10-01T12:00:00Z"
 *   - a Unix timestamp in milliseconds or seconds
 *   - "now"
 */

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

export function parseTime(input: string | number | undefined, now: number = Date.now()): number | undefined {
  if (input === undefined || input === null || input === "") return undefined;
  if (typeof input === "number") return normaliseEpoch(input);
  const s = String(input).trim().toLowerCase();
  if (s === "now") return now;
  const rel = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)(\s+ago)?$/.exec(s);
  if (rel) {
    const unit = rel[2][0];
    return Math.round(now - Number(rel[1]) * UNIT_MS[unit]);
  }
  if (/^\d{9,13}$/.test(s)) return normaliseEpoch(Number(s));
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : String(input).trim();
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    throw new Error(`Could not understand the time "${input}". Use something like "24h", "7d", "2026-10-01" or "2026-10-01T12:00:00Z".`);
  }
  return t;
}

function normaliseEpoch(n: number): number {
  // 10-digit values are seconds; 13-digit values are milliseconds.
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export const timeDescription =
  'Relative ("30m", "6h", "24h", "7d"), a date ("2026-10-01"), a date-time ("2026-10-01T12:00:00Z"), "now", or Unix ms.';
