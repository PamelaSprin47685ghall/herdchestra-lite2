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
	bindAgent,
	createForkRegistry,
	identityOf,
	ledgerFor,
	outcomeOf,
	pulse,
	setIdentity,
	setOutcome,
} from "./fork-registry.mjs";
import { renderChildRecord } from "../transcript/replay.mjs";
import { record } from "./diagnostics.mjs";
import { publicScopeId, scopeTitle } from "../scope/scope-id.mjs";
import { forkOf } from "../scope/forkjoin.mjs";
import { childReturnNudge } from "../scope/return-nudge.mjs";
import { stopAfterScopeReturn } from "./branch-context.mjs";

// A child that stops without scope_return submits nothing. The ticket asks it
// to return; after this many refusals the child is recorded as failed, so a
// runaway stop loop cannot burn the branch forever.
const MAX_RETURN_NUDGES = 2;

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

function messagesOf(session) {
	// The live host keeps the turn list on the agent state. A test double or a
	// host variant may expose it on the session or the agent instead; reading
	// only one shape turned a running child into a silent empty record.
	const state = session?.agent?.state;
	if (Array.isArray(state?.messages)) return state.messages;
	if (Array.isArray(session?.messages)) return session.messages;
	const agent = session?.agent;
	if (Array.isArray(agent?.messages)) return agent.messages;
	return [];
}

function stopReasonOf(session) {
	const state = session?.agent?.state;
	const value = state?.stopReason ?? state?.lastStopReason ?? null;
	return typeof value === "string" ? value : null;
}

/**
 * Record one outcome unless the branch already froze a record of its own.
 *
 * Both the ticket's own write and the outer catch-all go through this rule: a
 * child that decided its record must never be replaced by an empty failure
 * written after it, for example when the spawn's tail throws.
 */
function writeFrozenOutcome(registry, forkId, outcome) {
	const existing = outcomeOf(registry, forkId);
	if (existing && typeof existing.record === "string" && existing.record !== "") return;
	setOutcome(registry, forkId, outcome);
}

/**
 * One child branch, from assembly to a finished record.
 *
 * `createSession(spec)` must resolve to `{ ok: true, session }` or to a
 * refusal. The session only needs `prompt(text)` and either
 * `agent.state.messages` or `messages`. Everything else is optional, which is
 * what keeps this testable without a host.
 */
export async function spawnChildTicket(spec, ports) {
	const { registry, ledger, createSession } = ports;
	let session = null;
	let failed = false;
	let reason = null;
	let created = null;
	let detachDisplay = null;
	let detachTermination = null;
	let detached = false;
	const detach = () => {
		if (detached) return;
		detached = true;
		try {
			detachDisplay?.();
		} catch {
			// A display detach must not change the child's outcome.
		}
	};
	// The child's own scope_return freezes the record before the parent can
	// take the bracket. That record wins: the spawner's later copy describes
	// the same work and must never replace it.
	const writeOutcome = (outcome) => writeFrozenOutcome(registry, spec.forkId, outcome);
	try {
		created = await createSession(spec);
		if (!created || created.ok !== true || !created.session) {
			failed = true;
			const base =
				typeof created?.reason === "string" && created.reason !== ""
					? created.reason
					: "the child session could not be created";
			// A factory refusal carries the original error and the refusal's
			// explanation. Keep the code in the reason the parent sees, append
			// whichever evidence exists, and put the cause in the diagnostics
			// ring. A bare "CREATE_FAILED" or "NO_TOOL_VIEW" must not hide why
			// the child never started.
			const cause = created?.error;
			const detail = typeof created?.detail === "string" && created.detail !== "" ? created.detail : null;
			// A refusal with neither a cause nor a detail stays a bare code.
			reason = cause
				? `${base}: ${String(cause?.message ?? cause)}`
				: detail
					? `${base}: ${detail}`
					: base;
			if (cause) record("fork", cause, { forkId: spec.forkId, phase: "create" });
			writeOutcome({ record: "", failed: true, reason });
			return finish();
		}
		session = created.session;
		// The host UI subscribes to the root session only. Attach the child's
		// presentation stream before its first prompt so text and tool progress
		// are visible while the child works, not only when the parent joins.
		// Display is optional: a bridge that cannot attach must not turn a
		// healthy child into a failed one.
		try {
			detachDisplay = ports.display?.attach?.(scopeTitle(publicScopeId(forkOf(ledger, spec.forkId))), session) ?? null;
		} catch (error) {
			record("fork", error, { forkId: spec.forkId, phase: "display" });
		}
		// The host gives the child an agent id only once the session exists.
		// Bind it now so the child's own station can resolve its fork and call
		// scope_return; without this the child is nobody's child.
		const childAgentId =
			session?.agent?.id ?? session?.agentId ?? created.agentId ?? null;
		if (typeof childAgentId === "string" && childAgentId !== "") {
			bindAgent(registry, spec.forkId, childAgentId);
		}
		// The child's requests need the same preparation as the root's. The
		// old scheduler called prepareFlow() for every flow; without it the
		// host's skill receipt can fail the prefix check before the child
		// produces a turn. A refusal is recorded, not fatal.
		try {
			const prepared = ports.prepareChild?.(session) ?? null;
			if (prepared?.ok === false) {
				record("fork", new Error(`child context preparation refused: ${prepared.code}`), {
					forkId: spec.forkId,
					phase: "child-context",
				});
			}
		} catch (error) {
			record("fork", error, { forkId: spec.forkId, phase: "child-context" });
		}
		const before = messagesOf(session).length;
		const prompt =
			typeof session.prompt === "function"
				? (text) => session.prompt(text)
				: typeof session.agent?.prompt === "function"
					? (text) => session.agent.prompt(text)
					: null;
		if (typeof prompt !== "function") {
			failed = true;
			reason = "the child session exposes no prompt()";
			writeOutcome({ record: "", failed: true, reason });
			return finish();
		}
		if (typeof session.agent?.abort === "function") detachTermination = stopAfterScopeReturn(session.agent);
		await prompt(spec.receipt);
		// A natural stop submits nothing. Only scope_return closes the bracket,
		// so a RUNNING bracket after the prompt proves the child stopped short.
		// The ticket says so and hands the loop back, once per stop.
		let bracket = forkOf(ledger, spec.forkId);
		let nudges = 0;
		let unpublished = false;
		while (bracket && bracket.status === "running") {
			const stop = stopReasonOf(session);
			if (stop !== null && stop !== "stop" && stop !== "end") {
				failed = true;
				reason = `the child stopped with reason "${stop}"`;
				break;
			}
			if (nudges >= MAX_RETURN_NUDGES) {
				failed = true;
				reason = "the child stopped without calling scope_return; its record stays unpublished";
				unpublished = true;
				break;
			}
			nudges += 1;
			await prompt(childReturnNudge());
			bracket = forkOf(ledger, spec.forkId);
		}
		const added = messagesOf(session).slice(before);
		const text = unpublished
			? ""
			: renderChildRecord(added, {
					maxResultChars: ports.maxResultChars,
					maxThinkingChars: ports.maxThinkingChars,
				});
		// An empty record is not a silent success. The parent cannot tell a
		// child that did nothing from one whose provider rejected the turn, so
		// the spawner names the failure instead of handing over a blank page.
		// A record frozen by scope_return is proof the child handed over work;
		// the spawner's empty slice must not turn that return into a failure.
		const frozen = outcomeOf(registry, spec.forkId);
		if (text.trim() === "" && !failed && !unpublished && !frozen?.record) {
			failed = true;
			reason = "the child produced no messages; the host accepted the prompt but recorded no child turn";
		}
		writeOutcome({ record: text, failed, reason });
		return finish();
	} catch (error) {
		failed = true;
		reason = String(error?.message ?? error);
		writeOutcome({ record: "", failed: true, reason });
		// A child that throws must not vanish: the reason is the only evidence
		// the parent will ever see.
		record("fork", error, { forkId: spec.forkId });
		return finish();
	} finally {
		detachTermination?.();
		if (created?.limitations?.length > 0) {
			record("fork", new Error("limits"), {
				forkId: spec.forkId,
				limits: created.limitations.length,
			});
		}
	}

	function finish() {
		// Remove only this child's widget row; root events never pass through it.
		detach();
		// Wake the waiting parent in every case: a failed child is still a
		// returned child, and a join that never wakes is a deadlock.
		pulse(registry, ledger, spec.forkId, outcomeOf(registry, spec.forkId));
		ports.persistLedger?.();
		return { ok: true, failed, reason };
	}
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
