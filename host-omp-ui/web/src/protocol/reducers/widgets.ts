import type { WidgetEntry } from "../types";
import { asString, isRecord } from "../guards";

export function normalizeWidgets(raw: unknown): Record<string, string[] | null> | null {
  if (Array.isArray(raw)) {
    const widgets: Record<string, string[]> = {};
    for (const entry of raw) {
      if (!isRecord(entry)) continue;
      const key = asString(entry.key);
      if (!key) continue;
      widgets[key] = Array.isArray(entry.lines)
        ? entry.lines.map(String)
        : typeof entry.lines === "string"
          ? [entry.lines]
          : [];
    }
    return widgets;
  }
  if (isRecord(raw)) {
    const widgets: Record<string, string[] | null> = {};
    for (const [key, value] of Object.entries(raw)) {
      widgets[key] = value === null
        ? null
        : Array.isArray(value)
          ? value.map(String)
          : typeof value === "string"
            ? [value]
            : null;
    }
    return widgets;
  }
  return null;
}

export function normalizeWidgetEntries(raw: unknown): WidgetEntry[] {
  const map = normalizeWidgets(raw) ?? {};
  return Object.entries(map)
    .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]))
    .map(([key, lines]) => ({ key, lines }));
}
