// Wiring for the fork capabilities.
//
// One process-wide container (`ForkProcess`) holds every fact that must outlive a
// single extension instance: the fork registry, the ledger index per conversation,
// the running set per ledger, the per-station attach record, and the display
// holder. The container is a plain field on the wiring object the host keeps, so
// a parent and its child reach the same objects by reading the same wiring
// instead of by agreeing on a global symbol. No `Symbol.for` carrier, no
// module-level table, no lazy property definition.
//
// Each station receives one immutable `ForkContext`; a stage that owns more
// capabilities re-enters `bindForkPorts` with the fields it owns, so no stage
// patches a slot on the station.

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
import { bindProcessLedger } from "../station/domain/fork-ledger.mjs";
import { createForkProcess } from "../station/domain/fork-context.mjs";
import {
	spawnChildTicket,
	writeFrozenOutcome,
} from "../tools/spawn-ticket.mjs";

/**
 * The process container for this wiring, created on first use.
 *
 * A test may call `attachBaseForkPorts(station, {})` with a bare object; the
 * container becomes a plain field on that object rather than a module global, so
 * two wirings never share one by accident.
 */
function processOf(wiring, registry) {
	const owner = wiring && typeof wiring === "object" ? wiring : null;
	if (!owner) return null;
	if (!owner.process) owner.process = createForkProcess({ registry });
	return owner.process;
}

/** The per-station attach record. A field on the wiring, never a module table. */
function statesOf(wiring) {
	const owner = wiring && typeof wiring === "object" ? wiring : null;
	if (!owner) return null;
	if (!(owner.states instanceof WeakMap)) owner.states = new WeakMap();
	return owner.states;
}

// One bundle per station, assembled in one place. The base stage owns the
// registry, the ledger and the capabilities derived from them; the host stage
// re-enters through the same method with the fields it owns.
function bindForkPorts(station, { registry, ledger, identity }) {
	station.bindForkPorts({
		registry,
		ledger,
		identity,
		childOutcomePort: (forkId) => outcomeOf(registry, forkId),
		setChildOutcome: (forkId, outcome) => setOutcome(registry, forkId, outcome),
		interruptScopePort: (forkId) => interruptFork(registry, forkId),
	});
}

// Which registry published a ledger. A module-private key, not a global
// carrier: it never leaves this file, so two copies of the package cannot
// silently agree on it, and a child station that inherits a ledger from a
// different registry still finds the right one.
const LEDGER_OWNER = Symbol("fork.ledger-owner");

function registryOfLedger(ledger) {
	if (!ledger || typeof ledger !== "object") return null;
	const registry = ledger[LEDGER_OWNER];
	return registry && typeof registry === "object" ? registry : null;
}

function bindLedgerOwner(ledger, registry) {
	if (!ledger || typeof ledger !== "object" || !registry) return;
	if (ledger[LEDGER_OWNER]) return;
	Object.defineProperty(ledger, LEDGER_OWNER, {
		value: registry,
		enumerable: false,
		configurable: true,
	});
}

export function attachBaseForkPorts(station, wiring, options = {}) {
	const owner = wiring && typeof wiring === "object" ? wiring : null;
	const identity =
		options.identity && typeof options.identity === "object" ? options.identity : null;
	// A ledger may have been published by another registry (a child inheriting
	// its parent's tree); otherwise this wiring owns the tree's registry.
	const carrier = identity?.ledger ?? station?.state?.brackets ?? null;
	const registry =
		registryOfLedger(carrier) ?? owner?.registry ?? createForkRegistry(owner?.adapters);
	if (!station || typeof station !== "object") {
		return { registry, ledger: null, identity: null };
	}
	const process = processOf(owner, registry);
	const existing = statesOf(owner)?.get(station);
	if (existing) return existing;

	const conversationKey = options.conversationKey ?? null;
	const restored = station.state?.brackets ?? null;
	// Identity first, then the live index, then the restored tree. The process
	// container is the index, so a sibling station in the same conversation finds
	// the ledger the first one published.
	const { ledger } = bindProcessLedger(process, {
		key: conversationKey,
		identity,
		restored,
		ledgerFor,
		adoptLedger,
	});
	bindLedgerOwner(ledger, registry);
	bindForkPorts(station, { registry, ledger, identity });
	const state = { registry, ledger, identity, phase: "base" };
	if (!identity && owner) owner.ledger = ledger;
	statesOf(owner)?.set(station, state);
	return state;
}

function runningMapOf(base, process) {
	const ledger = base?.ledger;
	const table = process?.runningByLedger ?? null;
	if (ledger && typeof ledger === "object" && table) {
		let running = table.get(ledger);
		if (!running) {
			running = new Map();
			table.set(ledger, running);
		}
		return running;
	}
	if (!(base.running instanceof Map)) base.running = new Map();
	return base.running;
}

function spawnPortFor(station, base, binder, options, wiring, process) {
	if (typeof options.createSession !== "function") return undefined;
	const createSession = options.createSession;
	return () => (spec) => {
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
			registerRunning: (forkId, abort) => runningMapOf(base, process).set(forkId, abort),
			unregisterRunning: (forkId) => runningMapOf(base, process).delete(forkId),
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
	const process = processOf(wiring, base?.registry ?? null);

	const host = wiring && typeof wiring === "object" ? wiring : {};
	if (station && typeof station === "object") {
		station.bindForkPorts({
			abortChildrenPort: (forkIds, _abandonedIds = [], liveIds = forkIds) => {
				const running = runningMapOf(base, process);
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
			},
		});
	}
	const existing = base?.binder ? base : null;
	if (existing) {
		if (Object.hasOwn(options, "display")) existing.binder.updateDisplay(options.display);
		if (typeof options.createSession === "function") {
			station.bindForkPorts({
				childSpawnPort: spawnPortFor(station, base, existing.binder, options, host, process),
			});
		}
		return { registry: base.registry, ledger: base.ledger };
	}

	// A station's display is its own live handle: two sessions in one process
	// must not paint into each other's sink. The binder owns the holder.
	const binder = createDisplayBinder({
		display: options.display,
		report: (domain, error, detail) => host.report?.(domain, error, detail),
	});
	// The display pair stays on the station: the binder owns a live UI handle,
	// not station state. Everything else joins the one capability bundle.
	station.displayPort = binder.currentDisplay;
	station.setDisplayPort = (port) => binder.setDisplayPort(port);
	const spawn = spawnPortFor(station, base, binder, options, host, process);
	station.bindForkPorts({
		noteRootWait: !base.identity
			? (delta) => binder.currentDisplay()?.rootWait?.(delta)
			: null,
		noteScopeRequest: base.ledger
			? () => binder.currentDisplay()?.request(base.ledger, station.forkOwnerId?.() ?? null)
			: null,
		childSpawnPort: spawn ?? null,
	});
	if (base && typeof base === "object") {
		base.binder = binder;
		base.phase = "host";
	}
	return { registry: base?.registry, ledger: base?.ledger };
}

export function createForkWiring(adapters = {}, bindings = {}) {
	const registry = createForkRegistry(adapters);
	const wiring = {
		registry,
		// One explicit process container: the ledger index, the running sets, the
		// per-station attach records and the display holder all live here.
		process: createForkProcess({ registry }),
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
