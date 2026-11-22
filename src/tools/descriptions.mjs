/**
 * Model-facing tool contracts. The prose lives in resources/prompts/tools/;
 * this module only wires it into JSON schemas.
 */

import { loadDoc } from "../prompts/index.mjs";
import {
	ELDER_REPORT_PATTERN,
	MIN_ELDER_REPORT_CHARS,
} from "../scope/elder-report.mjs";

const notes = loadDoc("tools/notes");

// amend and pin are the only working-level control tools. The concurrency
// protocol is the three fork/join/return tools; the retired `scope` container
// has no schema, no description and no handler.
export const AMEND_DESCRIPTION = notes["amend.tool"];
export const REFLECTION_DESCRIPTION = notes["amend.reflection"];
export const PIN_DESCRIPTION = notes["pin.tool"];
export const PIN_ASSUMPTION_DESCRIPTION = notes["pin.assumption"];
export const PIN_DEDUCTION_DESCRIPTION = notes["pin.deduction"];
export const PIN_INDUCTION_DESCRIPTION = notes["pin.induction"];
export const PIN_FINDING_DESCRIPTION = notes["pin.finding"];
export const PIN_CONCLUSION_DESCRIPTION = notes["pin.conclusion"];

const forkJoin = loadDoc("tools/fork-join");

export const FORK_DESCRIPTION = forkJoin["fork.tool"];
export const FORK_INTENT_DESCRIPTION = forkJoin["fork.intent"];
export const FORK_BUDGET_DESCRIPTION = forkJoin["fork.budget"];
export const FORK_TIME_DESCRIPTION = forkJoin["fork.time"];
export const FORK_PERMISSION_DESCRIPTION = forkJoin["fork.permission"];
export const FORK_MODEL_DESCRIPTION = forkJoin["fork.model"];
export const FORK_ITEMS_DESCRIPTION = forkJoin["fork.forks"];
export const FORK_BLOCKED_DESCRIPTION = forkJoin["fork.blocked"];
export const JOIN_DESCRIPTION = forkJoin["join.tool"];
export const JOIN_ELDER_DESCRIPTION = forkJoin["join.elder_report"];
export const RETURN_DESCRIPTION = forkJoin["return.tool"];

import { SCOPE_ID_PATTERN, MAX_SCOPE_ID_LENGTH } from "../scope/scope-id.mjs";

const forkItem = {
	type: "object",
	additionalProperties: false,
	required: ["scopeId", "intent", "blocked", "budget", "time", "permission"],
	properties: {
		scopeId: { type: "string", pattern: SCOPE_ID_PATTERN, maxLength: MAX_SCOPE_ID_LENGTH, description: forkJoin["fork.scope-id"] },
		intent: { type: "string", minLength: 1, description: FORK_INTENT_DESCRIPTION },
		blocked: { type: "boolean", description: FORK_BLOCKED_DESCRIPTION },
		budget: {
			type: "object",
			additionalProperties: { type: "integer", minimum: 0 },
			description: FORK_BUDGET_DESCRIPTION,
		},
		time: { type: "number", exclusiveMinimum: 0, description: FORK_TIME_DESCRIPTION },
		permission: {
			type: "string",
			enum: ["ro", "rw"],
			description: FORK_PERMISSION_DESCRIPTION,
		},
		model: {
			anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
			description: FORK_MODEL_DESCRIPTION,
		},
	},
};

export const forkParameters = {
	type: "object",
	additionalProperties: false,
	required: ["forks"],
	properties: {
		forks: {
			type: "array",
			minItems: 1,
			description: FORK_ITEMS_DESCRIPTION,
			items: forkItem,
		},
	},
};

const elderReportProperty = (description) => ({
	anyOf: [
		{
			type: "string",
			minLength: MIN_ELDER_REPORT_CHARS,
			// The same acceptance rule as the runtime: the stored report is
			// trimmed, so the pattern measures the span between the first and
			// last non-space characters. A blank value has no such span.
			pattern: ELDER_REPORT_PATTERN,
		},
		{ type: "null" },
	],
	description,
});

export const joinParameters = {
	type: "object",
	additionalProperties: false,
	required: ["elder_report"],
	properties: {
		elder_report: elderReportProperty(JOIN_ELDER_DESCRIPTION),
	},
};

// scope_return takes no arguments. A returning child does not summarize the
// parent's elder: the last receipt of its own level has no later sibling to
// archive it, so it is sealed instead of being reported.
export const returnParameters = {
	type: "object",
	additionalProperties: false,
	properties: {},
};

export const amendParameters = {
	type: "object",
	additionalProperties: false,
	required: ["reflection"],
	properties: {
		reflection: { type: "string", minLength: 1, description: REFLECTION_DESCRIPTION },
	},
};

const pinField = (description) => ({
	type: "string",
	minLength: 1,
	// A field of spaces carries nothing; it must not satisfy the anyOf gate.
	pattern: "\\S",
	description,
});

export const pinParameters = {
	type: "object",
	additionalProperties: false,
	// At least one field must be present with content. The runtime refuses a
	// call that satisfies the property types but names no non-blank field.
	anyOf: [
		{ required: ["assumption"] },
		{ required: ["deduction"] },
		{ required: ["induction"] },
		{ required: ["finding"] },
		{ required: ["conclusion"] },
	],
	properties: {
		assumption: pinField(PIN_ASSUMPTION_DESCRIPTION),
		deduction: pinField(PIN_DEDUCTION_DESCRIPTION),
		induction: pinField(PIN_INDUCTION_DESCRIPTION),
		finding: pinField(PIN_FINDING_DESCRIPTION),
		conclusion: pinField(PIN_CONCLUSION_DESCRIPTION),
	},
};
