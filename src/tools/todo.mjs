// The todo override ticket. It delegates the ledger itself to the native todo
// tool and adds only the relay gate and status. Never copy todo state here: the
// native `details.phases` snapshot is canonical, because the host's TodoTracker
// replays it from the transcript.
//
// todoTicket is the async ticket: it awaits the native invokeTool, then performs
// every relay state transition through the SessionStation's synchronous methods.

import { errorResult } from "./results.mjs";
import {
	handoffToolBlockedReason,
	inScopeTodoText,
	isTodoView,
	relayStatusText,
} from "../relay/index.mjs";
import { loadDoc, render } from "../prompts/index.mjs";

const errors = loadDoc("errors");

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

function replayPhases(view) {
	try {
		const branch = view?.branch?.() ?? [];
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
		fullFlow: relay.fullFlow,
		firstEvaluation: relay.firstEvaluation,
		canStop: relay.canStop,
		handoffPending: relay.handoffPending,
		promotionInvalidated: relay.promotionInvalidated,
		viewRequired: relay.viewRequired,
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
	const ownerId =
		typeof station.forkOwnerId === "function" ? station.forkOwnerId() : null;
	// The pending-handoff gate is the root's. A child's ledger write is its own
	// work, never a relay evaluation, even while it shares the root's relay.
	if (!ownerId && station.state.autopilot && station.state.relay?.handoffPending) {
		return errorResult(
			"RELAY_HANDOFF_PENDING",
			handoffToolBlockedReason(),
		);
	}
	// An inherited non-empty ledger is read before it is rewritten. A view is
	// free: it submits nothing, so requiring one costs the successor no budget.
	// Only the root branch owes this read, and only while autopilot owns the
	// ledger; a fork child has its own history and never evaluates the relay.
	if (!ownerId && station.state.autopilot && station.state.relay?.viewRequired && !isTodoView(params)) {
		return errorResult(
			"INHERITED_LEDGER_UNVIEWED",
			errors["inherited-ledger-unviewed"],
		);
	}
	if (typeof station.tickets?.invokeTool !== "function") {
		return errorResult(
			"TODO_NATIVE_UNAVAILABLE",
			errors["todo-native-unavailable"],
		);
	}

	let native;
	try {
		native = await station.tickets.invokeTool(ctx, params);
	} catch (error) {
		return errorResult(
			"TODO_NATIVE_FAILED",
			render(errors["todo-native-failed"], { detail: String(error?.message ?? error) }),
		);
	}
	if (!native || typeof native !== "object") {
		return errorResult(
			"TODO_NATIVE_INVALID",
			errors["todo-native-invalid"],
		);
	}
	// Keep the native ledger available, but do not evaluate it for relay while
	// autopilot is off. The relay is an autopilot protocol; manual duty owns
	// the ledger directly. Check after the native await too.
	if (!station.state.autopilot) return native;

	// A fork child has its own history. Its ledger write is real work, but the
	// relay is a root protocol: a child must not arm a handoff or clear the
	// inherited-ledger debt. Say so, so the model never mistakes a child's
	// write for a submitted evaluation.
	if (ownerId) {
		if (native.isError === true) return native;
		const depth =
			typeof station.forkDepthPort === "function" ? station.forkDepthPort() : 1;
		return appended(native, inScopeTodoText(depth));
	}

	const isError = native.isError === true;
	let details = native.details;
	let phases = Array.isArray(details?.phases) ? details.phases : null;
	let op = details?.op;
	if (!phases && !isError) {
		const replayed = replayPhases(station.sessionView?.(ctx) ?? null);
		if (replayed) {
			phases = replayed.phases;
			op = op ?? replayed.op;
		}
	}

	if (isError) {
		const text = relayStatusText(station.state.relay, station.state.relay.lastLedger, {
			action: null,
			error: "Native todo failed. The ledger and relay state are unchanged.",
		});
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
	if (op === "view" || isTodoView(params)) station.markInheritedLedgerViewed();

	const text = relayStatusText(applied.relay, applied.stats, {
		action: applied.action,
		unreceived: applied.unreceived,
	});
	if (applied.action === "handoff") {
		station.armHandoff(ctx);
	}

	const nextDetails =
		details && typeof details === "object"
			? { ...details, relay: relayDetails(station.state.relay) }
			: { relay: relayDetails(station.state.relay) };
	return { ...appended(native, text), details: nextDetails };
}
