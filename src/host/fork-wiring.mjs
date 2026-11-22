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
	ledgerFor,
	outcomeOf,
	pulse,
	setIdentity,
	setOutcome,
} from "./fork-registry.mjs";
import { record } from "./diagnostics.mjs";
import { createDisplayBinder } from "./child-display-holder.mjs";
import { buildChildIdentity, resolveForkLedger } from "./fork-identity.mjs";
import {
	spawnChildTicket,
	writeFrozenOutcome,
} from "../tools/fork-spawn-ticket.mjs";

// One base attach and one host bind per station. The base runs before the host
// composition root exists; the host bind adds display and spawner later. The
// WeakMaps are the idempotence guard, so a second call cannot re-run ledger
// selection or replace a live display holder.
const baseStates = new WeakMap();
const hostStates = new WeakMap();

/**
 * Bind the fork ports on a station. `SessionStation` owns the derivation; a
 * plain test double gets the same capabilities assigned directly. This is a
 * capability check, not a business branch: production never takes the second
 * path.
 */
function bindForkPorts(station, { registry, ledger, identity }) {
	const childOutcomePort = (forkId) => outcomeOf(registry, forkId);
	const setChildOutcome = (forkId, outcome) => setOutcome(registry, forkId, outcome);
	if (typeof station.bindForkPorts === "function") {
		station.bindForkPorts({
			registry,
			ledger,
			identity,
			childOutcomePort,
			setChildOutcome,
		});
		return;
	}
	if (station.state && ledger) station.state.brackets = ledger;
	station.forkLedgerPort = () => ledger;
	station.forkWaitPort = () => ({ registry, ledger });
	station.forkIdentityPort = () => identity;
	station.forkOwnerId = () =>
		typeof identity?.forkId === "string" && identity.forkId !== ""
			? identity.forkId
			: null;
	station.forkDepthPort = () =>
		Number.isInteger(identity?.childDepth)
			? identity.childDepth
			: station.forkOwnerId()
				? 1
				: 0;
	station.childOutcomePort = childOutcomePort;
	station.setChildOutcome = setChildOutcome;
	if (typeof identity?.persistRoot === "function") {
		station.persistLedger = identity.persistRoot;
	} else if (!identity) {
		station.persistLedger = () => station.persist?.();
	}
	station.forkPortsPhase = "base";
}

/**
 * Attach the station-owned fork ports: ledger, wait, identity, ownership and
 * outcome access. This phase never touches display or the spawner.
 *
 * options:
 * - conversationKey: the object or string that names this conversation's ledger
 * - identity: { forkId, parentOwnerId, ownScopeId } when the station is a child
 */
export function attachBaseForkPorts(station, wiring, options = {}) {
	if (!station || typeof station !== "object") {
		const registry = wiring?.registry ?? createForkRegistry();
		return { registry, ledger: null, identity: null };
	}
	const existing = baseStates.get(station);
	if (existing) return existing;

	const registry = wiring?.registry ?? createForkRegistry();
	const identity =
		options.identity && typeof options.identity === "object" ? options.identity : null;
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
	const ledger = resolveForkLedger({ identity, indexed, restored });
	if (!identity) adoptLedger(registry, conversationKey, ledger);
	// `SessionStation.bindForkPorts` derives owner/depth/persistence once; a
	// plain test double receives the same capabilities. Never write the legacy
	// duplicate owner field: `forkOwnerId()` is the single owner seam.
	bindForkPorts(station, { registry, ledger, identity });
	const state = { registry, ledger, identity };
	baseStates.set(station, state);
	return state;
}

function spawnPortFor(station, base, binder, options) {
	if (typeof options.createSession !== "function") return undefined;
	const createSession = options.createSession;
	return () => (spec) => {
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
			// A finished spawn is a ledger change too. The parent's branch
			// persists it, not the child's disappearing one.
			persistLedger: () => station.persist?.(),
			maxResultChars: options.maxResultChars,
			maxThinkingChars: options.maxThinkingChars,
			createSession: (input) =>
				createSession({
					...input,
					agentId,
					ownerSession: options.ownerSession ?? null,
					sessionManager: station.manager ?? null,
				}),
		};
		// The receipt is returned in this beat, so the ticket must not be
		// awaited here. The catch-all is the station's obligation.
		spawnChildTicket(spec, ports).catch((error) => {
			record("fork", error, { forkId: spec.forkId, phase: "ticket" });
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
	let base = baseStates.get(station);
	if (!base) base = attachBaseForkPorts(station, wiring, options);

	const existing = hostStates.get(station);
	if (existing) {
		if (Object.hasOwn(options, "display")) existing.binder.updateDisplay(options.display);
		if (typeof options.createSession === "function") {
			station.childSpawnPort = spawnPortFor(station, base, existing.binder, options);
		}
		return { registry: base.registry, ledger: base.ledger };
	}

	// A holder passed in is shared with the parent; a port is wrapped in a
	// fresh holder; null starts empty and accepts a late UI.
	const binder = createDisplayBinder({ display: options.display });
	station.displayPort = binder.currentDisplay;
	station.setDisplayPort = (port) => binder.setDisplayPort(port);
	station.noteRootWait = !base.identity
		? (delta) => binder.currentDisplay()?.rootWait?.(delta)
		: null;
	station.noteScopeRequest = base.ledger
		? () => binder.currentDisplay()?.request(base.ledger, station.forkOwnerId?.() ?? null)
		: null;
	const spawn = spawnPortFor(station, base, binder, options);
	if (spawn) station.childSpawnPort = spawn;
	station.forkPortsPhase = "host";
	hostStates.set(station, { binder });
	return { registry: base.registry, ledger: base.ledger };
}

/** A fresh wiring: one registry for the whole process. */
export function createForkWiring() {
	return { registry: createForkRegistry() };
}
