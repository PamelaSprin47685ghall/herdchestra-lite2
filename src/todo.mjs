// The todo override. It delegates the ledger itself to the native todo tool and
// adds only the relay gate and status. Never copy todo state here: the native
// `details.phases` snapshot is canonical, because the host's TodoTracker
// replays it from the transcript.
//
// todoTicket is the async ticket: it awaits the native invokeTool, then performs
// every relay state transition through the SessionStation's synchronous methods.

import { currentScope } from "./engine.mjs";
import { errorResult } from "./results.mjs";
import {
	handoffFocus,
	isTodoView,
	relayStatusText,
	successorPrompt,
} from "./relay.mjs";

export const TODO_DESCRIPTION = `Record the ledger of remaining work. todo is free and is the only functional tool that may be called when all scopes are closed. It is forbidden inside any active scope at any level: close every scope first. The ledger is canonical: it is what the next relay holder reads before deciding whether work remains.

Operations: init replaces and submits the whole ledger; view is a read-only check that does NOT advance the relay evaluation and does not change the ledger; list: [] is an empty ledger. A non-empty ledger forbids a natural stop. An empty ledger does not allow a stop either: it must trigger a real built-in /handoff to a successor. Only the successor's first submitted write-operation evaluation being empty (a promotion) allows a natural stop. The successor may open any number of scopes to investigate first; todo need not be the successor's first tool call. If the successor's first submitted evaluation is non-empty, it enters rework and is not the last holder: even if it later empties the ledger, it must reach another handoff to the next successor.

Write every item so the next agent understands the work from the ledger alone: the verbatim user requirement, the evidence that proves it, unresolved risks, and the next concrete action. The tool result appends RELAY STATE: the current generation, this generation's first evaluation, whether the ledger is empty, whether stopping is allowed, and the next required action.`;

export const TODO_OP_DESCRIPTION =
	"One incremental todo operation. Omit it and the native tool infers the operation from the other fields. init replaces and submits the entire ledger from list (list: [] submits an empty ledger). start moves an existing task to in_progress. done completes it. rm removes it. drop abandons it. block marks it blocked, with reason as the blocker note. unblock returns it to pending. append adds items to a phase. view is a read-only check: it does NOT advance the relay evaluation and does not change the ledger. To submit a ledger, use a write operation, most explicitly init with the full list. A failed call never advances the relay state.";

export const TODO_LIST_DESCRIPTION =
	"Full ledger replacement for op: init. Each entry is { phase, items }, where phase names the phase and items is an array of task strings. The list replaces every existing phase; an empty array is an empty ledger, which triggers the real /handoff protocol rather than allowing a stop.";

export const TODO_TASK_DESCRIPTION =
	"The existing task's verbatim content, used by start, done, rm, drop, block, and unblock. Copy it exactly from the ledger.";

export const TODO_PHASE_DESCRIPTION =
	"The phase name. Used by append and by the init list entries. Phase names are the lookup key for later operations.";

export const TODO_ITEMS_DESCRIPTION =
	"Task strings for op: append. Each string becomes a pending task in the named phase.";

export const TODO_REASON_DESCRIPTION =
	"When op is block, a short note on what the task is waiting for. Optional otherwise.";

export const TODO_PARAMETERS = {
	type: "object",
	additionalProperties: true,
	properties: {
		op: {
			type: "string",
			enum: [
				"init",
				"start",
				"done",
				"rm",
				"drop",
				"block",
				"unblock",
				"append",
				"view",
			],
			description: TODO_OP_DESCRIPTION,
		},
		list: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: true,
				properties: {
					phase: { type: "string", description: TODO_PHASE_DESCRIPTION },
					items: {
						type: "array",
						items: { type: "string" },
						description: "Task strings for this phase.",
					},
				},
			},
			description: TODO_LIST_DESCRIPTION,
		},
		task: { type: "string", description: TODO_TASK_DESCRIPTION },
		phase: { type: "string", description: TODO_PHASE_DESCRIPTION },
		items: {
			type: "array",
			items: { type: "string" },
			description: TODO_ITEMS_DESCRIPTION,
		},
		reason: { type: "string", description: TODO_REASON_DESCRIPTION },
	},
};

function nativeContent(native) {
	if (Array.isArray(native?.content) && native.content.length > 0) {
		return native.content;
	}
	return [{ type: "text", text: String(native?.content ?? "") }];
}

function appended(native, text) {
	return {
		...native,
		content: [...nativeContent(native), { type: "text", text }],
	};
}

function replayPhases(ctx) {
	try {
		const branch = ctx?.sessionManager?.getBranch?.() ?? [];
		for (let index = branch.length - 1; index >= 0; index -= 1) {
			const entry = branch[index];
			const message = entry?.type === "message" ? entry.message : entry?.message;
			if (message?.role !== "toolResult") continue;
			if (message.toolName !== "todo" || message.isError) continue;
			const details = message.details;
			if (!details || details.op === "view") continue;
			if (Array.isArray(details.phases)) {
				return { phases: details.phases, op: details.op };
			}
		}
	} catch {
		// A manager without a branch cannot replay; report the missing snapshot.
	}
	return null;
}

function relayDetails(relay) {
	return {
		generation: relay.generation,
		firstEvaluation: relay.firstEvaluation,
		canStop: relay.canStop,
		handoffPending: relay.handoffPending,
		promotionInvalidated: relay.promotionInvalidated,
		handoffError: relay.handoffError,
		lastHandoff: relay.lastHandoff,
		lastLedger: relay.lastLedger,
	};
}

/**
 * The todo execute ticket.
 *
 * The native schema is deliberately permissive here: the host's lenient op
 * inference is part of the native contract, so params are passed through
 * untouched. This ticket adds no fields and never mutates details.phases.
 */
export async function todoTicket(station, params, ctx) {
	if (currentScope(station.state)) {
		return errorResult(
			"TODO_OUTSIDE_SCOPE_ONLY",
			"todo is forbidden inside any active scope. Close every scope first, then call todo outside all scopes.",
		);
	}
	if (
		station.state.relay?.handoffPending &&
		!isTodoView(params)
	) {
		return errorResult(
			"RELAY_HANDOFF_PENDING",
			"A relay handoff is pending. A todo view is allowed for diagnosis; do not change the ledger. The runtime retries the real AgentSession.handoff() if it did not start.",
		);
	}
	if (typeof ctx?.invokeTool !== "function") {
		return errorResult(
			"TODO_NATIVE_UNAVAILABLE",
			"This host does not expose ctx.invokeTool, so the native todo implementation cannot run. Do not implement todo state locally.",
		);
	}

	let native;
	try {
		native = await ctx.invokeTool(params);
	} catch (error) {
		return errorResult(
			"TODO_NATIVE_FAILED",
			`The native todo call threw: ${String(error?.message ?? error)}`,
		);
	}
	if (!native || typeof native !== "object") {
		return errorResult(
			"TODO_NATIVE_INVALID",
			"The native todo call returned no result object.",
		);
	}

	const isError = native.isError === true;
	let details = native.details;
	let phases = Array.isArray(details?.phases) ? details.phases : null;
	let op = details?.op;
	if (!phases && !isError) {
		const replayed = replayPhases(ctx);
		if (replayed) {
			phases = replayed.phases;
			op = op ?? replayed.op;
		}
	}

	if (isError) {
		const text = `RELAY STATE\nThis todo call failed, so it did not advance the relay evaluation and did not change the ledger.\n${relayStatusText(station.state.relay, station.state.relay.lastLedger, { action: null, error: "native todo returned an error" })}`;
		if (details && typeof details === "object") {
			details = { ...details };
		}
		return { ...appended(native, text), details };
	}

	if (!phases) {
		return appended(
			native,
			"RELAY STATE\nInternal error: the native todo result carried no details.phases and the transcript replay found no successful todo snapshot. The relay state was not advanced. Preserve the native result.",
		);
	}

	const applied = station.recordLedgerEvaluation(phases, op, { isError: false });

	let text = relayStatusText(applied.relay, applied.stats, {
		action: applied.action,
	});
	if (applied.action === "handoff") {
		const outcome = station.markHandoffPending(ctx, {
			reason: "empty-ledger",
			focus: handoffFocus(applied.relay),
		});
		if (outcome?.ok === false) {
			text += `\n\nHANDOFF FAILED: ${outcome.error}`;
		} else if (outcome?.pending) {
			const gen0FirstEmpty =
				station.state.relay.generation === 0 &&
				station.state.relay.firstEvaluation === "empty";
			if (gen0FirstEmpty) {
				text +=
					"\n\nHandoff is pending. Finish your reply to the user now; do not call another tool. The runtime runs the real handoff after this turn.";
			} else {
				text +=
					"\n\nHandoff is pending. The next context hook interrupts this turn and runs the real handoff before the model request. Do not call another tool.";
				text += `\n\n${successorPrompt(station.state.relay, station.state.relay.lastLedger ?? null)}`;
			}
		}
	}

	const nextDetails =
		details && typeof details === "object"
			? { ...details, relay: relayDetails(station.state.relay) }
			: { relay: relayDetails(station.state.relay) };
	return { ...appended(native, text), details: nextDetails };
}
