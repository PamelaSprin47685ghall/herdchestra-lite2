/**
 * Model-facing tool contracts. The prose lives in resources/prompts/tools/;
 * this module only wires it into JSON schemas.
 */

import { loadDoc, render } from "../prompts/index.mjs";
import {
	PANHANDLE_MAX_PER_TOOL,
	PANHANDLE_MAX_SECONDS,
} from "../scope/panhandle.mjs";

const notes = loadDoc("tools/notes");

// `scope_context` is the one working-level control tool. The retired tool
// prose now lives on its two optional objects, where the model chooses the
// field that needs it. The concurrency protocol is the three fork/join/return
// tools; the retired `scope` container has no schema, description or handler.
export const SCOPE_CONTEXT_DESCRIPTION = notes["scope_context.tool"];
export const AMEND_PARAMETER_DESCRIPTION = notes["amend.tool"];
export const REFLECTION_DESCRIPTION = notes["amend.reflection"];
export const PIN_PARAMETER_DESCRIPTION = notes["pin.tool"];
export const PIN_ASSUMPTION_DESCRIPTION = notes["pin.assumption"];
export const PIN_DEDUCTION_DESCRIPTION = notes["pin.deduction"];
export const PIN_INDUCTION_DESCRIPTION = notes["pin.induction"];
export const PIN_FINDING_DESCRIPTION = notes["pin.finding"];
export const PIN_CONCLUSION_DESCRIPTION = notes["pin.conclusion"];

const forkJoin = loadDoc("tools/fork-join");

export const FORK_DESCRIPTION = forkJoin["fork.tool"];
export const FORK_INTENT_DESCRIPTION = forkJoin["fork.intent"];
export const FORK_BUDGET_DESCRIPTION = forkJoin["fork.budget"];
const FORK_TARGETS_DESCRIPTION = forkJoin["fork.targets"];
const FORK_MODEL_DESCRIPTION = forkJoin["fork.model"];
const FORK_ITEMS_DESCRIPTION = forkJoin["fork.forks"];
const FORK_BLOCKED_DESCRIPTION = forkJoin["fork.blocked"];
export const JOIN_DESCRIPTION = forkJoin["join.tool"];
export const RETURN_DESCRIPTION = forkJoin["return.tool"];

import { SCOPE_ID_PATTERN, MAX_SCOPE_ID_LENGTH } from "../scope/scope-id.mjs";

const panhandle = loadDoc("tools/panhandle");

export const PANHANDLE_DESCRIPTION = render(panhandle["panhandle.tool"], {
	maxPoints: PANHANDLE_MAX_PER_TOOL,
	maxSeconds: PANHANDLE_MAX_SECONDS,
});
export const PANHANDLE_TOOLS_DESCRIPTION = panhandle["panhandle.tools"];
export const PANHANDLE_SECONDS_DESCRIPTION = panhandle["panhandle.seconds"];
export const PANHANDLE_BECAUSE_DESCRIPTION = panhandle["panhandle.because"];

const forkItem = {
	type: "object",
	additionalProperties: false,
	// `intent` is optional here because a reused `scopeId` may carry only a
	// budget increment, merged targets, or one more requirement. A new scope
	// still needs it: the station refuses with MISSING_INTENT.
	required: ["scopeId", "blocked", "budget", "targets"],
	properties: {
		scopeId: { type: "string", pattern: SCOPE_ID_PATTERN, maxLength: MAX_SCOPE_ID_LENGTH, description: forkJoin["fork.scope-id"] },
		intent: { type: "string", minLength: 1, description: FORK_INTENT_DESCRIPTION },
		blocked: { type: "boolean", description: FORK_BLOCKED_DESCRIPTION },
		budget: {
			type: "object",
			additionalProperties: { type: "integer", minimum: 0 },
			description: FORK_BUDGET_DESCRIPTION,
		},
		targets: {
			type: "array",
			minItems: 1,
			items: { type: "string", minLength: 1, pattern: "\\S" },
			description: FORK_TARGETS_DESCRIPTION,
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

export const joinParameters = {
	type: "object",
	additionalProperties: false,
	properties: {},
};

// scope_return takes no arguments. A returning child does not summarize the
// parent's elder: the last receipt of its own level has no later sibling to
// archive it, so it is sealed instead of being reported.
export const returnParameters = {
	type: "object",
	additionalProperties: false,
	properties: {},
};

const amendObject = {
	type: "object",
	additionalProperties: false,
	required: ["reflection"],
	description: AMEND_PARAMETER_DESCRIPTION,
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

const pinObject = {
	type: "object",
	additionalProperties: false,
	description: PIN_PARAMETER_DESCRIPTION,
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

// Both objects are optional; one must arrive. The runtime refuses an empty
// call rather than reporting a change it did not make.
export const scopeContextParameters = {
	type: "object",
	additionalProperties: false,
	anyOf: [{ required: ["pin"] }, { required: ["amend"] }],
	properties: {
		pin: pinObject,
		amend: amendObject,
	},
};

// The reasons and caps mirror the runtime: the schema refuses an empty or
// oversized request before the call runs, and the domain refuses it again.
export const panhandleParameters = {
	type: "object",
	additionalProperties: false,
	required: ["because"],
	anyOf: [{ required: ["tools"] }, { required: ["seconds"] }],
	properties: {
		tools: {
			type: "object",
			additionalProperties: {
				type: "integer",
				minimum: 1,
				maximum: PANHANDLE_MAX_PER_TOOL,
			},
			description: PANHANDLE_TOOLS_DESCRIPTION,
		},
		seconds: {
			type: "integer",
			minimum: 1,
			maximum: PANHANDLE_MAX_SECONDS,
			description: PANHANDLE_SECONDS_DESCRIPTION,
		},
		because: pinField(PANHANDLE_BECAUSE_DESCRIPTION),
	},
};
