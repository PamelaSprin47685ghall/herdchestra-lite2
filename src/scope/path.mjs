// Scope paths: the address space of a conversation.
//
// Root is `/` and lives outside every scope. Any scope path is `/<seg1>/.../<segN>`
// where each segment satisfies SCOPE_ID_PATTERN and is never `root` (case-insensitive).
// Upscope is the path parent; caller (`ownerId`) is tracked orthogonally on the record.
// This module is pure: it reads a ledger snapshot and returns addresses, with no
// station, no clock, and no I/O.

import { validScopeId } from "./scope-id.mjs";

/** `"/api"` + `"spy"` -> `"/api/spy"`; `""` or `"/"` + `"api"` -> `"/api"`. */
export function subscopePath(upscopePath, name) {
  const upscope = typeof upscopePath === "string" ? upscopePath.trim() : "";
  const seg = typeof name === "string" ? name.trim() : "";
  const base =
    upscope === "" || upscope === "/"
      ? ""
      : `/${upscope.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  if (seg === "") return base === "" ? "/" : base;
  return `${base}/${seg}`;
}

function splitSegments(value) {
  if (typeof value !== "string" || value === "" || value === "/") return [];
  return value.split("/").filter((segment) => segment !== "");
}

/** A target shaped like a pattern is always refused (fail-closed). */
export function looksLikePattern(rawTarget) {
  return typeof rawTarget === "string" && /[*?[]/.test(rawTarget);
}

/**
 * Split a canonical scope path (e.g. `"/api/spy"`) into `{ upscopePath, name }`.
 * Returns null for `"/"` or invalid paths.
 */
export function splitScopePath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path === "/") return null;
  const segments = path.slice(1).split("/");
  if (segments.some((s) => s === "")) return null;
  const name = segments[segments.length - 1];
  const upscopePath = segments.length === 1 ? "/" : `/${segments.slice(0, -1).join("/")}`;
  return { upscopePath, name };
}

/**
 * Strictly resolve one target path against `cwdPath`.
 *
 * Fail-closed rules:
 * - Empty string, non-string, wildcards (`*?[`): refused.
 * - Trailing slash (except `"/"` itself) or empty segment (`//`): refused.
 * - `..` climbing past `"/"`: refused (no silent clamping).
 * - Any segment that is not `"."` or `".."` must satisfy `validScopeId` and must
 *   not equal `"root"` (case-insensitive).
 * - If `allowRoot === false` (e.g. `scope_fork`), resolving to `"/"` is refused.
 */
export function normalizeScopePath(cwdPath = "/", rawTarget = "", { allowRoot = true } = {}) {
  if (typeof rawTarget !== "string") return { ok: false, code: "INVALID_PATH" };
  const target = rawTarget.trim();
  if (target === "") return { ok: false, code: "INVALID_PATH" };
  if (looksLikePattern(target)) return { ok: false, code: "INVALID_PATH", isGlob: true };
  if (target === "/") {
    if (!allowRoot) return { ok: false, code: "INVALID_PATH" };
    return { ok: true, path: "/", isGlob: false };
  }
  if (target.endsWith("/")) return { ok: false, code: "INVALID_PATH" };

  const isAbs = target.startsWith("/");
  const rawParts = (isAbs ? target.slice(1) : target).split("/");
  // Empty segment (`//` or leading `//`) is refused.
  if (rawParts.some((seg) => seg === "")) return { ok: false, code: "INVALID_PATH" };

  const segments = isAbs ? [] : splitSegments(cwdPath);
  for (const segment of rawParts) {
    if (segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return { ok: false, code: "INVALID_PATH" };
      segments.pop();
      continue;
    }
    if (!validScopeId(segment) || segment.toLowerCase() === "root") {
      return { ok: false, code: "INVALID_PATH" };
    }
    segments.push(segment);
  }
  const path = segments.length === 0 ? "/" : `/${segments.join("/")}`;
  if (path === "/" && !allowRoot) return { ok: false, code: "INVALID_PATH" };
  return { ok: true, path, isGlob: false };
}

/** Resolve a `scope_fork` path strictly (`/` is refused; returns `{ ok, path, upscopePath, name }`). */
export function resolveForkPath(cwdPath = "/", rawTarget = "") {
  const norm = normalizeScopePath(cwdPath, rawTarget, { allowRoot: false });
  if (!norm.ok) return norm;
  const parts = splitScopePath(norm.path);
  if (!parts) return { ok: false, code: "INVALID_PATH" };
  return {
    ok: true,
    path: norm.path,
    upscopePath: parts.upscopePath,
    name: parts.name,
  };
}

function recordsOf(ledger) {
  const order = Array.isArray(ledger?.order) ? ledger.order : null;
  if (order === null) return Object.values(ledger?.forks ?? {});
  const out = [];
  for (const forkId of order) {
    const record = ledger.forks?.[forkId];
    if (record && typeof record === "object") out.push(record);
  }
  return out;
}

/** The record's canonical path, falling back to `/<scopeId>` for minimal test fixtures. */
export function scopePathOf(record) {
  if (!record || typeof record !== "object") return null;
  if (typeof record.path === "string" && record.path !== "") return record.path;
  const name =
    typeof record.scopeId === "string" && record.scopeId !== ""
      ? record.scopeId
      : record.forkId;
  return typeof name === "string" && name !== "" ? `/${name}` : null;
}

/**
 * Find one record by path (in any status, case-insensitive).
 * Never returns a record for `"/"` (root has no fork record).
 */
export function findScopeByPath(ledger, path) {
  if (!ledger || typeof ledger !== "object") return null;
  const wanted = typeof path === "string" ? path.trim().toLowerCase() : "";
  if (wanted === "" || wanted === "/") return null;
  for (const record of recordsOf(ledger)) {
    const address = scopePathOf(record);
    if (address !== null && address.toLowerCase() === wanted) return record;
  }
  return null;
}

/** Every fork id with a record at or under `path`, for subtree operations. */
export function forkIdsUnderPath(ledger, path) {
  const base = typeof path === "string" && path !== "" ? path : "/";
  const prefix = base === "/" ? "/" : `${base}/`;
  const ids = [];
  for (const record of recordsOf(ledger)) {
    const address = scopePathOf(record);
    if (address === null) continue;
    if (address === base || address.startsWith(prefix)) ids.push(record.forkId);
  }
  return ids;
}
