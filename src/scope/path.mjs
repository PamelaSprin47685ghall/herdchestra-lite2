// Scope paths: the address space of a conversation.
//
// Root is `/` and lives outside every scope. A child's path is its parent's
// path plus `/<scopeId>`, so the tree the ledger already records in
// `parentForkId` is its own address space: sibling uniqueness plus the parent
// chain, never a global name table. This module is pure. It reads a ledger
// snapshot and returns an address, with no station, no clock, and no I/O.
//
// There is no wildcard engine. `scope_request` takes one exact path; a script that
// wants several scopes maps over `state.scopes` itself, which is ordinary
// JavaScript and needs no address language here.

/** `"/api"` + `"auth"` -> `"/api/auth"`; the root is spelled `/`. */
export function childScopePath(parentPath, scopeId) {
  const parent = typeof parentPath === "string" ? parentPath.trim() : "";
  const name = typeof scopeId === "string" ? scopeId.trim() : "";
  const base = parent === "" || parent === "/"
    ? ""
    : `/${parent.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  if (name === "") return base === "" ? "/" : base;
  return `${base}/${name}`;
}

function splitSegments(value) {
  if (typeof value !== "string" || value === "" || value === "/") return [];
  return value.split("/").filter((segment) => segment !== "");
}

/** A target shaped like a pattern is refused by callers, never resolved here. */
export function looksLikePattern(rawTarget) {
  return typeof rawTarget === "string" && /[*?[]/.test(rawTarget);
}

/**
 * Resolve one target against the caller's path.
 *
 * `.` is the caller, `..` is its parent (clamped at the root), a bare name is
 * a child, and a leading `/` starts at the root. `isGlob` only reports that
 * the target carries `*`, `?` or `[`: the address is still normalized, so a
 * caller can name the pattern it refused in its error message.
 */
export function normalizeScopePath(cwdPath = "/", rawTarget = "") {
  const target = typeof rawTarget === "string" ? rawTarget.trim() : "";
  if (target === "") return { ok: false, code: "INVALID_SCOPE_TARGET" };
  const isGlob = looksLikePattern(target);
  const segments = target.startsWith("/") ? [] : splitSegments(cwdPath);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return {
    ok: true,
    path: segments.length === 0 ? "/" : `/${segments.join("/")}`,
    isGlob,
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

function siblingOwnerOf(record) {
  if (!record) return null;
  if (record.parentForkId !== undefined) {
    return typeof record.parentForkId === "string" && record.parentForkId !== ""
      ? record.parentForkId
      : null;
  }
  return typeof record.ownerId === "string" && record.ownerId !== "root"
    ? record.ownerId
    : null;
}

/**
 * The lowest free sibling name. A finished scope keeps its name while it can
 * still be asked a question or joined, so the taken set covers every record of
 * that parent, not only the running ones.
 */
export function allocateSiblingScopeId(
  ledger,
  parentForkId,
  requestedScopeId,
  reservedInBatch = new Set(),
) {
  const requested = typeof requestedScopeId === "string" ? requestedScopeId.trim() : "";
  if (requested === "") return requested;
  const parent =
    typeof parentForkId === "string" && parentForkId !== "root" ? parentForkId : null;
  const taken = new Set();
  for (const record of recordsOf(ledger)) {
    if (siblingOwnerOf(record) !== parent) continue;
    if (typeof record.scopeId !== "string" || record.scopeId === "") continue;
    taken.add(record.scopeId.toLowerCase());
  }
  for (const name of reservedInBatch ?? []) {
    if (typeof name === "string" && name !== "") taken.add(name.toLowerCase());
  }
  if (!taken.has(requested.toLowerCase())) return requested;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${requested}-${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** The record's address, falling back to its name for older snapshots. */
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
 * One record by address, in any status. A finished scope is still addressable:
 * `scope_request` wakes it for one reply turn, and `scope_join` takes its ready
 * record. Case-insensitive, matching the sibling namespace's own rule.
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

/** Active means it is running work right now. */
export function isScopeActive(record) {
  return Boolean(record && record.status === "running");
}

/** Every running path, the root first, then lexicographic order. */
export function listActiveScopePaths(ledger) {
  const paths = new Set(["/"]);
  for (const record of recordsOf(ledger)) {
    if (!isScopeActive(record)) continue;
    const path = scopePathOf(record);
    if (path !== null) paths.add(path);
  }
  return [...paths].sort();
}

/**
 * Every address a `scope_request` can still reach: running, returned, and
 * joined scopes keep a live agent that answers one reply turn. A failed or
 * abandoned record cannot answer, so it is not offered as a target.
 */
export function listAddressableScopePaths(ledger) {
  const paths = new Set(["/"]);
  for (const record of recordsOf(ledger)) {
    if (record.status === "failed") continue;
    // A record whose outcome failed never produced a session that answers: a
    // spawn the host refused, or a child that died before returning. Offering
    // the address would park every `scope_request` sent there forever.
    if (record.outcome === "failed") continue;
    const path = scopePathOf(record);
    if (path !== null) paths.add(path);
  }
  return [...paths].sort();
}
