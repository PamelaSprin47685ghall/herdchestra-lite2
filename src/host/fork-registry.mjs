// Session-wide fork registry: one ledger per conversation, child outcomes,
// and the waits that make scope_join and scope_return block.
//
// The station is per agent, so nothing about a fork tree may live on it. This
// module is the holder the wiring injects as the four ports. It holds no host
// objects: a ledger is plain data, and every wait is a plain Promise.

import { forkOf, markReady, takeReady } from "../scope/index.mjs";
import { normalizeTargets, validTargets } from "../scope/targets.mjs";

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

export function createForkRegistry() {
  return {
    // One ledger per conversation key. A SessionManager, a session object, or
    // a test string all work as a key.
    ledgers: new WeakMap(),
    ledgerKeyed: new Map(),
    outcomes: new Map(),
    // A child is assembled after its fork is registered, so its station exists
    // later than its identity. The table is written before the spawn and read
    // when that station is built; a child that never appears leaves an entry
    // behind, which is harmless and visible in statsOf().
    identities: new Map(),
    // Which child agent belongs to which fork. The host reports an agent id on
    // the context, and that id is the only stable handle a child station has
    // when it looks for its own fork.
    agentForks: new Map(),
    waiters: new Set(),
  };
}

/**
 * Record who a child is. Called before the spawn, so the child's station can
 * find its identity as soon as the host builds it.
 */
export function setIdentity(registry, forkId, identity) {
  if (typeof forkId !== "string" || forkId === "") return false;
  if (!identity || typeof identity !== "object") return false;
  registry.identities.set(forkId, {
    forkId,
    parentOwnerId:
      typeof identity.parentOwnerId === "string" ? identity.parentOwnerId : null,
    ownScopeId: typeof identity.ownScopeId === "string" ? identity.ownScopeId : null,
    // The child's own scope needs the same shape the parent declared. These
    // are data, not decisions: the station opens the scope when it reads them.
    intent: typeof identity.intent === "string" ? identity.intent : null,
    budget:
      identity.budget && typeof identity.budget === "object" ? { ...identity.budget } : null,
    time: Number.isFinite(identity.time) && identity.time > 0 ? identity.time : null,
    targets: validTargets(identity.targets)
      ? normalizeTargets(identity.targets)
      : null,
    childDepth: Number.isInteger(identity.childDepth) ? identity.childDepth : null,
    // The bracket ledger is per conversation, not per agent. A child's tool
    // context may expose a different manager object, so the ledger must travel
    // with the identity; deriving it again from the child context can create a
    // second empty ledger and turn scope_return into UNKNOWN_FORK.
    display: identity.display ?? null,
    // A holder is live: the interactive UI may arrive after this identity is
    // recorded. Keep the holder itself so a late display reaches the child
    // station without rewriting the identity.
    displayHolder:
      identity.displayHolder &&
      typeof identity.displayHolder === "object" &&
      "current" in identity.displayHolder
        ? identity.displayHolder
        : null,
    ledger:
      identity.ledger && typeof identity.ledger === "object" ? identity.ledger : null,
    // A capability, not data: the root branch's persist function, so a child
    // writes its return into the branch a reload actually restores.
    persistRoot:
      typeof identity.persistRoot === "function" ? identity.persistRoot : null,
  });
  if (typeof identity.agentId === "string" && identity.agentId !== "") {
    registry.agentForks.set(identity.agentId, forkId);
  }
  return true;
}

export function identityOf(registry, forkId) {
  if (typeof forkId !== "string" || forkId === "") return null;
  return registry.identities.get(forkId) ?? null;
}

/** Resolve a child identity from the agent id the host reports on a context. */
export function identityForAgent(registry, agentId) {
  if (typeof agentId !== "string" || agentId === "") return null;
  const forkId = registry.agentForks.get(agentId);
  return forkId ? identityOf(registry, forkId) : null;
}

/** The host's agent id for a context, or null. */
export function agentIdOf(ctx) {
  const direct = ctx?.agent?.id;
  if (typeof direct === "string" && direct !== "") return direct;
  const fallback = ctx?.agentId;
  return typeof fallback === "string" && fallback !== "" ? fallback : null;
}

/**
 * Attach the host's agent id to a fork that was already registered. The id
 * only exists after the child session is built, while the fork itself exists
 * before it, so identity is bound in two steps.
 */
export function bindAgent(registry, forkId, agentId) {
  if (typeof forkId !== "string" || forkId === "") return false;
  if (typeof agentId !== "string" || agentId === "") return false;
  const identity = registry.identities.get(forkId) ?? {
    forkId,
    parentOwnerId: null,
    ownScopeId: null,
  };
  registry.identities.set(forkId, { ...identity, forkId });
  registry.agentForks.set(agentId, forkId);
  return true;
}

export function clearIdentity(registry, forkId) {
  const identity = identityOf(registry, forkId);
  if (!identity) return false;
  registry.identities.delete(forkId);
  for (const [agentId, value] of registry.agentForks) {
    if (value === forkId) registry.agentForks.delete(agentId);
  }
  return true;
}

/**
 * The conversation key for one fork tree, derived the same way everywhere.
 *
 * A session id string survives the branch manager proxy: the proxy answers
 * `getSessionId()` with the shared session id, so a parent and its child land
 * on the same ledger. Without an id, the manager object is the best available
 * identity and stays stable for that conversation.
 */
export function conversationKeyOf(manager) {
  const value =
    typeof manager?.getSessionId === "function" ? manager.getSessionId() : null;
  return typeof value === "string" && value !== ""
    ? `session:${value}`
    : (manager ?? null);
}

/**
 * Whether a station belongs to the current context's session. A session switch
 * must never route the next stop to the old station; the session id survives a
 * branch manager proxy, so compare it when the manager object differs.
 */
export function sameManager(station, ctx) {
  const key = ctx?.sessionManager ?? ctx;
  if (!key || !station?.manager) return false;
  if (station.manager === key) return true;
  try {
    const live = key.getSessionId?.();
    const armed = station.manager.getSessionId?.();
    return Boolean(live && armed && live === armed);
  } catch {
    return false;
  }
}

/**
 * Pick the station that owns a session stop. The pending handoff belongs to
 * one session; a different manager clears it. Return `clearPending` so the
 * registry keeps the only mutable field.
 */
export function selectStopStation({ station, pendingStation, ctx }) {
  if (station.state.relay?.handoffPending) return { station, clearPending: false };
  if (!pendingStation) return { station, clearPending: false };
  if (!sameManager(pendingStation, ctx)) return { station, clearPending: true };
  if (pendingStation.state.relay?.handoffPending) {
    return { station: pendingStation, clearPending: false };
  }
  return { station, clearPending: false };
}

/**
 * The ledger for one conversation. `key` is any object or string; a missing
 * key falls back to a single shared ledger, which keeps a one-branch test
 * honest without inventing a second tree.
 */
export function ledgerFor(registry, key = null) {
  const objectKey = key !== null && typeof key === "object";
  if (objectKey) {
    let ledger = registry.ledgers.get(key);
    if (!ledger) {
      ledger = createLedger();
      registry.ledgers.set(key, ledger);
    }
    return ledger;
  }
  const name = typeof key === "string" && key !== "" ? key : "";
  let ledger = registry.ledgerKeyed.get(name);
  if (!ledger) {
    ledger = createLedger();
    registry.ledgerKeyed.set(name, ledger);
  }
  return ledger;
}

function createLedger() {
  return {
    version: 1,
    seq: 0,
    closedSeq: 0,
    receiveSeq: 0,
    forks: {},
    order: [],
    queues: {},
    levels: {},
  };
}

/**
 * Bind a ledger to a conversation key. The station owns its ledger in the
 * persisted state; the registry is only the runtime index. Adopting keeps
 * `ledgerFor()` and `forkLedgerPort()` naming the same object.
 */
export function adoptLedger(registry, key, ledger) {
  if (!registry || !ledger || typeof ledger !== "object") return false;
  if (key !== null && typeof key === "object") {
    registry.ledgers.set(key, ledger);
  } else {
    registry.ledgerKeyed.set(typeof key === "string" ? key : "", ledger);
  }
  return true;
}

export function setOutcome(registry, forkId, outcome) {
  if (typeof forkId !== "string" || forkId === "") return false;
  const value = outcome && typeof outcome === "object" ? outcome : {};
  registry.outcomes.set(forkId, {
    record: typeof value.record === "string" ? value.record : "",
    failed: value.failed === true,
    reason: typeof value.reason === "string" ? value.reason : null,
  });
  return true;
}

export function outcomeOf(registry, forkId) {
  return registry.outcomes.get(forkId) ?? null;
}

export function clearOutcome(registry, forkId) {
  return registry.outcomes.delete(forkId);
}

/** Wake every wait so each one re-checks its own condition. */
export function notifyWaiters(registry) {
  const pending = [...registry.waiters];
  registry.waiters.clear();
  for (const waiter of pending) {
    try {
      waiter.resolve({ ok: true });
    } catch {
      // A waiter that cannot resume is a bug in the waiter, not in the queue.
    }
  }
}

function attachSignal(registry, signal, waiter) {
  if (!signal || typeof signal.addEventListener !== "function") {
    return () => {};
  }
  const onAbort = () => {
    registry.waiters.delete(waiter);
    waiter.resolve({ ok: false, code: "INTERRUPTED", reason: "The wait was interrupted." });
  };
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener?.("abort", onAbort);
}

async function park(registry, signal) {
  const waiter = createWaiter();
  registry.waiters.add(waiter);
  const detach = attachSignal(registry, signal, waiter);
  try {
    return await waiter.promise;
  } finally {
    detach();
    registry.waiters.delete(waiter);
  }
}

/**
 * Parent side: take the first returned child, parking until one arrives or
 * the signal aborts. A wake with no ready child simply parks again, so a
 * spurious wake costs no work.
 */
export async function waitForReady(registry, ledger, options = {}) {
  const ownerId = options.ownerId;
  const levelKey = options.levelKey;
  const signal = options.signal ?? null;
  const canTake = typeof options.canTake === "function" ? options.canTake : null;
  const admit = typeof options.admit === "function" ? options.admit : null;
  for (;;) {
    // The caller's admission may go stale while it waits. Checking before
    // every take makes a refusal leave the queue exactly as it found it.
    const guard = canTake ? canTake() : null;
    if (guard && guard.ok === false) return failure(guard.code, guard.reason);
    const taken = takeReady(ledger, { ownerId, levelKey, admit });
    if (taken.ok) return taken;
    // Capacity is not a race: a ready record that cannot fit will not become
    // deliverable by waiting for another event. Answer now and keep it ready.
    if (taken.code === "NO_ADMISSIBLE_CHILD") {
      return failure("JOIN_CONTEXT_EXCEEDED", taken.reason, {
        blocked: taken.blocked,
      });
    }
    if (signal?.aborted) {
      return failure("JOIN_INTERRUPTED", "The join was interrupted; the children keep running.");
    }
    const woke = await park(registry, signal);
    if (woke?.ok === false) {
      return failure("JOIN_INTERRUPTED", "The join was interrupted; the children keep running.");
    }
  }
}

/**
 * Child side: mark this branch ready, then park until a parent takes it. The
 * mark happens before the wait, so a parent that arrives later still finds
 * the record in its queue.
 */
export async function waitForJoin(registry, ledger, forkId, options = {}) {
  const signal = options.signal ?? null;
  const outcome = options.outcome ?? null;
  const record = forkOf(ledger, forkId);
  if (!record) return failure("UNKNOWN_FORK", `Unknown fork "${forkId}".`);
  if (record.status === "running") {
    const marked = markReady(ledger, forkId, {
      ok: outcome?.failed !== true,
      reason: outcome?.reason ?? null,
      record: outcome?.record,
    });
    if (!marked.ok) return failure(marked.code, marked.reason);
    notifyWaiters(registry);
  }
  for (;;) {
    const current = forkOf(ledger, forkId);
    if (!current) return failure("UNKNOWN_FORK", `Unknown fork "${forkId}".`);
		if (current.status === "joined") return { ok: true, fork: current };
		// A failed bracket will never be taken. Waiting on it would hang the
		// child for the life of the session, so the failure ends the wait.
		if (current.status === "failed") {
			return failure(
				"RETURN_REJECTED",
				`Fork "${forkId}" was abandoned before a receiver took it.`,
			);
		}
		if (signal?.aborted) {
      return failure("RETURN_INTERRUPTED", "The return was interrupted; the bracket stays open.");
    }
    const woke = await park(registry, signal);
    if (woke?.ok === false) {
      return failure("RETURN_INTERRUPTED", "The return was interrupted; the bracket stays open.");
    }
  }
}

/** Signal that a fork is ready, for callers that mark without waiting. */
export function pulse(registry, ledger, forkId, outcome = null) {
  let marked = { ok: true };
  if (forkId) {
    marked = markReady(ledger, forkId, {
      ok: outcome?.failed !== true,
      reason: outcome?.reason ?? null,
      record: outcome?.record,
    });
  }
  // Waking is not conditional on this mark succeeding. A child that already
  // froze its record at scope_return makes markReady fail with ALREADY_READY,
  // and returning there left the parent parked forever while the record sat
  // ready. Waiters re-check their own condition, so a wake that changes
  // nothing costs one loop iteration and never loses a record.
  notifyWaiters(registry);
  return marked;
}

export function statsOf(registry) {
  return {
    ledgers: registry.ledgerKeyed.size,
    outcomes: registry.outcomes.size,
    waiters: registry.waiters.size,
  };
}
