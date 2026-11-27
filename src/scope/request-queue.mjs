// scope_request / scope_reply: a question with an answer, between scopes.
//
// The caller's `await api.scope_request({ target, message, interrupt })` parks
// on a Promise stored here; the target learns about the request when its next
// request builds the REPL probe, which finds the queue head and collapses the
// projection to AWAITING_REPLY. Its `api.scope_reply(text)` resolves that
// Promise, and the caller's script continues on the next line with the text in
// hand.
//
// Two structural guards keep a fork tree from deadlocking itself in silence:
//
// 1. Deadlock refusal. `waitFor` records who is parked on whom, for both
//    scope_request and scope_join. Before a request is queued, a bounded
//    reachability walk asks whether the target is already (transitively)
//    waiting on the caller. If it is, the request is refused at the door
//    instead of parking two scopes that can never wake each other.
// 2. FIFO. Every target has one queue, so concurrent requests are answered in
//    arrival order and each takes exactly one AWAITING_REPLY turn.
//
// The edges carry a reference count, not a bare Set member: one caller may
// legitimately be parked on the same target twice (a join and a request inside
// one Promise.all), and the first to finish must not erase the second's edge.
//
// Everything here is process memory. A reload cannot replay a conversation that
// is no longer running, so nothing is persisted; a caller that dies takes its
// parked Promise with it.

/** The interrupt reason for a scope_request, distinct from a user abort. */
export const REQUEST_INTERRUPT_REASON = Symbol.for("herdchestra-lite2.scope-request-interrupt.v1");

const CYCLE_LIMIT = 10_000;

function failure(code, reason) {
  return { ok: false, code, reason };
}

function createWaiter() {
  let resolve = null;
  let reject = null;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// The registry is a plain holder; these tables are created on first use so a
// registry built by an older wiring still works unchanged.
function requestsOf(registry) {
  if (!(registry.requests instanceof Map)) registry.requests = new Map();
  return registry.requests;
}

function requestQueue(registry, path) {
  const map = requestsOf(registry);
  let queue = map.get(path);
  if (!queue) {
    queue = [];
    map.set(path, queue);
  }
  return queue;
}

function waitForMap(registry) {
  if (!(registry.waitFor instanceof Map)) registry.waitFor = new Map();
  return registry.waitFor;
}

function edgeRefs(registry) {
  if (!(registry.waitEdgeRefs instanceof Map)) registry.waitEdgeRefs = new Map();
  return registry.waitEdgeRefs;
}

/** Who is parked on whom, with one reference per outstanding wait. */
export function addWaitEdge(registry, waiterPath, targetPath) {
  if (typeof waiterPath !== "string" || waiterPath === "") return false;
  if (typeof targetPath !== "string" || targetPath === "") return false;
  if (waiterPath === targetPath) return false;
  const refs = edgeRefs(registry);
  let row = refs.get(waiterPath);
  if (!row) {
    row = new Map();
    refs.set(waiterPath, row);
  }
  row.set(targetPath, (row.get(targetPath) ?? 0) + 1);
  const map = waitForMap(registry);
  let targets = map.get(waiterPath);
  if (!targets) {
    targets = new Set();
    map.set(waiterPath, targets);
  }
  targets.add(targetPath);
  return true;
}

/**
 * Drop one reference to one edge. The caller owns the wait it registered, so
 * this must be called exactly once per add — a scope that cancels a request, a
 * join that returns, a target that dies.
 */
export function removeWaitEdge(registry, waiterPath, targetPath) {
  const refs = registry.waitEdgeRefs;
  const row = refs instanceof Map ? refs.get(waiterPath) : null;
  if (!row) return false;
  const count = row.get(targetPath) ?? 0;
  const map = waitForMap(registry);
  if (count <= 1) {
    row.delete(targetPath);
    if (row.size === 0) refs.delete(waiterPath);
    map.get(waiterPath)?.delete(targetPath);
    if (map.get(waiterPath)?.size === 0) map.delete(waiterPath);
    return true;
  }
  row.set(targetPath, count - 1);
  return true;
}

/** Every path this one is parked on, for diagnostics and tests. */
export function waitEdgesOf(registry, waiterPath) {
  const targets = waitForMap(registry).get(waiterPath);
  return targets ? [...targets] : [];
}

/**
 * Whether queuing a request from `callerPath` to `targetPath` would close a wait
 * cycle. A scope requesting itself is the degenerate case of the same question.
 */
export function wouldCycle(registry, callerPath, targetPath) {
  if (typeof callerPath !== "string" || callerPath === "") return false;
  if (typeof targetPath !== "string" || targetPath === "") return false;
  if (callerPath === targetPath) return true;
  const map = waitForMap(registry);
  const seen = new Set([targetPath]);
  const queue = [targetPath];
  let steps = 0;
  while (queue.length > 0) {
    if (steps >= CYCLE_LIMIT) return true;
    steps += 1;
    const current = queue.shift();
    for (const next of map.get(current) ?? []) {
      if (next === callerPath) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

/**
 * Queue one request and hand back the Promise the caller parks on.
 *
 * Everything here is synchronous: the queue is mutated, the wait edge is
 * registered, and the Promise is created before this function returns. The
 * delivery decision (interrupt, yield a join, wake an idle scope) belongs to
 * the station, which owns the agent handles; this function only records.
 */
export function enqueueRequest(registry, { from, target, message, interrupt = false } = {}) {
  if (typeof from !== "string" || from === "") {
    return failure("INVALID_REQUESTER", "scope_request needs a caller path.");
  }
  if (typeof target !== "string" || target === "") {
    return failure("INVALID_SCOPE_TARGET", "scope_request needs a target path.");
  }
  const text = typeof message === "string" ? message : "";
  if (text.trim() === "") {
    return failure("INVALID_MESSAGE", "scope_request needs a non-empty message.");
  }
  if (wouldCycle(registry, from, target)) {
    return failure(
      "REQUEST_DEADLOCK_CYCLE",
      `Request from ${from} to ${target} would close a wait cycle.`,
    );
  }
  registry.requestSeq = (Number.isInteger(registry.requestSeq) ? registry.requestSeq : 0) + 1;
  const id = `request-${registry.requestSeq}`;
  const waiter = createWaiter();
  const entry = {
    id,
    from,
    target,
    message: text,
    interrupt: interrupt === true,
    delivered: false,
    createdAt: Date.now(),
    resolve: waiter.resolve,
    reject: waiter.reject,
    promise: waiter.promise,
  };
  requestQueue(registry, target).push(entry);
  addWaitEdge(registry, from, target);
  return { ok: true, id, promise: entry.promise, entry };
}

/** The request waiting at the head of this scope's queue, if any. */
export function currentRequest(registry, path) {
  const queue = requestsOf(registry).get(path);
  if (!Array.isArray(queue) || queue.length === 0) return null;
  return queue[0] ?? null;
}

/**
 * Mark the queue head as seen by this scope's REPL probe. Called once, by the
 * projection that put the scope into AWAITING_REPLY.
 */
export function markRequestDelivered(registry, path) {
  const head = currentRequest(registry, path);
  if (!head) return null;
  if (head.delivered !== true) {
    head.delivered = true;
    head.deliveredAt = Date.now();
  }
  return head;
}

export function hasPendingRequests(registry, path) {
  const queue = requestsOf(registry).get(path);
  return Array.isArray(queue) && queue.length > 0;
}

export function pendingRequestCount(registry, path) {
  const queue = requestsOf(registry).get(path);
  return Array.isArray(queue) ? queue.length : 0;
}

/**
 * Answer the head request. Only a delivered head may be answered: the model can
 * only call scope_reply while the projection said AWAITING_REPLY, and this
 * refuses a stale or speculative call.
 */
export function resolveRequest(registry, path, text) {
  const head = currentRequest(registry, path);
  if (!head) return failure("NO_PENDING_REQUEST", `${path} has no request to answer.`);
  if (head.delivered !== true) {
    return failure("REQUEST_NOT_DELIVERED", `${path} has not read the request yet.`);
  }
  const map = requestsOf(registry);
  const queue = map.get(path);
  queue.shift();
  if (queue.length === 0) map.delete(path);
  if (head.edgeRemoved !== true) removeWaitEdge(registry, head.from, path);
  try {
    head.resolve(String(text ?? ""));
  } catch (error) {
    return failure("REQUEST_REPLY_FAILED", String(error?.message ?? error));
  }
  return { ok: true, entry: head };
}

/**
 * Withdraw one request. Only an undelivered entry can be withdrawn: once the
 * target has seen it, its scope_reply will land harmlessly into a settled
 * Promise, and cancelling would only make the target answer nothing.
 */
export function cancelRequest(registry, targetPath, id) {
  const map = requestsOf(registry);
  const queue = map.get(targetPath);
  if (!Array.isArray(queue)) return false;
  const index = queue.findIndex((entry) => entry.id === id && entry.delivered !== true);
  if (index < 0) return false;
  const [entry] = queue.splice(index, 1);
  if (queue.length === 0) map.delete(targetPath);
  if (entry.edgeRemoved !== true) removeWaitEdge(registry, entry.from, targetPath);
  try {
    entry.reject(new Error("The request was withdrawn before the target read it."));
  } catch {
    // The caller already settled its own Promise; a rejection nobody awaits is
    // not an error.
  }
  return true;
}

/**
 * Withdraw one request whose caller is gone, even after the target printed it.
 *
 * A delivered entry left at the FIFO head would starve every later request
 * behind a reply nobody is waiting for. Removing it lets the next request
 * become the head; the target's later scope_reply simply finds no pending
 * request instead of stealing a sibling's answer.
 */
export function withdrawRequest(
  registry,
  targetPath,
  id,
  reason = "The requesting scope interrupted before the answer arrived.",
) {
  const map = requestsOf(registry);
  const queue = map.get(targetPath);
  if (!Array.isArray(queue)) return false;
  const index = queue.findIndex((entry) => entry.id === id);
  if (index < 0) return false;
  const [entry] = queue.splice(index, 1);
  if (queue.length === 0) map.delete(targetPath);
  if (entry.edgeRemoved !== true) removeWaitEdge(registry, entry.from, targetPath);
  try {
    entry.reject(new Error(reason));
  } catch {
    // Already settled.
  }
  return true;
}

/**
 * A target stopped existing. Every request parked on it fails now, so no caller
 * waits forever on a scope that can never answer.
 */
export function rejectPendingRequests(
  registry,
  path,
  reason = "The target scope terminated before answering.",
) {
  const map = requestsOf(registry);
  const queue = map.get(path);
  if (!Array.isArray(queue) || queue.length === 0) return 0;
  map.delete(path);
  let rejected = 0;
  for (const entry of queue) {
    if (entry.edgeRemoved !== true) removeWaitEdge(registry, entry.from, path);
    try {
      entry.reject(new Error(reason));
      rejected += 1;
    } catch {
      // Already settled.
    }
  }
  return rejected;
}

/**
 * Forget every trace of one scope's own parked waits: the requests it made
 * (their edges die with it) and the requests waiting on it. The station calls
 * this when a scope finishes or is abandoned.
 */
export function forgetScope(registry, path) {
  const rejected = rejectPendingRequests(registry, path);
  const map = waitForMap(registry);
  map.delete(path);
  for (const targets of map.values()) targets.delete(path);
  registry.waitEdgeRefs?.delete?.(path);
  registry.requests?.delete?.(path);
  return rejected;
}

// --- delivery table ---------------------------------------------------------
//
// One entry per scope path, kept on the registry because a request's target is
// normally another station. The fields are the hooks the asking side calls: a
// missing hook simply skips that delivery branch, which is the correct
// behaviour for a scope that will read the queue at its own next request.
//
//   state:     "running" | "idle"
//   parked:    "join" while the scope is parked in a join and must yield it
//   interrupt: cut the running beat short (scope_request with interrupt: true)
//   wake:      drive a turn for an idle or finished scope
//   yieldJoin: abandon the parked join so the reply turn can happen

/** The path -> runtime entry table, created on first use. */
export function runtimeTable(registry) {
  if (!(registry.requestRuntime instanceof Map)) registry.requestRuntime = new Map();
  return registry.requestRuntime;
}

/**
 * Merge one scope's delivery hooks. Merging keeps fields this patch omits, so
 * a scope going idle keeps whatever the running phase registered.
 */
export function registerRuntime(registry, path, entry) {
  if (typeof path !== "string" || path === "") return null;
  if (!entry || typeof entry !== "object") return null;
  const table = runtimeTable(registry);
  const current = table.get(path);
  const next = { ...(current && typeof current === "object" ? current : {}) };
  // `parked` is a Set of park ids, not a boolean. A string adds one id, a Set
  // merges, `null` clears. `parkedRemove` removes exactly one id, so two
  // concurrent joins in one beat cannot erase each other's marker.
  const parked = current?.parked instanceof Set
    ? new Set(current.parked)
    : typeof current?.parked === "string" && current.parked !== ""
      ? new Set([current.parked])
      : new Set();
  let parkedTouched = false;
  if (Object.hasOwn(entry, "parked")) {
    parkedTouched = true;
    if (entry.parked === null) parked.clear();
    else if (typeof entry.parked === "string" && entry.parked !== "") parked.add(entry.parked);
    else if (entry.parked instanceof Set) {
      for (const id of entry.parked) if (typeof id === "string" && id !== "") parked.add(id);
    }
  }
  if (typeof entry.parkedRemove === "string" && entry.parkedRemove !== "") {
    parkedTouched = true;
    parked.delete(entry.parkedRemove);
  }
  if (parkedTouched) {
    if (parked.size > 0) next.parked = parked;
    else delete next.parked;
  }
  // Yield hooks are keyed by park id. A request yields every current join,
  // because one join returning cannot free a beat parked on two.
  const yieldJoins = current?.yieldJoins instanceof Map
    ? new Map(current.yieldJoins)
    : new Map();
  if (Object.hasOwn(entry, "yieldJoin")) {
    if (typeof entry.parked === "string" && entry.parked !== "") {
      if (typeof entry.yieldJoin === "function") yieldJoins.set(entry.parked, entry.yieldJoin);
      else yieldJoins.delete(entry.parked);
    } else if (entry.yieldJoin === null || entry.yieldJoin === undefined) {
      delete next.yieldJoin;
      yieldJoins.clear();
    } else {
      next.yieldJoin = entry.yieldJoin;
    }
  }
  if (typeof entry.parkedRemove === "string" && entry.parkedRemove !== "") {
    yieldJoins.delete(entry.parkedRemove);
  }
  if (yieldJoins.size > 0) next.yieldJoins = yieldJoins;
  else delete next.yieldJoins;
  for (const [key, value] of Object.entries(entry)) {
    if (key === "parked" || key === "parkedRemove" || key === "yieldJoin") continue;
    next[key] = value;
  }
  table.set(path, next);
  return next;
}

/** The entry for one path, or null. */
export function runtimeOf(registry, path) {
  if (typeof path !== "string" || path === "") return null;
  const entry = runtimeTable(registry).get(path);
  return entry && typeof entry === "object" ? entry : null;
}

/**
 * Drop one scope's hooks. A scope that can never take another turn must not
 * look wakeable, or a later request parks on a hook nobody services.
 */
export function clearRuntime(registry, path) {
  if (typeof path !== "string" || path === "") return false;
  return runtimeTable(registry).delete(path);
}
