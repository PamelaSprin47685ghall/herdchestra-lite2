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
import {
	REQUEST_INTERRUPT_REASON,
	clearRuntime,
	currentRequest,
	hasPendingRequests,
	pendingRequestCount,
	rejectPendingRequests,
	registerRuntime,
} from "../scope/request-queue.mjs";
import {
	childReturnNudge,
	resetReturnNudges,
	takeReturnNudge,
} from "../scope/return-nudge.mjs";
import {
	formatRebornPrompt,
} from "../station/domain/handoff.mjs";
import { finishRewind } from "../station/handoff-state.mjs";
import { setRecordFields } from "../scope/record-mutation.mjs";

// A child that keeps ending a beat without answering the queued request would
// otherwise be re-prompted forever: the loop's only exit was "no request
// pending", and a stuck head never clears. Two wake prompts are the whole
// allowance; after that the caller is settled as unanswered and the loop falls
// through to the stop/nudge path, which closes the bracket.
const MAX_WAKE_ATTEMPTS = 2;

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
 * Wake one finished scope in place.
 *
 * A scope that finished its return is idle, not gone. A pending `scope_request`
 * wakes it: the projection turns into `AWAITING_REPLY`, the model answers
 * through `scope_reply`, and a natural stop returns the scope to idle without
 * touching the record the parent will join.
 */
export async function wakeIdleScope(entry, ledger, forkId) {
	if (!forkOf(ledger, forkId)) return { ok: true, woken: false };
	if (typeof entry?.drain !== "function") return { ok: true, woken: false };
	if (entry.busy === true) {
		entry.pending = true;
		return { ok: true, woken: true, deferred: true };
	}
	entry.busy = true;
	try {
		do {
			entry.pending = false;
			if (!(await entry.drain())) break;
		} while (entry.pending === true);
		return { ok: true, woken: false };
	} catch (error) {
		return { ok: false, reason: String(error?.message ?? error) };
	} finally {
		entry.busy = false;
	}
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
	// Declared in the function body, not the try block: `finish()` is declared
	// outside the try and closes over this scope, so a `let` inside the block
	// would be invisible to it and every early `return finish()` would throw.
	let unpublished = false;
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
		// Create-in-flight registration: a cancellation that lands while the
		// host is still assembling the session must already know how to stop it.
		// If the abort arrives before createSession settles, `abortedInFlight`
		// ensures the newly created session is aborted immediately on arrival.
		let liveSession = null;
		let abortedInFlight = false;
		ports.registerRunning?.(spec.forkId, () => {
			abortedInFlight = true;
			if (liveSession) ports.abortChild?.(liveSession);
		});
		unregisterRunning = () => ports.unregisterRunning?.(spec.forkId);
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
		liveSession = session;
		// The parent may have cancelled this fork while the host was creating
		// the session. The ledger holds the reason; starting a prompt after
		// that would resurrect work the user already ended.
		if (abortedInFlight || isCancelled(ledger, spec.forkId)) {
			ports.abortChild?.(session);
			return finish();
		}
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
		let childStation = null;
		let childCtx = null;
		const hasOrigin =
			Object.hasOwn(created, "originEntryId") && created.originEntryId !== undefined;
		const originEntryId = hasOrigin ? created.originEntryId : undefined;
		try {
			const prepared = ports.prepareChild?.(session) ?? null;
			if (prepared?.ok === false) {
				report?.("fork", new Error(`child context preparation refused: ${prepared.code}`), {
					forkId: spec.forkId,
					phase: "child-context",
				});
			} else if (prepared?.station) {
				childStation = prepared.station;
				childCtx = prepared.ctx ?? null;
				childStation.childRewindAvailable =
					hasOrigin &&
					typeof childStation.manager?.branch === "function" &&
					typeof childStation.manager?.resetLeaf === "function";
			}
		} catch (error) {
			report?.("fork", error, { forkId: spec.forkId, phase: "child-context" });
		}
		let before = messagesOf(session).length;
		// Every prompt from this point on is agent-authored: the receipt, added
		// requirements, and the return nudge. The host marks a message
		// `synthetic` when the agent wrote it; `role` stays "user" so the model
		// still reads it as instructions from its parent.
		const syntheticOptions = { synthetic: true, attribution: "agent", userInitiated: false };
		const send =
			typeof session.prompt === "function"
				? (text, options) => session.prompt(text, { ...syntheticOptions, ...options })
				: typeof session.agent?.prompt === "function"
					? (text, options) => session.agent.prompt(text, { ...syntheticOptions, ...options })
					: null;
		// A stopped scope resumes from its branch, so the leaf of the last
		// completed turn must survive in the record. Every turn goes through
		// `prompt`, so recording here covers the receipt, a rewind, a request
		// reply, and a return nudge without a second call site.
		const noteTail = () => {
			const tail =
				session?.manager?.getLeafId?.() ?? session?.getLeafId?.() ?? null;
			if (typeof tail !== "string" || tail === "") return;
			setRecordFields(forkOf(ledger, spec.forkId), { branchTail: tail });
		};
		const prompt =
			typeof send === "function"
				? async (text, options) => {
						const result = await send(text, options);
						noteTail();
						return result;
					}
				: null;
		if (typeof prompt !== "function") {
			failed = true;
			reason = "the forked scope's session exposes no prompt()";
			writeOutcome({ record: "", failed: true, reason });
			return finish();
		}
		if (typeof session.agent?.abort === "function" && typeof ports.stopAfterReturn === "function") {
			detachTermination = ports.stopAfterReturn(session.agent) ?? null;
		}
		// The request table: this child answers a peer's synchronous
		// `scope_request` in one turn. While it is running an interrupt can cut
		// the current beat short; the loop below turns that abort into the reply
		// turn instead of a failure.
		const childRuntimePath = runtimePathOf();
		if (childRuntimePath !== null) {
			registerRuntime(registry, childRuntimePath, {
				state: "running",
				interrupt: () => session.agent?.abort?.(REQUEST_INTERRUPT_REASON),
			});
		}
		// A pending `scope_request` is the only asynchronous input a running
		// child reads. The projection turns it into `AWAITING_REPLY`, so the
		// prompt only has to wake the loop; the model then answers through
		// `scope_reply` and the request is resolved by the station.
		const REQUEST_WAKE =
			"A peer scope is waiting on your answer. Only `scope_reply` is bound this turn; answer in one string.";
		const hasPendingRequest = () =>
			childRuntimePath !== null && hasPendingRequests(registry, childRuntimePath);
		let wakeHead = null;
		let wakeAttempts = 0;
		const deliverRequest = async () => {
			if (!hasPendingRequest()) {
				wakeHead = null;
				wakeAttempts = 0;
				return false;
			}
			const head = currentRequest(registry, childRuntimePath);
			const headId = head?.id ?? null;
			if (headId !== wakeHead) {
				wakeHead = headId;
				wakeAttempts = 0;
			}
			if (wakeAttempts >= MAX_WAKE_ATTEMPTS) {
				// Asked twice and still unanswered: settle the caller so no promise
				// parks, then let the loop reach its stop/nudge path.
				rejectPendingRequests(
					registry,
					childRuntimePath,
					"the scope did not answer",
				);
				wakeHead = null;
				wakeAttempts = 0;
				return false;
			}
			wakeAttempts += 1;
			await prompt(REQUEST_WAKE);
			return true;
		};
		// Rewind the child's own BranchManager back to `originEntryId` once the
		// previous loop has exited cleanly via `stopLoop: true`, then prompt the
		// reborn child with its birth receipt and formatted generation report.
		const applyChildRewind = async (bracket) => {
			const pending = childStation?.pendingChildRewind ?? null;
			if (!pending) return false;
			childStation.pendingChildRewind = null;
			const manager = childStation.manager ?? null;
			if (!hasOrigin || !manager) {
				throw new Error("child rewind requested without a rewindable branch manager");
			}
			await session.settleInFlightMessagePersistence?.();
			if (originEntryId === null) manager.resetLeaf();
			else manager.branch(originEntryId);
			const rebuilt =
				typeof manager.buildSessionContext === "function"
					? manager.buildSessionContext()?.messages
					: null;
			if (Array.isArray(rebuilt)) {
				const setOnHost = childStation.host?.session?.setMessages;
				const applied =
					typeof setOnHost === "function"
						? setOnHost(childCtx ?? session, rebuilt)
						: false;
				if (!applied && session?.agent?.state && Array.isArray(session.agent.state.messages)) {
					session.agent.state.messages = rebuilt.slice();
				} else if (!applied && Array.isArray(session?.messages)) {
					session.messages.splice(0, session.messages.length, ...rebuilt);
				}
			}
			finishRewind(childStation, { rebaseAnchor: true });
			resetReturnNudges(bracket);
			before = messagesOf(session).length;
			const reborn = formatRebornPrompt({
				birth: spec.receipt,
				report: pending.report,
				big: false,
			});
			await prompt(reborn);
			return true;
		};
		await prompt(spec.receipt);
		// A natural stop submits nothing. Only scope_return with the oath closes
		// the bracket; a small scope_return rewinds to originEntryId and keeps
		// running in the same session, forkId, path, ownerId, inbox, and budget.
		let bracket = forkOf(ledger, spec.forkId);
		while (bracket && bracket.status === "running") {
			if (await applyChildRewind(bracket)) {
				bracket = forkOf(ledger, spec.forkId);
				continue;
			}
			if (await deliverRequest()) {
				// A wake prompt alone proves nothing was answered: refresh the nudge
				// allowance only when the queue actually emptied, or a request the
				// child ignores would keep the allowance alive and the bracket would
				// never close.
				if (
					childRuntimePath !== null &&
					pendingRequestCount(registry, childRuntimePath) === 0
				) {
					resetReturnNudges(bracket);
				}
				bracket = forkOf(ledger, spec.forkId);
				continue;
			}
			const stop = stopReasonOf(session);
			if (stop !== null && stop !== "stop" && stop !== "end") {
				// A request interrupt stops the current beat, not the scope. While
				// a request is still pending the abort is that interrupt, so clear
				// the stale stop reason and drive the reply turn instead of
				// failing the child.
				if (stop === "aborted" && hasPendingRequest()) {
					const agentState = session?.agent?.state;
					if (agentState) agentState.stopReason = "stop";
					continue;
				}
				failed = true;
				reason = `the worker in the forked scope stopped with reason "${stop}"`;
				break;
			}
			// The bound lives on the record. The station's steer spends the same
			// allowance, so this loop can never promise more nudges than remain.
			if (!takeReturnNudge(bracket)) {
				failed = true;
				reason = "the worker in the forked scope stopped without calling scope_return; its record stays unpublished";
				unpublished = true;
				break;
			}
			await prompt(childReturnNudge());
			bracket = forkOf(ledger, spec.forkId);
		}
		// A pending child rewind is still running; if inbox messages arrived
		// concurrently while the old generation ran, rewind first so the reborn
		// child reads them on its clean branch instead of losing them to rewind.
		// After the child returns (no longer RUNNING), drain any inbox message
		// that arrived before it finished, matching prior spawn behavior.
		if (bracket && bracket.status !== "running") {
			await deliverRequest();
		}
		const added = messagesOf(session).slice(before);
		// The scope is finished, not gone. Hand the prompt handle to the wiring
		// so a message that names this path wakes the same session in place: the
		// inbox is drained, the model answers, and a natural stop returns it to
		// idle. The parent's ready or joined record is never touched, and no
		// second return is invented.
		if (!failed && !unpublished) {
			ports.registerIdle?.(spec.forkId, {
				prompt,
				drain: deliverRequest,
				abort: () => ports.abortChild?.(session),
			});
		}
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

	/**
	 * The child's address in the request table. A function declaration, not a
	 * `const`: `finish()` is called from inside the try block, before any later
	 * statement has been evaluated, so only a hoisted declaration is in scope.
	 */
	function runtimePathOf() {
		const path = forkOf(ledger, spec.forkId)?.path;
		return typeof path === "string" && path !== "" ? path : null;
	}

	function finish() {
		// Remove only this child's widget row; root events never pass through it.
		detach();
		// Wake the waiting parent in every case: a failed child is still a
		// returned child, and a join that never wakes is a deadlock.
		// After the child returns (no longer RUNNING) or fails, no further turn
		// can answer for it. A scope that keeps an idle handle stays addressable
		// and keeps its entry; anything else stops answering for good.
		if (failed || unpublished) {
			const runtimePath = runtimePathOf();
			if (runtimePath !== null) {
				clearRuntime(registry, runtimePath);
				// A child that failed or never published can never answer. A
				// queued scope_request must not park its caller forever, so the
				// queue settles here; a scope that returns successfully keeps its
				// idle wake and its queue.
				rejectPendingRequests(registry, runtimePath, reason ?? undefined);
			}
		}
		pulse(registry, ledger, spec.forkId, outcomeOf(registry, spec.forkId));
		ports.persistLedger?.();
		return { ok: true, failed, reason };
	}
}
