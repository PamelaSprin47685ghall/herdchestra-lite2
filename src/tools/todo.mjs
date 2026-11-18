// The todo override ticket. It delegates the ledger itself to the native todo
// tool and adds only the relay gate and status. Never copy todo state here: the
// native `details.phases` snapshot is canonical, because the host's TodoTracker
// replays it from the transcript.
//
// todoTicket is the async ticket: it awaits the native invokeTool, then performs
// every relay state transition through the SessionStation's synchronous methods.

import { currentScope } from "../scope/index.mjs";
import { errorResult } from "./results.mjs";
import {
	handoffFocus,
	isTodoView,
	relayStatusText,
	successorPrompt,
} from "../relay/index.mjs";

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
			text +=
				"\n\nHandoff is pending. Finish your reply to the user now; do not call another tool. The runtime runs `/handoff` after this turn.";
		}
	}

	const nextDetails =
		details && typeof details === "object"
			? { ...details, relay: relayDetails(station.state.relay) }
			: { relay: relayDetails(station.state.relay) };
	return { ...appended(native, text), details: nextDetails };
}
