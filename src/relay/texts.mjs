// Relay texts: every model-facing relay string. The prose lives in
// resources/prompts/receipts/relay.md and resources/prompts/labels.md;
// this module chooses and composes it.

import { copyRelay } from "./state.mjs";
import { normalizedStats } from "./ledger.mjs";
import { loadDoc, render } from "../prompts/index.mjs";

const R = loadDoc("receipts/relay");
const L = loadDoc("labels");

function evaluationLabel(relay) {
	if (relay.firstEvaluation === null) return L["evaluation-none"];
	if (relay.firstEvaluation === "empty") return L["evaluation-empty"];
	return L["evaluation-nonempty"];
}

function flowLabel(relay) {
	return relay.fullFlow === true ? L["flow-full"] : L["flow-simple"];
}

function nextStepText(relay, stats, action, options = {}) {
	switch (action) {
		case "promoted":
			return R["next.promoted"];
		case "reopened":
			return R["next.reopened"];
		case "handoff":
			return handoffDemand();
		case "retire":
			return R["next.retire"];
		case "held":
			return render(R["next.held-children"], {
				open: Number.isInteger(options.unreceived) ? options.unreceived : 0,
			});
		case "rework":
			return relay.generation === 0
				? R["next.rework-first"]
				: R["next.rework-successor"];
		case "continue":
			return R["next.continue"];
		default:
			if (relay.handoffPending) return handoffDemand();
			if (relay.canStop) return R["next.finish"];
			if (relay.viewRequired) return R["inherited-ledger"];
			if (relay.fullFlow !== true) return R["next.simple"];
			return stats ? R["next.unchanged"] : R["next.none"];
	}
}

export function relayStatusText(relay, stats, options = {}) {
	const current = copyRelay(relay);
	const ledger = normalizedStats(stats, current);
	const lines = [
		R["status.title"],
		render(R["status.generation"], {
			generation: current.generation,
			holder: current.generation === 0 ? "original holder" : "successor",
		}),
		render(R["status.evaluation"], { label: evaluationLabel(current) }),
		render(R["status.flow"], { flow: flowLabel(current) }),
	];
	if (ledger) {
		lines.push(
			render(R["status.ledger"], {
				state: ledger.empty ? "empty" : "non-empty",
				total: ledger.total,
				open: ledger.open,
				blocked: ledger.blocked,
				completed: ledger.completed,
				abandoned: ledger.abandoned,
			}),
		);
	} else {
		lines.push(R["status.ledger-none"]);
	}
	lines.push(
		render(R["status.can-stop"], {
			answer: current.canStop ? "yes" : "no",
		}),
	);
	if (current.promotionInvalidated) lines.push(R["status.promotion"]);
	if (current.handoffPending) lines.push(R["status.handoff-pending"]);
	if (current.handoffError) {
		lines.push(render(R["status.handoff-error"], { error: current.handoffError }));
	}
	if (options.error) {
		lines.push(render(R["status.call-error"], { error: options.error }));
	}
	lines.push(
		render(R["status.next"], {
			next: nextStepText(current, ledger, options.action ?? null, options),
		}),
	);
	return lines.join("\n");
}

/** What one deep todo call did, and what it did not do. */
export function inScopeTodoText(level) {
	return render(R["next.inside-scope"], {
		level: Number.isInteger(level) && level > 0 ? level : 1,
	});
}

/**
 * The todo result and the natural-stop prompt use this same demand. A context
 * receipt supplies it only when the primary copy is not visible.
 */
export function handoffDemand() {
	return R["handoff-demand"];
}

export function handoffToolBlockedReason() {
	return R["handoff-blocked"];
}

export function successorOpeningText(relay, report, pins = []) {
	const current = copyRelay(relay);
	const trimmed = typeof report === "string" ? report.trim() : "";
	return [
		trimmed,
		"---",
		render(R["successor-opening.head"], {
			next: current.generation + 1,
			prev: current.generation,
		}),
		R["successor-mandate"],
		current.viewRequired ? R["inherited-ledger"] : null,
		R["successor-rule"],
		R["stop-rule"],
		pins.length > 0 ? R["pinned-reading"] : null,
		render(R["successor-opening.pins"], {
			pins: pins.length > 0 ? pins.join("\n\n---\n\n") : L["no-pins"],
		}),
	].filter(Boolean).join("\n\n");
}

export function successorStartNudge(relay) {
	const current = copyRelay(relay);
	return render(R["successor-start"], { generation: current.generation });
}

export function handoffFailureNudge(error) {
	const message = String(error?.message ?? error ?? L["unknown-error"]);
	return render(R["handoff-failure"], { message });
}
