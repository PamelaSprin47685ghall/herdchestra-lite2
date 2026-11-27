// Session-wide fork registry: one ledger per conversation, child outcomes,
// live interrupt hooks, and the waits that make scope_join block.
//
// The station is per agent, so nothing about a fork tree may live on it. This
// module is the holder the wiring injects as the four ports. It holds no host
// objects: a ledger is plain data, and every wait is a plain Promise.

import { createBracketLedger, markReady } from "./ledger-brackets.mjs";
import { normalizeTargets, validTargets } from "./targets.mjs";

function createWaiter() {
  let resolve = null;
  let reject = null;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function createForkRegistry({ conversationKeyOf: keyOf = conversationKeyOf, sameManager: same = sameManager } = {}) {
  return {
    // The host supplies the two session predicates. The defaults below read
    // only a session-id string, so a test or a bare registry works unchanged.
    conversationKeyOf: keyOf,
    sameManager: same,
    // One ledger per conversation key. A SessionManager, a session object, or
    // a test string all work as a key.
    ledgers: new WeakMap(),
    ledgerKeyed: new Map(),
    outcomes: new Map(),
    identities: new Map(),
    agentForks: new Map(),
    waiters: new Set(),
    // Live interrupt hooks keyed by forkId (registered while a child session is active).
    liveInterrupts: new Map(),
  };
}

/**
 * Record who a subscope is. Called before the spawn, so the subscope's station
 * can find its identity as soon as the host builds it.
 */
export function setIdentity(registry, forkId, identity) {
  if (typeof forkId !== "string" || forkId === "") return false;
  if (!identity || typeof identity !== "object") return false;
  registry.identities.set(forkId, {
    forkId,
    callerId:
      typeof identity.callerId === "string"
        ? identity.callerId
        : (typeof identity.parentOwnerId === "string" ? identity.parentOwnerId : null),
    parentOwnerId:
      typeof identity.callerId === "string"
        ? identity.callerId
        : (typeof identity.parentOwnerId === "string" ? identity.parentOwnerId : null),
    path: typeof identity.path === "string" ? identity.path : null,
    upscopePath: typeof identity.upscopePath === "string" ? identity.upscopePath : null,
    callerPath: typeof identity.callerPath === "string" ? identity.callerPath : null,
    ownScopeId: typeof identity.ownScopeId === "string" ? identity.ownScopeId : null,
    fsm: typeof identity.fsm === "string" ? identity.fsm : null,
    budget:
      identity.budget && typeof identity.budget === "object" ? { ...identity.budget } : null,
    time: Number.isFinite(identity.time) && identity.time > 0 ? identity.time : null,
    targets: validTargets(identity.targets)
      ? normalizeTargets(identity.targets)
      : null,
    childDepth: Number.isInteger(identity.childDepth) ? identity.childDepth : null,
    display: identity.display ?? null,
    displayHolder:
      identity.displayHolder &&
      typeof identity.displayHolder === "object" &&
      "current" in identity.displayHolder
        ? identity.displayHolder
        : null,
    ledger:
      identity.ledger && typeof identity.ledger === "object" ? identity.ledger : null,
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

/** Resolve a subscope identity from the agent id the host reports on a context. */
export function identityForAgent(registry, agentId) {
  if (typeof agentId !== "string" || agentId === "") return null;
  const forkId = registry.agentForks.get(agentId);
  return forkId ? identityOf(registry, forkId) : null;
}

export function bindAgent(registry, forkId, agentId) {
  if (typeof forkId !== "string" || forkId === "") return false;
  if (typeof agentId !== "string" || agentId === "") return false;
  const identity = registry.identities.get(forkId) ?? {
    forkId,
    callerId: null,
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

export function registerLiveInterrupt(registry, forkId, interruptFn) {
  if (!registry || typeof forkId !== "string" || forkId === "") return false;
  if (!(registry.liveInterrupts instanceof Map)) registry.liveInterrupts = new Map();
  if (typeof interruptFn === "function") {
    registry.liveInterrupts.set(forkId, interruptFn);
  } else {
    registry.liveInterrupts.delete(forkId);
  }
  return true;
}

export function unregisterLiveInterrupt(registry, forkId) {
  if (!registry || !(registry.liveInterrupts instanceof Map)) return false;
  return registry.liveInterrupts.delete(forkId);
}

export function interruptFork(registry, forkId) {
  if (!registry || !(registry.liveInterrupts instanceof Map)) return false;
  const fn = registry.liveInterrupts.get(forkId);
  if (typeof fn !== "function") return false;
  fn();
  return true;
}

export function conversationKeyOf(manager) {
  const value =
    typeof manager?.getSessionId === "function" ? manager.getSessionId() : null;
  return typeof value === "string" && value !== ""
    ? `session:${value}`
    : (manager ?? null);
}

export function sameManager(station, token) {
  const key = token ?? null;
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

export function ledgerFor(registry, key = null) {
  const objectKey = key !== null && typeof key === "object";
  if (objectKey) {
    let ledger = registry.ledgers.get(key);
    if (!ledger) {
      ledger = createBracketLedger();
      registry.ledgers.set(key, ledger);
    }
    return ledger;
  }
  const name = typeof key === "string" && key !== "" ? key : "";
  let ledger = registry.ledgerKeyed.get(name);
  if (!ledger) {
    ledger = createBracketLedger();
    registry.ledgerKeyed.set(name, ledger);
  }
  return ledger;
}

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
    abandoned: value.abandoned === true,
    abandonedBy: typeof value.abandonedBy === "string" ? value.abandonedBy : null,
    abandonReason: typeof value.abandonReason === "string" ? value.abandonReason : null,
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

/**
   * Register one waiter: build its Promise, queue it, and wire the abort signal.
   * Synchronous, so the queue stays the registry's own state; the awaiting half
   * lives in the join-wait ticket.
   */
  export function openWaiter(registry, signal) {
    const waiter = createWaiter();
    registry.waiters.add(waiter);
    const onAbort = () => {
      registry.waiters.delete(waiter);
      waiter.resolve({ ok: false, code: "INTERRUPTED", reason: "The wait was interrupted." });
    };
    if (signal && typeof signal.addEventListener === "function") {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const release = () => {
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
      registry.waiters.delete(waiter);
    };
    return { promise: waiter.promise, release };
  }

/** Signal that a fork is ready, for callers that mark without waiting. */
export function pulse(registry, ledger, forkId, outcome = null) {
  let marked = { ok: true };
  if (forkId) {
    marked = markReady(ledger, forkId, {
      ok: outcome?.failed !== true,
      abandoned: outcome?.abandoned === true,
      abandonedBy: outcome?.abandonedBy ?? null,
      abandonReason: outcome?.abandonReason ?? null,
      reason: outcome?.reason ?? null,
      record: outcome?.record,
    });
  }
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
