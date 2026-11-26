// Wiring for the four fork ports.
//
// A station needs a session-wide ledger, its own identity when it is a child,
// a reader for finished child records, and a spawner. This module supplies all
// four from one registry, so the host never has to know how a bracket pair is
// represented.
//
// The spawner is synchronous by contract: scope_fork must return a receipt in
// the same beat that it starts the child. The real work happens in a ticket
// that is started here and never awaited, with a catch-all so a failure is
// recorded instead of escaping as an unhandled rejection.

import { randomUUID } from "node:crypto";

import {
	adoptLedger,
	createForkRegistry,
	identityForAgent,
	ledgerFor,
	outcomeOf,
	pulse,
	setIdentity,
	setOutcome,
} from "./fork-registry.mjs";
import { createDisplayBinder } from "../station/display-holder.mjs";
import { buildChildIdentity } from "../station/domain/identity.mjs";
import { selectForkLedger } from "../station/domain/fork-ledger.mjs";
import {
	spawnChildTicket,
	wakeIdleScope,
	writeFrozenOutcome,
} from "../tools/spawn-ticket.mjs";

// One base attach and one host bind per station. The holder record lives on
// the wiring object the composition root created, not in a module: a second
// wiring cannot see the first one's stations, and the lifecycle stays where it
// is owned. The base runs before the host composition root exists; the host
// bind adds display and spawner later.
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

/**
 * Bind the fork ports on a station. `SessionStation.bindForkPorts` owns the
 * derivation and the commit; this function only calls it. A station double
 * must be a real `SessionStation` or bind its prototype to receive ports.
 */
function bindForkPorts(station, { registry, ledger, identity }) {
	station.bindForkPorts({
		registry,
		ledger,
		identity,
		childOutcomePort: (forkId) => outcomeOf(registry, forkId),
		setChildOutcome: (forkId, outcome) => setOutcome(registry, forkId, outcome),
	});
}

/**
 * Attach the station-owned fork ports: ledger, wait, identity, ownership and
 * outcome access. This phase never touches display or the spawner.
 *
 * options:
 * - conversationKey: the object or string that names this conversation's ledger
 * - identity: { forkId, parentOwnerId, ownScopeId } when the station is a child
 */
// The ledger names the registry that owns its waiters. That association is the
// reason a child needs no second copy of the registry: the ledger it already
// carries from its identity answers the question. Two registries over one
// ledger would split the waiter set, so a parent's wake would never reach a
// child parked in scope_return, and the join would hang with no visible child.
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
	// Non-enumerable: `copyData` walks own enumerable keys, so the association
	// never enters a persisted snapshot and cannot fail `validLedger`.
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
	// The ledger a child carries already names the registry that holds its
	// parent's waiters. Prefer it over this wiring's registry: a child attached
	// through a second wiring must still park in the parent's waiter set.
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
	// A child must use the ledger its fork was registered on. Its own context
	// may name a different manager object, and deriving the key again would
	// create a second empty ledger: scope_return would then report UNKNOWN_FORK
	// for a fork the parent can see.
	//
	// At the root, the ledger is a field of the persisted scope state. The
	// registry is only a runtime index: a live station wins over a restored
	// empty one, and a restored tree wins over a freshly created empty index.
	const indexed = identity ? null : ledgerFor(registry, conversationKey);
	const restored = station.state?.brackets ?? null;
	const { ledger } = selectForkLedger({ identity, indexed, restored });
	if (!identity) adoptLedger(registry, conversationKey, ledger);
	bindLedgerRegistry(ledger, registry);
	// `SessionStation.bindForkPorts` derives owner/depth/persistence once; a
	// plain test double receives the same capabilities. Never write the legacy
	// duplicate owner field: `forkOwnerId()` is the single owner seam.
	bindForkPorts(station, { registry, ledger, identity });
	const state = { registry, ledger, identity, phase: "base" };
	if (!identity && owner) owner.ledger = ledger;
	statesOf(owner)?.set(station, state);
	return state;
}

// Fork id → host abort handle for children that are still running, keyed by
// the ledger the whole tree shares. A per-station map splits the handles: the
// child's ticket registers on the child's station while the root cascade looks
// on the root's, so a cancelled grandchild keeps working. The ledger object is
// the one identity every level already carries, so it is the right key.
const RUNNING_BY_LEDGER = new WeakMap();

// Fork id → prompt handle for children that have finished but whose session is
// still alive. Same key as the running map, for the same reason: the ledger is
// the one object every level of the tree already carries.
const IDLE_BY_LEDGER = new WeakMap();

function idleMapOf(base) {
	const ledger = base?.ledger;
	if (ledger && typeof ledger === "object") {
		let idle = IDLE_BY_LEDGER.get(ledger);
		if (!idle) {
			idle = new Map();
			IDLE_BY_LEDGER.set(ledger, idle);
		}
		return idle;
	}
	if (!(base.idle instanceof Map)) base.idle = new Map();
	return base.idle;
}

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
	// A station attached without a ledger keeps the old per-state map; nothing
	// can cascade through it, but registration must not throw.
	if (!(base.running instanceof Map)) base.running = new Map();
	return base.running;
}

function spawnPortFor(station, base, binder, options, wiring) {
	if (typeof options.createSession !== "function") return undefined;
	const createSession = options.createSession;
	return () => (spec) => {
		// Bind the ledger to this registry before the child station exists. A
		// child attached through another wiring then still lands on the
		// parent's waiter set instead of a second one nobody wakes.
		bindLedgerRegistry(base.ledger, base.registry);
		// The child's station does not exist yet. Record who it is before the
		// spawn so that station can find its own fork the moment the host
		// builds it.
		const agentId = `fork-${randomUUID()}`;
		// The holder must outlive this spawn: a child created before the UI
		// exists reads the same live slot when the display arrives.
		const displayHolder = binder.holder;
		// Provider IDs are opaque (including slashes and long suffixes).
		// Prebind the generated host ID without changing the fork identity.
		const identity = buildChildIdentity(spec, {
			agentId,
			// What the parent had retired before this fork. The child projects
			// the same transcript, so it must drop the same beats or its outbound
			// prefix stops matching the parent's.
			amends: station.state?.amends ?? [],
			display: binder.currentDisplay(),
			displayHolder,
			ledger: base.ledger,
			// The root branch is the one a reload restores. Give the child the
			// ability to persist that branch when it returns, so a ready record
			// survives a crash before the parent joins.
			persistRoot: () => station.persist?.(),
		});
		setIdentity(base.registry, spec.forkId, identity);
		const ports = {
			registry: base.registry,
			ledger: base.ledger,
			// Queue the attach until a display exists. A child that starts
			// before the UI is still attached when the port arrives.
			display: { attach: binder.attachDisplay },
			prepareChild: options.prepareChild ?? null,
			report: (domain, error, detail) => wiring.report?.(domain, error, detail),
			// The host handle for a live child agent. Registration happens in
			// the ticket, right after the session exists; the cascade deletes
			// the entry as it stops the agent, so one child is stopped once.
			abortChild: options.abortChild ?? null,
			registerRunning: (forkId, abort) => runningMapOf(base).set(forkId, abort),
			unregisterRunning: (forkId) => runningMapOf(base).delete(forkId),
			// A finished child keeps its prompt handle here so a message can wake
			// it in place instead of forcing a new session.
			registerIdle: (forkId, entry) => idleMapOf(base).set(forkId, entry),
			unregisterIdle: (forkId) => idleMapOf(base).delete(forkId),
			// A finished spawn is a ledger change too. The parent's branch
			// persists it, not the child's disappearing one.
			persistLedger: () => station.persist?.(),
			createSession: (input) =>
				createSession({
					...input,
					agentId,
					ownerSession: options.ownerSession ?? null,
					// The host factory reads `sessionManager`; the core passes the
					// token as `manager`, so the boundary names its own key once.
					manager: station.manager ?? null,
				}),
		};
		// The receipt is returned in this beat, so the ticket must not be
		// awaited here. The catch-all is the station's obligation.
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

/**
 * Bind the host-owned fork ports: the display holder and the child spawner.
 * This phase must reuse the base ledger/identity; it never re-runs ledger
 * selection or replaces an existing holder.
 *
 * options:
 * - display: a display holder shared with a child, a display port, or null
 * - createSession: (spec) => Promise<{ ok, session, limitations }>
 * - ownerSession: the session a child is derived from
 * - prepareChild: optional child-context preparation
 * - maxResultChars / maxThinkingChars: replay truncation
 */
export function bindHostForkPorts(station, wiring, options = {}) {
	const states = statesOf(wiring);
	let base = states?.get(station);
	if (!base) base = attachBaseForkPorts(station, wiring, options);
	base = states?.get(station) ?? base;

	// A wiring that was never created is still a legal attach; reads must not
	// throw on it, and the spawner needs this wiring to report through.
	const host = wiring && typeof wiring === "object" ? wiring : {};
	// A cancelled subtree must stop the agents that are still working. The
	// ledger close is the source of truth; this map only carries the host
	// handle the ticket registered, and the cascade deletes each entry before
	// it runs, so one child is stopped once.
	if (station && typeof station === "object") {
		station.abortChildrenPort = (forkIds, abandonedIds = []) => {
			const running = runningMapOf(base);
			const idle = idleMapOf(base);
			for (const forkId of forkIds ?? []) {
				const abort = running.get(forkId);
				if (typeof abort === "function") {
					running.delete(forkId);
					try {
						abort();
					} catch (error) {
						host.report?.("fork", error, { forkId, phase: "cascade" });
					}
				}
				// A returned or joined child woken by `scope_send` still owns a
				// live prompt loop. Stop it too and remove the idle entry.
				const entry = idle.get(forkId);
				const idleAbort = entry?.abort;
				if (typeof idleAbort === "function") {
					idle.delete(forkId);
					try {
						idleAbort();
					} catch (error) {
						host.report?.("fork", error, { forkId, phase: "cascade-idle" });
					}
				}
			}
			// Drop stale idle handles for abandoned (now FAILED) branches so a
			// cancelled scope cannot later be woken through a leftover entry.
			for (const forkId of abandonedIds ?? []) {
				idle.delete(forkId);
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

	// A holder passed in is shared with the parent; a port is wrapped in a
	// fresh holder; null starts empty and accepts a late UI.
	const binder = createDisplayBinder({ display: options.display, report: (domain, error, detail) => host.report?.(domain, error, detail) });
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
	// A message that names a finished scope reaches this port, which drives the
	// session the spawn ticket left idle. The ticket owns the loop; this only
	// hands it the fork id.
	station.childWakePort = () => (forkId) => {
		const entry = idleMapOf(base).get(forkId);
		if (!entry) return null;
		const running = wakeIdleScope(entry, base.ledger, forkId);
		running?.catch?.((error) => {
			host.report?.("fork", error, { forkId, phase: "wake" });
		});
		return running;
	};
	if (base && typeof base === "object") {
		base.binder = binder;
		base.phase = "host";
	}
	return { registry: base?.registry, ledger: base?.ledger };
}

/** A fresh wiring: one registry and one station lifecycle for the process. */
export function createForkWiring(adapters = {}, bindings = {}) {
	const wiring = {
		registry: createForkRegistry(adapters),
		states: new WeakMap(),
		ledger: null,
		report: bindings.report ?? null,
		spawn: bindings.spawn ?? null,
	};
	// The two phases are methods on the object that owns their state: a second
	// wiring cannot reach the first one's stations, and a caller never has to
	// pass the wiring back to the module that made it.
	wiring.attach = (station, options) => attachBaseForkPorts(station, wiring, options);
	wiring.bind = (station, options) => bindHostForkPorts(station, wiring, options);
	// Identity lookup needs the registry and nothing else. Exposing it on the
	// wiring keeps ledger surgery out of the host package.
	wiring.identityForAgent = (agentId) => identityForAgent(wiring.registry, agentId);
	return wiring;
}
