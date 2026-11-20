/**
 * Model-facing tool contracts. The prose lives in resources/prompts/tools/;
 * this module only wires it into JSON schemas.
 */

import { WORKFLOW_STAGES } from "../scope/stages.mjs";
import { loadDoc } from "../prompts/index.mjs";

const scope = loadDoc("tools/scope");

export const SCOPE_DESCRIPTION = scope.tool;
export const BEGIN_INTENT_DESCRIPTION = scope["begin.intent"];
export const BUDGET_DESCRIPTION = scope["begin.budget"];
export const PERMISSION_DESCRIPTION = scope["begin.permission"];
export const END_DESCRIPTION = scope.end;
export const ELDER_REPORT_DESCRIPTION = scope["begin.elder_report"];
export const AMEND_DESCRIPTION = scope["amend.tool"];
export const REFLECTION_DESCRIPTION = scope["amend.reflection"];
export const DEFER_DESCRIPTION = scope["defer.tool"];
export const DEFER_INTENT_DESCRIPTION = scope["defer.intent"];
export const PIN_DESCRIPTION = scope["pin.tool"];
export const PIN_ASSUMPTION_DESCRIPTION = scope["pin.assumption"];
export const PIN_DEDUCTION_DESCRIPTION = scope["pin.deduction"];
export const PIN_INDUCTION_DESCRIPTION = scope["pin.induction"];
export const PIN_FINDING_DESCRIPTION = scope["pin.finding"];
export const PIN_CONCLUSION_DESCRIPTION = scope["pin.conclusion"];

export const scopeParameters = {
	type: "object",
	additionalProperties: false,
	properties: {
		begin: {
			type: "object",
			additionalProperties: false,
			required: ["intent", "stage", "budget", "elder_report", "permission", "time"],
			properties: {
				time: {
					type: "number",
					minimum: 0,
					description: scope["begin.time"],
				},
				intent: { type: "string", minLength: 1, description: BEGIN_INTENT_DESCRIPTION },
				stage: {
					type: "string",
					enum: [...WORKFLOW_STAGES],
					description: scope["begin.stage"],
				},
				budget: {
					type: "object",
					additionalProperties: { type: "integer", minimum: 0 },
					description: BUDGET_DESCRIPTION,
				},
				elder_report: {
					anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
					description: ELDER_REPORT_DESCRIPTION,
				},
				permission: {
					type: "string",
					enum: ["ro", "rw"],
					description: PERMISSION_DESCRIPTION,
				},
				model: {
					anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
					description: scope["begin.model"],
				},
			},
			description: scope.begin,
		},
		end: {
			type: "boolean",
			enum: [true],
			description: END_DESCRIPTION,
		},
	},
};

export const amendParameters = {
	type: "object",
	additionalProperties: false,
	required: ["reflection"],
	properties: {
		reflection: { type: "string", minLength: 1, description: REFLECTION_DESCRIPTION },
	},
};

export const deferParameters = {
	type: "object",
	additionalProperties: false,
	required: ["intent"],
	properties: {
		intent: { type: "string", minLength: 1, description: DEFER_INTENT_DESCRIPTION },
	},
};

export const pinParameters = {
	type: "object",
	additionalProperties: false,
	properties: {
		assumption: { type: "string", description: PIN_ASSUMPTION_DESCRIPTION },
		deduction: { type: "string", description: PIN_DEDUCTION_DESCRIPTION },
		induction: { type: "string", description: PIN_INDUCTION_DESCRIPTION },
		finding: { type: "string", description: PIN_FINDING_DESCRIPTION },
		conclusion: { type: "string", description: PIN_CONCLUSION_DESCRIPTION },
	},
};
