// Scope paths: the address space of a conversation.
//
// Root is `/` and lives outside every scope. A child's path is its parent's
// path plus `/<scopeId>`, so the tree the ledger already records in
// `parentForkId` is its own address space: sibling uniqueness plus the parent
// chain, never a global name table. This module is pure. It reads a ledger
// snapshot and returns an address, or a set of addresses, with no station, no
// clock, and no I/O.

const WILDCARD = /[*?[]/;

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

/**
 * Resolve one target against the caller's path.
 *
 * `.` is the caller, `..` is its parent (clamped at the root), a bare name is
 * a child, and a leading `/` starts at the root. A target that carries `*`,
 * `?` or `[` is a glob and is reported as one; normalization still applies,
 * so `../*` becomes `/<parent>/*`.
 */
export function normalizeScopePath(cwdPath = "/", rawTarget = "") {
  const target = typeof rawTarget === "string" ? rawTarget.trim() : "";
  if (target === "") return { ok: false, code: "INVALID_SCOPE_TARGET" };
  const isGlob = WILDCARD.test(target);
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
 * still be woken, so the taken set covers every record of that parent, not
 * only the running ones.
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

/** Active means it can take a message now: running, or woken from finished. */
export function isScopeActive(record) {
  return Boolean(record && (record.status === "running" || record.woken === true));
}

/** Every unfinished path, the root first, then lexicographic order. */
export function listActiveScopePaths(ledger) {
  const paths = new Set(["/"]);
  for (const record of recordsOf(ledger)) {
    if (!isScopeActive(record)) continue;
    const path = scopePathOf(record);
    if (path !== null) paths.add(path);
  }
  return [...paths].sort();
}

function matchSegments(pattern, index, segments, cursor) {
  if (index === pattern.length) return cursor === segments.length;
  const head = pattern[index].toLowerCase();
  if (head === "**") {
    for (let next = cursor; next <= segments.length; next += 1) {
      if (matchSegments(pattern, index + 1, segments, next)) return true;
    }
    return false;
  }
  if (head === "*") {
    if (cursor >= segments.length) return false;
    // A trailing star means the rest of the tree, so `**` and `*` differ only
    // where the star sits in the middle of a pattern.
    if (index === pattern.length - 1) return true;
    return matchSegments(pattern, index + 1, segments, cursor + 1);
  }
  if (cursor >= segments.length) return false;
  if (segments[cursor].toLowerCase() !== head) return false;
  return matchSegments(pattern, index + 1, segments, cursor + 1);
}

function matchesGlob(pattern, path) {
  return matchSegments(splitSegments(pattern), 0, splitSegments(path), 0);
}

function noMatch() {
  return { ok: false, code: "NO_MATCHING_SCOPES", targets: [], paths: [] };
}

const matchesNothing = null;

/**
 * Turn one target, or a list of them, into concrete addresses.
 *
 * An exact path names any scope, active or finished; naming a finished scope
 * is how a wake is asked for. A glob names active scopes only, because a
 * broadcast must never resurrect a scope nobody asked about, and it never
 * names the sender itself.
 */
export function resolveScopeTargets(ledger, callerPath = "/", targetInput = "") {
  const inputs = Array.isArray(targetInput) ? targetInput : [targetInput];
  if (inputs.length === 0) return noMatch();
  const caller = normalizeScopePath("/", callerPath);
  const callerId = caller.ok ? caller.path : "/";
  const targets = [];
  const seen = new Set();
  const push = (target) => {
    if (seen.has(target.path)) return;
    seen.add(target.path);
    targets.push(target);
  };
  for (const entry of inputs) {
    const norm = normalizeScopePath(callerId, entry);
    if (!norm.ok) return { ok: false, code: norm.code, targets: [], paths: [] };
    if (!norm.isGlob) {
      if (norm.path === "/") {
        push({ kind: "root", path: "/" });
        continue;
      }
      const found = recordsOf(ledger).find((record) => {
        const path = scopePathOf(record);
        return path !== null && path.toLowerCase() === norm.path.toLowerCase();
      });
      if (!found) {
        return {
          ok: false,
          code: "UNKNOWN_SCOPE_TARGET",
          target: norm.path,
          targets: [],
          paths: [],
        };
      }
      push({ kind: "scope", forkId: found.forkId, path: scopePathOf(found) });
      continue;
    }
    // A bare `**` is the whole tree, not the caller's subtree.
    const raw = typeof entry === "string" ? entry.trim() : "";
    const pattern = raw === "**" ? "/**" : norm.path;
    for (const record of recordsOf(ledger)) {
      if (!isScopeActive(record)) continue;
      const path = scopePathOf(record);
      if (path === null || path === "/") continue;
      if (path.toLowerCase() === callerId.toLowerCase()) continue;
      if (!matchesGlob(pattern, path)) continue;
      push({ kind: "scope", forkId: record.forkId, path });
    }
  }
  if (targets.length === 0) return noMatch();
  targets.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { ok: true, targets, paths: targets.map((target) => target.path) };
}

export { matchesNothing };
