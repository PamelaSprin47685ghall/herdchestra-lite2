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
import {
	spawnChildTicket,
	writeFrozenOutcome,
} from "../tools/fork-spawn-ticket.mjs";

function isDisplayHolder(value) {
	return value !== null && typeof value === "object" && "current" in value;
}

function resolveDisplay(value) {
	if (typeof value === "function") return value();
	if (isDisplayHolder(value)) return value.current;
	return value;
}

// A display holder is shared across nested stations. `current` lets a late
// reader resolve the port; `subscribe`/`notify` let the root wake every child
// station that queued a session before the UI existed.
function createDisplayHolder(initial = null) {
	const listeners = new Set();
	return {
		current: initial ?? null,
		subscribe(listener) {
			if (typeof listener !== "function") return () => {};
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		notify() {
			for (const listener of [...listeners]) {
				try {
					listener();
				} catch (error) {
					record("fork", error, { phase: "display" });
				}
			}
		},
	};
}

/**
 * Attach the four ports to one station.
 *
 * options:
 * - conversationKey: the object or string that names this conversation's ledger
 * - identity: { forkId, parentOwnerId, ownScopeId } when the station is a child
 * - createSession: (spec) => Promise<{ ok, session, limitations }>
 * - ownerSession: the session a child is derived from, passed through to
 *   createSession as `spec.ownerSession`
 * - maxResultChars / maxThinkingChars: replay truncation, optional
 */
export function attachForkPorts(station, wiring, options = {}) {
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
	const ledger =
		identity?.ledger && typeof identity.ledger === "object"
			? identity.ledger
			: indexed && (indexed.order?.length ?? 0) > 0
				? indexed
				: restored ?? indexed;
	if (station.state && ledger) station.state.brackets = ledger;
	if (!identity) adoptLedger(registry, conversationKey, ledger);
	station.forkLedgerPort = () => ledger;
	// The ticket layer is the only place allowed to await. It needs the
	// registry that owns the waiters and the ledger both sides share.
	station.forkWaitPort = () => ({ registry, ledger });
	station.forkIdentityPort = () => identity;
	// The branch's own id, or null at the root. Every budget charge and every
	// relay decision asks this one question: a child spends its fork record
	// and never touches the relay; the root has no record, so ordinary tools
	// are refused there and only it evaluates the ledger. `ownerId` stays the
	// property the fork controls already read.
	station.forkOwnerId = () =>
		identity && typeof identity.forkId === "string" && identity.forkId !== ""
			? identity.forkId
			: null;
	station.ownerId = station.forkOwnerId();
	// Display is a live holder, not a snapshot: the interactive UI may appear
	// after this station is attached (or the session may be remembered late).
	// The composition root refreshes the holder on every later station access,
	// and the spawner reads it at spawn time.
	// A display holder is live: the interactive UI may arrive after this
	// station (or a child station) is attached. Keep the holder when one is
	// given, and never write a child's shared holder from this station.
	const displayHolder = isDisplayHolder(options.display) ? options.display : null;
	// A child receives the parent's live holder; the root owns a fresh one.
	// Sharing the object is what lets a root setDisplayPort reach every nested
	// station that is still waiting for a port.
	const displayRef = displayHolder ?? createDisplayHolder(resolveDisplay(options.display));
	const currentDisplay = () => resolveDisplay(displayRef);
	// A child session that starts before the UI exists has no display to
	// attach to. Hold it until a port arrives, then attach it; the spawner's
	// detach still removes only that child.
	const pendingDisplay = new Map();
	// Only sessions still waiting for a port need a wake-up. Once every
	// waiting session is attached, the station drops its listener so a
	// long-lived root holder does not accumulate one per child station.
	const waitingDisplay = new Set();
	let unsubscribeDisplay = null;

	function subscribeDisplay() {
		if (unsubscribeDisplay || typeof displayRef.subscribe !== "function") return;
		unsubscribeDisplay = displayRef.subscribe(() => flushPendingDisplay());
	}

	function releaseDisplaySubscriptionIfIdle() {
		if (waitingDisplay.size > 0) return;
		unsubscribeDisplay?.();
		unsubscribeDisplay = null;
	}

	function attachPendingDisplay(entry, port) {
		if (!entry.active || entry.attached) return;
		try {
			entry.detach = port.attach?.(entry.label, entry.session) ?? null;
			entry.attached = true;
		} catch (error) {
			record("fork", error, { phase: "display" });
		}
	}

	function flushPendingDisplay() {
		const port = currentDisplay();
		if (!port) return;
		for (const [session, entry] of pendingDisplay) {
			if (!entry.active) {
				pendingDisplay.delete(session);
				waitingDisplay.delete(session);
				continue;
			}
			if (entry.attached) {
				waitingDisplay.delete(session);
				continue;
			}
			attachPendingDisplay(entry, port);
			if (entry.attached) waitingDisplay.delete(session);
		}
		releaseDisplaySubscriptionIfIdle();
	}

	function attachDisplay(label, session) {
		const entry = { label, session, detach: null, attached: false, active: true };
		pendingDisplay.set(session, entry);
		const port = currentDisplay();
		if (port) attachPendingDisplay(entry, port);
		if (!entry.attached) {
			waitingDisplay.add(session);
			subscribeDisplay();
		}
		return () => {
			entry.active = false;
			entry.detach?.();
			entry.detach = null;
			entry.attached = false;
			pendingDisplay.delete(session);
			waitingDisplay.delete(session);
			releaseDisplaySubscriptionIfIdle();
		};
	}

	station.displayPort = currentDisplay;
	station.setDisplayPort = (port) => {
		// A child shares the parent's holder. It may flush its own waiting
		// sessions, but only the root owns the value.
		if (displayHolder) {
			flushPendingDisplay();
			return;
		}
		displayRef.current = port ?? null;
		flushPendingDisplay();
		displayRef.notify?.();
	};
	station.noteRootWait = !identity
		? (delta) => currentDisplay()?.rootWait?.(delta)
		: null;
	station.noteScopeRequest = ledger
		? () => currentDisplay()?.request(ledger, station.ownerId)
		: null;
	station.forkDepthPort = () =>
		identity && Number.isInteger(identity.childDepth)
			? identity.childDepth
			: (station.forkOwnerId() ? 1 : 0);
	station.childOutcomePort = (forkId) => outcomeOf(registry, forkId);
	// A child freezes its own record at scope_return, before the parent can
	// take the bracket. The station writes through this port; the spawner's
	// later copy never replaces a frozen record.
	station.setChildOutcome = (forkId, outcome) => setOutcome(registry, forkId, outcome);
	// The root's state owns the tree. A child writes a return into that same
	// tree, so the parent's branch must persist it: the child's own branch is
	// not what a reload restores.
	if (typeof identity?.persistRoot === "function") {
		station.persistLedger = identity.persistRoot;
	} else if (!identity) {
		station.persistLedger = () => station.persist?.();
	}
	if (typeof options.createSession === "function") {
		const createSession = options.createSession;
		station.childSpawnPort = () => (spec) => {
			// The child's station does not exist yet. Record who it is before
			// the spawn so that station can find its own fork the moment the
			// host builds it.
			const agentId = `fork-${randomUUID()}`;
			// The holder must outlive this spawn: a child created before the
			// UI exists reads the same live slot when the display arrives.
			const identityDisplayHolder = displayRef;
			setIdentity(registry, spec.forkId, {
				parentOwnerId: spec.parentOwnerId ?? null,
				ownScopeId: spec.ownScopeId ?? null,
				// Provider IDs are opaque (including slashes and long suffixes).
				// Prebind the generated host ID without changing the fork identity.
				agentId,
				display: resolveDisplay(identityDisplayHolder),
				displayHolder: identityDisplayHolder,
				ledger,
				// The root branch is the one a reload restores. Give the child
				// the ability to persist that branch when it returns, so a ready
				// record survives a crash before the parent joins.
				persistRoot: () => station.persist?.(),
				intent: spec.intent ?? null,
				budget: spec.budget ?? null,
				time: spec.time ?? null,
				permission: spec.permission ?? null,
				childDepth: spec.childDepth ?? null,
			});
			const ports = {
				registry,
				ledger,
				// Queue the attach until a display exists. A child that starts
				// before the UI is still attached when the port arrives.
				display: { attach: attachDisplay },
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
				writeFrozenOutcome(registry, spec.forkId, {
					record: "",
					failed: true,
					reason: String(error?.message ?? error),
				});
				pulse(registry, ledger, spec.forkId, outcomeOf(registry, spec.forkId));
			});
			return true;
		};
	}
	return { registry, ledger };
}

/** A fresh wiring: one registry for the whole process. */
export function createForkWiring() {
	return { registry: createForkRegistry() };
}
