/**
 * Model-facing tool contracts. The prose lives in resources/prompts/tools/;
 * this module only wires it into JSON schemas.
 */

import { loadDoc } from "../prompts/index.mjs";
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
export const FORK_FSM_DESCRIPTION = forkJoin["fork.fsm"];
export const FORK_BUDGET_DESCRIPTION = forkJoin["fork.budget"];
export const FORK_N_DESCRIPTION = forkJoin["fork.n"];
const FORK_TARGETS_DESCRIPTION = forkJoin["fork.targets"];
const FORK_MODEL_DESCRIPTION = forkJoin["fork.model"];
const FORK_ITEMS_DESCRIPTION = forkJoin["fork.forks"];
const FORK_BLOCKED_DESCRIPTION = forkJoin["fork.blocked"];
const FORK_PROFESSION_DESCRIPTION = forkJoin["fork.profession"];
export const JOIN_DESCRIPTION = forkJoin["join.tool"];
export const RETURN_DESCRIPTION = forkJoin["return.tool"];
export const RETURN_DAFNY_DESCRIPTION = forkJoin["return.dafny"];

import { SCOPE_ID_PATTERN, MAX_SCOPE_ID_LENGTH } from "../scope/scope-id.mjs";

const forkItem = {
	type: "object",
	additionalProperties: false,
	// `fsm` is optional here because a reused `scopeId` may carry only a turn
	// increment, merged targets, or one more requirement. A new scope still
	// needs it: the station refuses with MISSING_FSM.
	required: ["scopeId", "profession", "blocked", "n", "budget", "targets"],
	properties: {
		scopeId: { type: "string", pattern: SCOPE_ID_PATTERN, maxLength: MAX_SCOPE_ID_LENGTH, description: forkJoin["fork.scope-id"] },
		fsm: { type: "string", minLength: 1, description: FORK_FSM_DESCRIPTION },
		profession: {
			type: "string",
			minLength: 9,
			pattern: "^You are \\S",
			description: FORK_PROFESSION_DESCRIPTION,
		},
		blocked: { type: "boolean", description: FORK_BLOCKED_DESCRIPTION },
		n: { type: "integer", minimum: 0, description: FORK_N_DESCRIPTION },
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

// `dafny` is required: a return without it is an incomplete handoff, because
// a tool's result is dropped from the record, so this field is the only path
// those facts have to the caller. The
// station trims it and refuses a blank value (MISSING_DAFNY), and `\S` states
// the same rule here so a field of spaces cannot pass the schema while the
// station would reject it. The name is the
// instruction: a Dafny-style specification is the form it invites, and
// `fork-join.md` owns the wording the model reads. A returning child does not
// summarize the parent's elder: the last receipt of its own level has no
// later sibling to archive it, so it is sealed instead of being reported.
export const returnParameters = {
	type: "object",
	additionalProperties: false,
	required: ["dafny"],
	properties: {
		dafny: { type: "string", pattern: "\\S", description: RETURN_DAFNY_DESCRIPTION },
	},
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


