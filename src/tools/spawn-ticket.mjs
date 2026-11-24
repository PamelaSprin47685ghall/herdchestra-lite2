// The child spawn ticket.
//
// `scope_fork` must return a receipt in the same beat that it starts the
// child; the real work is this ticket. The wiring starts it and never awaits
// it, with a catch-all so a failure is recorded instead of escaping as an
// unhandled rejection.
//
// Everything host-specific is injected through `ports`; this module imports
// only domain helpers and the registry's identity/outcome functions.

import {
	bindAgent,
	outcomeOf,
	pulse,
	setOutcome,
} from "../scope/fork-registry.mjs";
import { renderChildRecord } from "../transcript/replay.mjs";
import { publicScopeId, scopeTitle } from "../scope/scope-id.mjs";
import { forkOf } from "../scope/forkjoin.mjs";
import { childReturnNudge } from "../scope/return-nudge.mjs";

// A child that stops without scope_return submits nothing. The ticket asks it
// to return; after this many refusals the child is recorded as failed, so a
// runaway stop loop cannot burn the branch forever.
const MAX_RETURN_NUDGES = 2;

/**
 * A fork the parent cancelled owns the reason the parent reads.
 *
 * The ledger is the source of truth: a cascade closes the record first, then
 * stops the agent. Anything this ticket writes afterwards describes work the
 * user already ended, so it is dropped. An unpublished fork (no ledger entry,
 * as a direct unit test builds) has nothing to contradict and is reported.
 */
function isCancelled(ledger, forkId) {
	const record = forkOf(ledger, forkId);
	if (!record) return false;
	return record.status !== "running" && record.status !== "ready";
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
export function writeFrozenOutcome(registry, forkId, outcome) {
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
	const report = ports.report ?? null;
	let session = null;
	let failed = false;
	let reason = null;
	let created = null;
	let detachDisplay = null;
	let detachTermination = null;
	let detached = false;
	let unregisterRunning = null;
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
	const writeOutcome = (outcome) => {
		if (isCancelled(ledger, spec.forkId)) return;
		writeFrozenOutcome(registry, spec.forkId, outcome);
	};
	try {
		created = await createSession(spec);
		if (!created || created.ok !== true || !created.session) {
			failed = true;
			const base =
				typeof created?.reason === "string" && created.reason !== ""
					? created.reason
					: "the forked scope's session could not be created";
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
			if (cause) report?.("fork", cause, { forkId: spec.forkId, phase: "create" });
			writeOutcome({ record: "", failed: true, reason });
			return finish();
		}
		session = created.session;
		// Register the host handle before the first prompt. A cancellation that
		// lands while this ticket is still assembling must be able to stop the
		// agent, and must win over the prompt below.
		ports.registerRunning?.(spec.forkId, () => ports.abortChild?.(session));
		unregisterRunning = () => ports.unregisterRunning?.(spec.forkId);
		// The parent may have cancelled this fork while the host was creating
		// the session. The ledger holds the reason; starting a prompt after
		// that would resurrect work the user already ended.
		if (isCancelled(ledger, spec.forkId)) return finish();
		// The host UI subscribes to the root session only. Attach the child's
		// presentation stream before its first prompt so text and tool progress
		// are visible while the child works, not only when the parent joins.
		// Display is optional: a bridge that cannot attach must not turn a
		// healthy child into a failed one.
		try {
			detachDisplay = ports.display?.attach?.(scopeTitle(publicScopeId(forkOf(ledger, spec.forkId))), session) ?? null;
		} catch (error) {
			report?.("fork", error, { forkId: spec.forkId, phase: "display" });
		}
		// The host gives the child an agent id only once the session exists.
		// Bind it now so the child's own station can resolve its fork and call
		// scope_return; without this the child is nobody's child.
		const childAgentId =
			(typeof session?.getAgentId === "function" ? session.getAgentId() : null) ??
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
				report?.("fork", new Error(`child context preparation refused: ${prepared.code}`), {
					forkId: spec.forkId,
					phase: "child-context",
				});
			}
		} catch (error) {
			report?.("fork", error, { forkId: spec.forkId, phase: "child-context" });
		}
		const before = messagesOf(session).length;
		// Every prompt from this point on is agent-authored: the receipt, added
		// requirements, and the return nudge. The host marks a message
		// `synthetic` when the agent wrote it; `role` stays "user" so the model
		// still reads it as instructions from its parent.
		const syntheticOptions = { synthetic: true, attribution: "agent", userInitiated: false };
		const prompt =
			typeof session.prompt === "function"
				? (text, options) => session.prompt(text, { ...syntheticOptions, ...options })
				: typeof session.agent?.prompt === "function"
					? (text, options) => session.agent.prompt(text, { ...syntheticOptions, ...options })
					: null;
		if (typeof prompt !== "function") {
			failed = true;
			reason = "the forked scope's session exposes no prompt()";
			writeOutcome({ record: "", failed: true, reason });
			return finish();
		}
		if (typeof session.agent?.abort === "function") detachTermination = ports.stopAfterReturn?.(session.agent) ?? null;
		// Requirements arrive in the ledger while the child works. The child
		// has no inbox or session handle; it checks the ledger at each turn
		// boundary, so a requirement never interrupts a running tool call.
		const deliverRequirements = async () => {
			const record = forkOf(ledger, spec.forkId);
			if (!record || !Array.isArray(record.requirements)) return false;
			const delivered = Number.isInteger(record.requirementsDelivered)
				? record.requirementsDelivered
				: 0;
			const pending = record.requirements.slice(delivered);
			if (pending.length === 0) return false;
			record.requirementsDelivered = record.requirements.length;
			await prompt(
				["Additional requirements from the scope that forked this one:", ...pending.map((text) => `- ${text}`)].join("\n"),
			);
			return true;
		};
		await prompt(spec.receipt);
		await deliverRequirements();
		// A natural stop submits nothing. Only scope_return closes the bracket,
		// so a RUNNING bracket after the prompt proves the child stopped short.
		// The ticket says so and hands the loop back, once per stop. A record a
		// cascade already closed ends the loop without a nudge.
		let bracket = forkOf(ledger, spec.forkId);
		let nudges = 0;
		let unpublished = false;
		while (bracket && bracket.status === "running") {
			if (await deliverRequirements()) {
				nudges = 0;
				bracket = forkOf(ledger, spec.forkId);
				continue;
			}
			const stop = stopReasonOf(session);
			if (stop !== null && stop !== "stop" && stop !== "end") {
				failed = true;
				reason = `the worker in the forked scope stopped with reason "${stop}"`;
				break;
			}
			if (nudges >= MAX_RETURN_NUDGES) {
				failed = true;
				reason = "the worker in the forked scope stopped without calling scope_return; its record stays unpublished";
				unpublished = true;
				break;
			}
			nudges += 1;
			await prompt(childReturnNudge());
			bracket = forkOf(ledger, spec.forkId);
		}
		const added = messagesOf(session).slice(before);
		const text = unpublished ? "" : renderChildRecord(added, { start: 0 });
		// An empty record is not a silent success. The parent cannot tell a
		// child that did nothing from one whose provider rejected the turn, so
		// the spawner names the failure instead of handing over a blank page.
		// A record frozen by scope_return is proof the child handed over work;
		// the spawner's empty slice must not turn that return into a failure.
		const frozen = outcomeOf(registry, spec.forkId);
		if (text.trim() === "" && !failed && !unpublished && !frozen?.record) {
			failed = true;
			reason = "the worker in the forked scope produced no messages; the host accepted the prompt but recorded no turn";
		}
		writeOutcome({ record: text, failed, reason });
		return finish();
	} catch (error) {
		failed = true;
		reason = String(error?.message ?? error);
		writeOutcome({ record: "", failed: true, reason });
		// A child that throws must not vanish: the reason is the only evidence
		// the parent will ever see.
		report?.("fork", error, { forkId: spec.forkId });
		return finish();
	} finally {
		unregisterRunning?.();
		detachTermination?.();
		if (created?.limitations?.length > 0) {
			report?.("fork", new Error("limits"), {
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
