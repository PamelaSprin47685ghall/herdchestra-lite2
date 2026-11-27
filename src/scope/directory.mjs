// Global scope directory projection and delta calculation.
//
// Pure domain module: reads a bracket ledger snapshot and formats the global
// directory map (`path -> "running|done | <model> | <ctx> / <window>"`) plus
// overwrite-semantics delta against a station's `lastSeenDir`.

import { forkOf } from "./ledger-charge.mjs";
import { scopePathOf } from "./path.mjs";

/**
 * Format a token count compactly (`14k`, `1.5k`, `200k`, `1.2M`, or `?` when unmeasured).
 */
export function formatContextK(tokens) {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return "?";
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}M`;
  }
  const k = tokens / 1000;
  return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}

/**
 * Format canonical `provider/id[:thinking]` (or `unknown` when unresolved).
 */
export function formatDirModel(model, thinkingLevel = null) {
  const m = typeof model === "string" && model.trim() !== "" ? model.trim() : null;
  if (!m) return "unknown";
  const t = typeof thinkingLevel === "string" && thinkingLevel.trim() !== ""
    ? thinkingLevel.trim()
    : null;
  if (!t || m.endsWith(`:${t}`)) return m;
  return `${m}:${t}`;
}

/** Format one directory entry string. */
export function formatDirectoryEntry({
  status = "running",
  model = null,
  thinkingLevel = null,
  contextTokens = null,
  contextWindow = null,
} = {}) {
  const state = status === "running" ? "running" : "done";
  const modelStr = formatDirModel(model, thinkingLevel);
  const ctxStr = formatContextK(contextTokens);
  const winStr = formatContextK(contextWindow);
  if (state === "running") {
    return `running | ${modelStr} | ${ctxStr}+ / ${winStr}`;
  }
  return `done | ${modelStr} | ${ctxStr} / ${winStr}`;
}

/**
 * Project the entire global scope directory from a bracket ledger.
 * Includes Root `/` (always `running`) and every registered fork in
 * lexicographic path order.
 *
 * @returns {Map<string, string>}
 */
export function projectDirectory(ledger) {
  const entries = new Map();
  const root = ledger?.root && typeof ledger.root === "object" ? ledger.root : {};
  entries.set(
    "/",
    formatDirectoryEntry({
      status: "running",
      model: root.model ?? null,
      thinkingLevel: root.thinkingLevel ?? null,
      contextTokens: root.dirContextTokens ?? root.contextTokens ?? null,
      contextWindow: root.contextWindow ?? null,
    }),
  );

  const forks = [];
  for (const forkId of ledger?.order ?? []) {
    const record = forkOf(ledger, forkId);
    if (!record) continue;
    const path = scopePathOf(record);
    if (typeof path !== "string" || path === "") continue;
    forks.push({ path, record });
  }
  forks.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  for (const { path, record } of forks) {
    const isRunning = record.status === "running";
    entries.set(
      path,
      formatDirectoryEntry({
        status: isRunning ? "running" : "done",
        model: record.resolvedModel ?? record.model ?? null,
        thinkingLevel: record.resolvedThinking ?? null,
        contextTokens: isRunning
          ? (record.birthContextTokens ?? null)
          : (record.snapshotContextTokens ?? record.birthContextTokens ?? null),
        contextWindow: record.contextWindow ?? null,
      }),
    );
  }
  return entries;
}

/**
 * Compute overwrite-semantics delta from `lastSeenDir` to `currentDir`.
 * Returns a plain object `{ [path]: entryString }`, or `null` when identical.
 */
export function diffDirectory(lastSeenDir, currentDir) {
  if (!(currentDir instanceof Map)) return null;
  const prev = lastSeenDir instanceof Map ? lastSeenDir : null;
  const delta = {};
  let count = 0;
  for (const [path, line] of currentDir) {
    if (prev && prev.get(path) === line) continue;
    delta[path] = line;
    count += 1;
  }
  return count > 0 ? delta : null;
}
