/**
 * Canonical runtime narrowing for the untrusted wire. Everything from
 * `/ws` and `/api/*` enters through these guards, then the reducer works with
 * typed views.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter((item) => item.length > 0)
    : [];
}

export function capText(value: string, limit = 1_000_000): string {
  return value.length > limit
    ? `${value.slice(0, limit)}\n… [truncated]`
    : value;
}
