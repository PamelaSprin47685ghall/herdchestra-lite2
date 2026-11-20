// Station texts: every model-facing scope string. The prose lives in
// resources/prompts/receipts/scope.md; this module chooses and composes it.

import { budgetText, currentScope, findPendingReportElder } from "../scope/index.mjs";
import { DECISION_FRAMING } from "../scope/stages.mjs";
import { handoffToolBlockedReason } from "../relay/index.mjs";
import { loadDoc, render } from "../prompts/index.mjs";

const T = loadDoc("receipts/scope");

function stageLine(scope) {
	if (scope.stage === "direct-execution") return T["stage-line.direct"];
	return render(T["stage-line"], { stage: scope.stage });
}

function beginText(scope) {
	const framing = scope.stage === DECISION_FRAMING;
	return render(T.begin, {
		intent: scope.intent,
		stage_line: stageLine(scope),
		budget: budgetText(scope) || "none",
		closing_line: framing ? T["begin.herd"] : T["begin.close"],
	});
}

function endText(
	report,
	foldedReport,
	deferredCount,
	steerText,
	steerSent,
	transitioning = false,
	remainingScope = null,
	relayOn = true,
	herdMode = false,
) {
	const lines = [];
	if (transitioning) {
		lines.push(T["end.transitioning"]);
	} else if (remainingScope) {
		lines.push(
			render(T["end.inside"], {
				intent: remainingScope.intent,
				budget: budgetText(remainingScope) || "none",
			}),
		);
		if (remainingScope.stage) lines.push(stageLine(remainingScope));
	} else {
		lines.push(T["end.outside"]);
	}
	if (foldedReport !== null) {
		lines.push(render(T["end.elder-folded"], { report: foldedReport }));
	}
	lines.push(T["end.keeps-turns"]);
	if (deferredCount > 0) {
		lines.push(
			render(
				steerSent ? T["end.defers-delivered"] : T["end.defers-follow"],
				{ count: deferredCount },
			),
		);
		lines.push(steerText);
	} else {
		lines.push(T["end.no-defers"]);
	}
	if (relayOn) {
		lines.push(remainingScope ? T["end.todo-inside"] : T["end.todo-outside"]);
	}
	if (!transitioning) {
		if (herdMode) {
			lines.push(T["end.herd"]);
		} else if (remainingScope) {
			lines.push(T["end.continue-inside"]);
		} else if (relayOn) {
			lines.push(T["end.promoted"]);
		} else {
			lines.push(T["end.finish"]);
		}
	}
	return lines.join("\n");
}

function amendText(applied, reflection = "") {
	const refunded = Number.isInteger(applied.refunded) ? applied.refunded : 0;
	const residual = Array.isArray(applied.residualDefers)
		? applied.residualDefers.length
		: 0;
	const lines = [];
	if (reflection !== "") {
		lines.push(render(T["amend.replaced"], { text: reflection }));
	}
	lines.push(
		T["amend.undone"],
		refunded > 0
			? render(T["amend.refunded"], { count: refunded })
			: T["amend.no-refund"],
		render(T["amend.remaining"], {
			budget: budgetText(applied.scope) || "none",
		}),
	);
	if (residual > 0) {
		lines.push(render(T["amend.residual"], { count: residual }));
	}
	return lines.join("\n");
}

function leaveFramingText(scope) {
	return scope.stage === DECISION_FRAMING ? ` ${T["leave-framing"]}` : "";
}

function insideScopeNudge(state) {
	const scope = currentScope(state);
	if (!scope) return "";
	const fullFlow = state.relay?.fullFlow === true;
	return render(fullFlow ? T["inside-nudge"] : T["inside-nudge.simple"], {
		level: state.scopes.length,
		intent: JSON.stringify(scope.intent),
		leave_framing: leaveFramingText(scope),
	});
}

/** Dynamic, persistent receipt. Appended to history only when text changes. */
function clockLine(state, now = Date.now()) {
	const started = Number.isFinite(state?.startedAt) ? state.startedAt : now;
	const elapsed = Math.max(0, now - started);
	const minutes = Math.floor(elapsed / 60000);
	const seconds = Math.floor((elapsed % 60000) / 1000);
	return `UTC now ${new Date(now).toISOString()}, ${minutes}m${String(seconds).padStart(2, "0")}s since this session began.`;
}

export function skillReceiptText(state, relayOn = true) {
	const scope = currentScope(state);
	const fullFlow = state.relay?.fullFlow === true;
	const boundary = Number.isInteger(state.relay?.generation) && state.relay.generation >= 0
		? state.relay.generation
		: 0;
	const pendingElder = findPendingReportElder(
		state,
		scope?.id ?? null,
		boundary,
		Number.isInteger(state.epoch) && state.epoch >= 0 ? state.epoch : 0,
	);
	const lines = scope
		? [
			render(T["receipt.inside"], {
				level: state.scopes.length,
				intent: JSON.stringify(scope.intent),
				budget: budgetText(scope) || "none",
			}),
		]
		: [T["receipt.outside"]];
	lines.push(T["language"]);
	lines.push(
		render(T["receipt.herd"], { mode: state.herdMode ? "on" : "off" }),
	);
	if (scope?.stage) {
		lines.push(render(T["receipt.stage"], { stage: scope.stage }));
	}
	// `begin.elder_report` tells the model to summarize the pending elder, but
	// only this receipt knows whether one exists. Naming it here is what keeps
	// that parameter honest; a generic reminder would be ignored.
	lines.push(
		pendingElder
			? render(T["receipt.pending-elder"], {
				intent: JSON.stringify(pendingElder.intent ?? ""),
			})
			: T["receipt.no-pending-elder"],
	);
	lines.push(clockLine(state));
	if (state.herdMode) {
		lines.push(T["receipt.herd-rules"]);
	} else if (relayOn && fullFlow) {
		if (state.relay?.firstEvaluation === null) {
			lines.push(T["receipt.no-ledger"]);
		}
		if (scope?.stage === DECISION_FRAMING) {
			lines.push(T["receipt.close-framing"]);
		}
		if (state.relay?.handoffPending) {
			lines.push(
				scope ? T["receipt.close-handoff"] : handoffToolBlockedReason(),
			);
		} else if (!scope && state.relay?.canStop) {
			lines.push(T["receipt.can-stop"]);
		} else {
			lines.push(T["receipt.todo"]);
		}
	} else if (relayOn) {
		lines.push(scope ? T["receipt.simple-inside"] : T["receipt.simple-outside"]);
	} else if (!scope) {
		lines.push(T["receipt.finish"]);
	}
	return `<skill version="1.0">${lines.join(" ")}</skill>`;
}

function insideScopeText(state) {
	const scope = currentScope(state);
	if (!scope) return "";
	const fullFlow = state.relay?.fullFlow === true;
	return render(fullFlow ? T["inside-text"] : T["inside-text.simple"], {
		level: state.scopes.length,
		intent: JSON.stringify(scope.intent),
		leave_framing: leaveFramingText(scope),
	});
}

export {
	beginText,
	endText,
	amendText,
	insideScopeNudge,
	insideScopeText,
};
