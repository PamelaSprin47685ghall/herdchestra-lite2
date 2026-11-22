// Station handler for `scope_panhandle`: decide, land the grant, report it.
//
// Synchronous. The grant is arithmetic on the branch record, not I/O. The
// execute core owns persistence and the per-call idempotence cache.

import { applyPanhandle, forkBudgetText } from "../scope/index.mjs";
import { errorResult, textResult } from "../tools/results.mjs";
import { loadDoc, render } from "../prompts/index.mjs";
import { decidePanhandle } from "./domain/panhandle.mjs";

const E = loadDoc("errors");
const G = loadDoc("tools/panhandle");

// The scope layer owns the grant's own laws and words. The station adds words
// only for the two refusals the scope layer cannot see: no branch record, and
// no reason on the call.
const STATION_ERRORS = {
	NO_BRANCH_BUDGET: "panhandle-no-budget",
	PANHANDLE_BLOCKED: "panhandle-blocked",
	PANHANDLE_CLOSED: "panhandle-not-running",
	PANHANDLE_NO_REASON: "panhandle-no-reason",
};

function refusal(code, vars = {}, details = {}) {
	const section = STATION_ERRORS[code];
	const message =
		typeof details.message === "string" && details.message !== ""
			? details.message
			: render(E[section] ?? "panhandle-unavailable", vars);
	return errorResult(code, message, { ...details, code });
}

function describeGrant(tools, seconds) {
	const parts = Object.keys(tools)
		.sort()
		.map((tool) => `${tools[tool]} ${tool}`);
	if (seconds > 0) parts.push(`${seconds}s`);
	return parts.join(", ");
}

/**
 * Apply one panhandle call. The handler mutates the ledger and returns the
 * answer; the execute core caches that answer and persists the state, so a
 * host retry of the same tool call cannot grant twice.
 */
export function handlePanhandleCall(station, call) {
	const args =
		call?.arguments && typeof call.arguments === "object" ? call.arguments : {};
	const record =
		typeof station.branchRecord === "function" ? station.branchRecord() : null;
	const decision = decidePanhandle({ record, because: args.because });
	if (!decision.ok) {
		return refusal(decision.code);
	}

	const ledger =
		typeof station.forkLedgerPort === "function"
			? station.forkLedgerPort()
			: null;
	const ownerId =
		typeof station.forkOwnerId === "function" ? station.forkOwnerId() : null;
	if (!ledger || !ownerId) return refusal("NO_BRANCH_BUDGET");

	const now = Date.now();
	const applied = applyPanhandle(
		ledger,
		ownerId,
		{
			tools: args.tools ?? undefined,
			seconds: args.seconds ?? undefined,
		},
		{ now },
	);
	if (!applied || applied.ok !== true) {
		return refusal(applied?.code ?? "PANHANDLE_UNAVAILABLE", {}, {
			message: applied?.reason ?? null,
			reason: applied?.reason ?? null,
		});
	}

	const clock =
		typeof station.clockPort === "function" ? station.clockPort() : null;
	return textResult(
		render(G["panhandle.granted"], {
			grant: describeGrant(applied.tools, applied.seconds),
			budget: forkBudgetText(record, now, clock),
			because: decision.reason,
		}),
		{
			code: "PANHANDLE_GRANTED",
			tools: applied.tools,
			seconds: applied.seconds,
			count: applied.count,
			because: decision.reason,
			budget: record?.budget ?? null,
			remaining: record?.remaining ?? null,
			deadlineAt: record?.deadlineAt ?? null,
		},
	);
}
