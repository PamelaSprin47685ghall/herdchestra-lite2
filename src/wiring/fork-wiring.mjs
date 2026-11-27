// Wiring for the four fork ports.

import { randomUUID } from "node:crypto";

import {
  adoptLedger,
  createForkRegistry,
  identityForAgent,
  interruptFork,
  ledgerFor,
  outcomeOf,
  pulse,
  setIdentity,
  setOutcome,
} from "../scope/fork-registry.mjs";
import { createDisplayBinder } from "../station/display-holder.mjs";
import { buildChildIdentity } from "../station/domain/identity.mjs";
import { selectForkLedger } from "../station/domain/fork-ledger.mjs";
import {
  spawnChildTicket,
  writeFrozenOutcome,
} from "../tools/spawn-ticket.mjs";

function statesOf(wiring) {
  const owner = wiring && typeof wiring === "object" ? wiring : null;
  if (!owner) return null;
  if (!(owner.states instanceof WeakMap)) {
    Object.defineProperty(owner, "states", {
      value: new WeakMap(),
      enumerable: false,
      configurable: true,
    });
  }
  return owner.states;
}

function bindForkPorts(station, { registry, ledger, identity }) {
  station.bindForkPorts({
    registry,
    ledger,
    identity,
    childOutcomePort: (forkId) => outcomeOf(registry, forkId),
    setChildOutcome: (forkId, outcome) => setOutcome(registry, forkId, outcome),
  });
  if (station && typeof station === "object") {
    station.interruptScopePort = (forkId) => interruptFork(registry, forkId);
  }
}

const LEDGER_REGISTRY = Symbol.for("herdchestra-lite2.ledger-registry.v1");

function registryOfLedger(ledger) {
  if (!ledger || typeof ledger !== "object") return null;
  const registry = ledger[LEDGER_REGISTRY];
  return registry && typeof registry === "object" ? registry : null;
}

function bindLedgerRegistry(ledger, registry) {
  if (!ledger || typeof ledger !== "object") return null;
  if (!registry || typeof registry !== "object") return null;
  const bound = registryOfLedger(ledger);
  if (bound) return bound;
  Object.defineProperty(ledger, LEDGER_REGISTRY, {
    value: registry,
    enumerable: false,
    configurable: true,
  });
  return registry;
}

export function attachBaseForkPorts(station, wiring, options = {}) {
  const owner = wiring && typeof wiring === "object" ? wiring : null;
  const identity =
    options.identity && typeof options.identity === "object" ? options.identity : null;
  const carrier = identity?.ledger ?? station?.state?.brackets ?? null;
  const registry =
    registryOfLedger(carrier) ??
    owner?.registry ??
    createForkRegistry(owner?.adapters);
  if (!station || typeof station !== "object") {
    return { registry, ledger: null, identity: null };
  }
  const existing = statesOf(owner)?.get(station);
  if (existing) return existing;

  const conversationKey = options.conversationKey ?? null;
  const indexed = identity ? null : ledgerFor(registry, conversationKey);
  const restored = station.state?.brackets ?? null;
  const { ledger } = selectForkLedger({ identity, indexed, restored });
  if (!identity) adoptLedger(registry, conversationKey, ledger);
  bindLedgerRegistry(ledger, registry);
  bindForkPorts(station, { registry, ledger, identity });
  const state = { registry, ledger, identity, phase: "base" };
  if (!identity && owner) owner.ledger = ledger;
  statesOf(owner)?.set(station, state);
  return state;
}

const RUNNING_BY_LEDGER = new WeakMap();

function runningMapOf(base) {
  const ledger = base?.ledger;
  if (ledger && typeof ledger === "object") {
    let running = RUNNING_BY_LEDGER.get(ledger);
    if (!running) {
      running = new Map();
      RUNNING_BY_LEDGER.set(ledger, running);
    }
    return running;
  }
  if (!(base.running instanceof Map)) base.running = new Map();
  return base.running;
}

function spawnPortFor(station, base, binder, options, wiring) {
  if (typeof options.createSession !== "function") return undefined;
  const createSession = options.createSession;
  return () => (spec) => {
    bindLedgerRegistry(base.ledger, base.registry);
    const agentId = `fork-${randomUUID()}`;
    const displayHolder = binder.holder;
    const identity = buildChildIdentity(spec, {
      agentId,
      display: binder.currentDisplay(),
      displayHolder,
      ledger: base.ledger,
      persistRoot: () => station.persist?.(),
    });
    setIdentity(base.registry, spec.forkId, identity);
    const ports = {
      registry: base.registry,
      ledger: base.ledger,
      display: { attach: binder.attachDisplay },
      prepareChild: options.prepareChild ?? null,
      report: (domain, error, detail) => wiring.report?.(domain, error, detail),
      abortChild: options.abortChild ?? null,
      interruptChild: options.interruptChild ?? options.abortChild ?? null,
      registerRunning: (forkId, abort) => runningMapOf(base).set(forkId, abort),
      unregisterRunning: (forkId) => runningMapOf(base).delete(forkId),
      persistLedger: () => station.persist?.(),
      createSession: (input) =>
        createSession({
          ...input,
          agentId,
          ownerSession: options.ownerSession ?? null,
          manager: station.manager ?? null,
        }),
    };
    (wiring.spawn ?? spawnChildTicket)(spec, ports).catch((error) => {
      wiring.report?.("fork", error, { forkId: spec.forkId, phase: "ticket" });
      writeFrozenOutcome(base.registry, spec.forkId, {
        record: "",
        failed: true,
        reason: String(error?.message ?? error),
      });
      pulse(base.registry, base.ledger, spec.forkId, outcomeOf(base.registry, spec.forkId));
    });
    return true;
  };
}

export function bindHostForkPorts(station, wiring, options = {}) {
  const states = statesOf(wiring);
  let base = states?.get(station);
  if (!base) base = attachBaseForkPorts(station, wiring, options);
  base = states?.get(station) ?? base;

  const host = wiring && typeof wiring === "object" ? wiring : {};
  if (station && typeof station === "object") {
    station.abortChildrenPort = (forkIds, _abandonedIds = [], liveIds = forkIds) => {
      const running = runningMapOf(base);
      const stopped = new Set();
      for (const forkId of liveIds ?? []) {
        if (stopped.has(forkId)) continue;
        stopped.add(forkId);
        const abort = running.get(forkId);
        if (typeof abort === "function") {
          running.delete(forkId);
          try {
            abort();
          } catch (error) {
            host.report?.("fork", error, { forkId, phase: "cascade" });
          }
        }
      }
    };
  }
  const existing = base?.binder ? base : null;
  if (existing) {
    if (Object.hasOwn(options, "display")) existing.binder.updateDisplay(options.display);
    if (typeof options.createSession === "function") {
      station.childSpawnPort = spawnPortFor(station, base, existing.binder, options, host);
    }
    return { registry: base.registry, ledger: base.ledger };
  }

  const binder = createDisplayBinder({
    display: options.display,
    report: (domain, error, detail) => host.report?.(domain, error, detail),
  });
  station.displayPort = binder.currentDisplay;
  station.setDisplayPort = (port) => binder.setDisplayPort(port);
  station.noteRootWait = !base.identity
    ? (delta) => binder.currentDisplay()?.rootWait?.(delta)
    : null;
  station.noteScopeRequest = base.ledger
    ? () => binder.currentDisplay()?.request(base.ledger, station.forkOwnerId?.() ?? null)
    : null;
  const spawn = spawnPortFor(station, base, binder, options, host);
  if (spawn) station.childSpawnPort = spawn;
  if (base && typeof base === "object") {
    base.binder = binder;
    base.phase = "host";
  }
  return { registry: base?.registry, ledger: base?.ledger };
}

export function createForkWiring(adapters = {}, bindings = {}) {
  const wiring = {
    registry: createForkRegistry(adapters),
    states: new WeakMap(),
    ledger: null,
    report: bindings.report ?? null,
    spawn: bindings.spawn ?? null,
  };
  wiring.attach = (station, options) => attachBaseForkPorts(station, wiring, options);
  wiring.bind = (station, options) => bindHostForkPorts(station, wiring, options);
  wiring.identityForAgent = (agentId) => identityForAgent(wiring.registry, agentId);
  return wiring;
}
