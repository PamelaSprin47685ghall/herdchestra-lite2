/**
 * Model-facing tool contracts. The prose lives in resources/prompts/tools/;
 * this module only wires it into JSON schemas.
 */

import { loadDoc } from "../prompts/index.mjs";
import { RETURN_OATH_KEY, RETURN_OATH_VALUE } from "../station/domain/handoff.mjs";
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
const FORK_PROFESSION_DESCRIPTION = forkJoin["fork.profession"];
export const JOIN_DESCRIPTION = forkJoin["join.tool"];
export const RETURN_DESCRIPTION = forkJoin["return.tool"];
export const RETURN_DAFNY_DESCRIPTION = forkJoin["return.dafny"];
export const RETURN_OATH_DESCRIPTION = forkJoin["return.oath"];
export { RETURN_OATH_KEY, RETURN_OATH_VALUE };

export const SEND_DESCRIPTION = forkJoin["send.tool"];
export const SEND_TARGET_DESCRIPTION = forkJoin["send.target"];
export const SEND_MESSAGE_DESCRIPTION = forkJoin["send.message"];
export const SEND_BUDGET_DESCRIPTION = forkJoin["send.budget"];

import { SCOPE_ID_PATTERN, MAX_SCOPE_ID_LENGTH } from "../scope/scope-id.mjs";

const forkItem = {
	type: "object",
	additionalProperties: false,
	// Every fork starts a new scope, so every field is required; the station
	// still refuses a blank `fsm` with MISSING_FSM, and this `minLength` states
	// the same rule one layer earlier.
	required: ["scopeId", "fsm", "profession", "n", "budget", "targets"],
	properties: {
		scopeId: { type: "string", pattern: SCOPE_ID_PATTERN, maxLength: MAX_SCOPE_ID_LENGTH, description: forkJoin["fork.scope-id"] },
		fsm: { type: "string", minLength: 1, description: FORK_FSM_DESCRIPTION },
		profession: {
			type: "string",
			minLength: 9,
			pattern: "^You are \\S",
			description: FORK_PROFESSION_DESCRIPTION,
		},
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

const scopePath = {
	type: "string",
	minLength: 1,
	pattern: "\\S",
};

// `scope_send` addresses a scope instead of creating one: a path, a relative
// step, or a wildcard, and the message body. `budget` is the one optional
// field, because financing a scope that ran out is the same arithmetic as a
// fork's budget.
export const sendParameters = {
	type: "object",
	additionalProperties: false,
	required: ["target", "message"],
	properties: {
		target: {
			anyOf: [
				scopePath,
				{ type: "array", minItems: 1, items: scopePath },
			],
			description: SEND_TARGET_DESCRIPTION,
		},
		message: {
			type: "string",
			minLength: 1,
			pattern: "\\S",
			description: SEND_MESSAGE_DESCRIPTION,
		},
		budget: {
			type: "object",
			additionalProperties: { type: "integer", minimum: 0 },
			description: SEND_BUDGET_DESCRIPTION,
		},
	},
};

export const joinParameters = {
	type: "object",
	additionalProperties: false,
	properties: {},
};

// `dafny` is required: a return without it is an incomplete handoff, because
// tool results are dropped from the formatted record, so this field is the
// only path those facts have to the next generation or the calling scope.
// Omitting the oath performs a small rewind handoff to a fresh self; supplying
// the exact oath value seals a final delivery (or, at Root, advances the
// two-oath review chain).
export const returnParameters = {
	type: "object",
	additionalProperties: false,
	required: ["dafny"],
	properties: {
		dafny: { type: "string", pattern: "\\S", description: RETURN_DAFNY_DESCRIPTION },
		[RETURN_OATH_KEY]: {
			type: "string",
			enum: [RETURN_OATH_VALUE],
			description: RETURN_OATH_DESCRIPTION,
		},
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


