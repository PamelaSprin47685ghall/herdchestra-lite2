// The subscope spawn ticket.
//
// `scope_fork` must return a receipt in the same beat that it starts the
// subscope; the real work is this ticket. The wiring starts it and never awaits
// it, with a catch-all so a failure is recorded instead of escaping as an
// unhandled rejection.

import {
	bindAgent,
	outcomeOf,
	pulse,
	registerLiveInterrupt,
	setOutcome,
	unregisterLiveInterrupt,
} from "../scope/fork-registry.mjs";
import { renderChildRecord } from "../transcript/replay.mjs";
import { publicScopeId } from "../scope/scope-id.mjs";
import { forkOf } from "../scope/ledger-charge.mjs";
import {
	liveReceiverOf,
	reparentOrphans,
	updateRecordSnapshot,
} from "../scope/ledger-brackets.mjs";
import {
	abandonedReturnNudge,
	childReturnNudge,
	resetReturnNudges,
	takeReturnNudge,
} from "../scope/return-nudge.mjs";
import { formatRebornPrompt } from "../station/domain/handoff.mjs";
import { closedLeafId } from "../station/domain/snapshot-leaf.mjs";
import { setRecordFields } from "../scope/record-mutation.mjs";

function isCancelled(ledger, forkId) {
	const record = forkOf(ledger, forkId);
	if (!record) return false;
	return record.status !== "running" && record.status !== "ready";
}

function messagesOf(session) {
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

export function writeFrozenOutcome(registry, forkId, outcome) {
	const existing = outcomeOf(registry, forkId);
	if (existing && typeof existing.record === "string" && existing.record !== "") return;
	setOutcome(registry, forkId, outcome);
}

/**
 * One frozen record shape.
 *
 * Every terminal path of a branch writes the same six facts; spelling them out
 * at each site let one of them drift from the others. `abandoned` defaults to
 * the bracket's own flag, because that is the fact being reported; a path that
 * knows the answer better (for example, the branch that never started because
 * the request arrived first) passes it.
 */
function frozenRecord(record, failed, reason, bracket = null, abandoned = undefined) {
	return {
		record,
		failed,
		abandoned: abandoned ?? bracket?.abandonRequested === true,
		abandonedBy: bracket?.abandonedBy ?? null,
		abandonReason: bracket?.abandonReason ?? null,
		reason,
	};
}

/**
 * One subscope branch, from assembly to a finished record.
 */
export async function spawnChildTicket(spec, ports) {
	const { registry, ledger, createSession } = ports;
	const report = ports.report ?? null;
	let session = null;
	let failed = false;
	let reason = null;
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
			// A display detach must not change the subscope's outcome.
		}
	};
	const writeOutcome = (outcome) => {
		if (isCancelled(ledger, spec.forkId)) return;
		writeFrozenOutcome(registry, spec.forkId, outcome);
	};

	try {
		let liveSession = null;
		let abortedInFlight = false;
		ports.registerRunning?.(spec.forkId, () => {
			abortedInFlight = true;
			if (liveSession) ports.abortChild?.(liveSession);
		});
		registerLiveInterrupt(registry, spec.forkId, () => {
			if (liveSession) ports.interruptChild?.(liveSession);
		});
		unregisterRunning = () => ports.unregisterRunning?.(spec.forkId);
		created = await createSession(spec);
		if (!created || created.ok !== true || !created.session) {
			failed = true;
			const base =
				typeof created?.reason === "string" && created.reason !== ""
					? created.reason
					: "the forked scope's session could not be created";
			const cause = created?.error;
			const detail =
				typeof created?.detail === "string" && created.detail !== "" ? created.detail : null;
			reason = cause
				? `${base}: ${String(cause?.message ?? cause)}`
				: detail
					? `${base}: ${detail}`
					: base;
			if (cause) report?.("fork", cause, { forkId: spec.forkId, phase: "create" });
			const rec = forkOf(ledger, spec.forkId);
			writeOutcome(frozenRecord("", true, reason, rec));
			return finish();
		}
		session = created.session;
		liveSession = session;
		if (abortedInFlight || isCancelled(ledger, spec.forkId)) {
			ports.abortChild?.(session);
			return finish();
		}
		const initialRecord = forkOf(ledger, spec.forkId);
		if (initialRecord?.abandonRequested === true) {
			failed = true;
			reason = "abandoned before starting";
			// The request stopped the branch before it started, so the fact is
			// known here rather than read back from the bracket.
			writeOutcome(frozenRecord("", true, reason, initialRecord, true));
			return finish();
		}

		try {
			detachDisplay =
				ports.display?.attach?.(publicScopeId(forkOf(ledger, spec.forkId)), session) ?? null;
		} catch (error) {
			report?.("fork", error, { forkId: spec.forkId, phase: "display" });
		}

		const childAgentId =
			(typeof session?.getAgentId === "function" ? session.getAgentId() : null) ??
			session?.agent?.id ?? session?.agentId ?? created.agentId ?? null;
		if (typeof childAgentId === "string" && childAgentId !== "") {
			bindAgent(registry, spec.forkId, childAgentId);
		}

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
				// The station decides whether this child may rewind, from the branch
				// it was created on. The ticket never writes that field.
				childStation.adoptChildBranch(childStation.manager, hasOrigin);
				if (typeof originEntryId === "string" && originEntryId !== "") {
					updateRecordSnapshot(ledger, spec.forkId, {
						safeSnapshotLeafId: originEntryId,
					});
				}
			}
		} catch (error) {
			report?.("fork", error, { forkId: spec.forkId, phase: "child-context" });
		}

		let before = messagesOf(session).length;
		const syntheticOptions = { synthetic: true, attribution: "agent", userInitiated: false };
		const send =
			typeof session.prompt === "function"
				? (text, options) => session.prompt(text, { ...syntheticOptions, ...options })
				: typeof session.agent?.prompt === "function"
					? (text, options) => session.agent.prompt(text, { ...syntheticOptions, ...options })
					: null;
		const prompt = typeof send === "function" ? (text, options) => send(text, options) : null;

		/**
		 * Spend the shared return-nudge allowance and deliver one prompt.
		 *
		 * The abandoned and the normal stop paths differ only in what they say and
		 * in who owns a prompt failure: the abandoned path records its own reason,
		 * the normal path lets the error reach the outer catch, which is the record
		 * it would otherwise write. This helper owns the shared half; each caller
		 * keeps its own half. `false` means the allowance was already spent.
		 */
		const nudgeOnce = async (bracket, text) => {
			if (!takeReturnNudge(bracket)) return false;
			await prompt(text);
			return true;
		};
		if (typeof prompt !== "function") {
			failed = true;
			reason = "the forked scope's session exposes no prompt()";
			writeOutcome({ record: "", failed: true, reason });
			return finish();
		}
		if (typeof session.agent?.abort === "function" && typeof ports.stopAfterReturn === "function") {
			detachTermination = ports.stopAfterReturn(session.agent) ?? null;
		}

		const applyChildRewind = async (bracket) => {
			// One synchronous take: the plan leaves the slot before any await, so a
			// second pass cannot rewind twice.
			const pending = childStation?.consumeChildRewind?.() ?? null;
			if (!pending) return false;
			if (bracket?.abandonRequested === true) return false;
			const manager = childStation.manager ?? null;
			if (!hasOrigin || !manager) {
				throw new Error("child rewind requested without a rewindable branch manager");
			}
			await session.settleInFlightMessagePersistence?.();
			// The station rewrites its own branch: reset (or move) the leaf, rebuild
			// the projection, hand it through the declared capability, and settle its
			// caches. A host that refused the write leaves this session object to us.
			const rewound = childStation.commitChildRewind(childCtx ?? session, {
				originEntryId,
			});
			if (Array.isArray(rewound?.rebuilt) && rewound.applied !== true) {
				if (session?.agent?.state && Array.isArray(session.agent.state.messages)) {
					session.agent.state.messages = rewound.rebuilt.slice();
				} else if (Array.isArray(session?.messages)) {
					session.messages.splice(0, session.messages.length, ...rewound.rebuilt);
				}
			}
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

		let bracket = forkOf(ledger, spec.forkId);
		while (bracket && bracket.status === "running") {
			const stop = stopReasonOf(session);
			if (bracket.abandonRequested === true) {
				if (stop === "aborted") {
					const agentState = session?.agent?.state;
					if (agentState) agentState.stopReason = "stop";
				} else if (stop !== null && stop !== "stop" && stop !== "end") {
					failed = true;
					reason = `the worker in the abandoned scope stopped with reason "${stop}"`;
					break;
				}
				try {
					const delivered = await nudgeOnce(
						bracket,
						abandonedReturnNudge({
							by: bracket.abandonedBy,
							reason: bracket.abandonReason,
						}),
					);
					if (delivered === false) {
						failed = true;
						reason = "the worker in the abandoned scope stopped without calling scope_return";
						break;
					}
				} catch (err) {
					failed = true;
					reason = `abandoned final prompt failed: ${String(err?.message ?? err)}`;
					break;
				}
				bracket = forkOf(ledger, spec.forkId);
				continue;
			}
			if (await applyChildRewind(bracket)) {
				bracket = forkOf(ledger, spec.forkId);
				continue;
			}
			if (stop !== null && stop !== "stop" && stop !== "end") {
				failed = true;
				reason = `the worker in the forked scope stopped with reason "${stop}"`;
				break;
			}
			if ((await nudgeOnce(bracket, childReturnNudge())) === false) {
				failed = true;
				reason =
					"the worker in the forked scope stopped without calling scope_return; its record stays unpublished";
				unpublished = true;
				break;
			}
			bracket = forkOf(ledger, spec.forkId);
		}

		const cancelled = isCancelled(ledger, spec.forkId);
		if (!cancelled) {
			try {
				await session.settleInFlightMessagePersistence?.();
				const branch = session?.manager?.getBranch?.();
				const finalLeaf = Array.isArray(branch)
					? closedLeafId(branch)
					: (session?.manager?.getLeafId?.() ?? null);
				const occupancy = childStation?.measuredOccupancy?.() ?? null;
				updateRecordSnapshot(ledger, spec.forkId, {
					...(typeof finalLeaf === "string" && finalLeaf !== ""
						? { safeSnapshotLeafId: finalLeaf }
						: {}),
					...(Number.isFinite(occupancy) ? { snapshotContextTokens: occupancy } : {}),
				});
			} catch {
				// Best-effort snapshot seal.
			}
		}

		const added = messagesOf(session).slice(before);
		const text = unpublished ? "" : renderChildRecord(added, { start: 0 });
		const frozen = outcomeOf(registry, spec.forkId);
		if (text.trim() === "" && !failed && !unpublished && !frozen?.record) {
			failed = true;
			reason =
				"the worker in the forked scope produced no messages; the host accepted the prompt but recorded no turn";
		}
		const finalBracket = forkOf(ledger, spec.forkId);
		const wasAbandoned = finalBracket?.abandonRequested === true;
		if ((failed || unpublished) && finalBracket?.status === "running") {
			const receiver = liveReceiverOf(ledger, finalBracket.ownerId ?? "root");
			if (receiver && receiver !== spec.forkId) {
				reparentOrphans(ledger, spec.forkId, receiver);
			}
		}
		writeOutcome(frozenRecord(text, failed, reason, finalBracket, wasAbandoned));
		return finish();
	} catch (error) {
		failed = true;
		reason = String(error?.message ?? error);
		const errBracket = forkOf(ledger, spec.forkId);
		writeOutcome(frozenRecord("", true, reason, errBracket));
		report?.("fork", error, { forkId: spec.forkId });
		return finish();
	} finally {
		unregisterRunning?.();
		unregisterLiveInterrupt(registry, spec.forkId);
		detachTermination?.();
		if (created?.limitations?.length > 0) {
			report?.("fork", new Error("limits"), {
				forkId: spec.forkId,
				limits: created.limitations.length,
			});
		}
	}

	function finish() {
		detach();
		pulse(registry, ledger, spec.forkId, outcomeOf(registry, spec.forkId));
		ports.persistLedger?.();
		return { ok: true, failed, reason };
	}
}
