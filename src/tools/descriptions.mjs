/**
 * Model-facing tool contracts. The prose lives in resources/prompts/tools/;
 * this module only wires it into JSON schemas.
 */

import { WORKFLOW_STAGES } from "../scope/stages.mjs";
import { loadDoc } from "../prompts/index.mjs";

const scope = loadDoc("tools/scope");

export const SCOPE_DESCRIPTION = scope.tool;
// The intent, budget, permission, and model texts describe one fission item.
export const BEGIN_INTENT_DESCRIPTION = scope["fission.intent"];
export const BUDGET_DESCRIPTION = scope["fission.budget"];
export const PERMISSION_DESCRIPTION = scope["fission.permission"];
export const FISSION_DESCRIPTION = scope["begin.fission"];
export const MODEL_DESCRIPTION = scope["fission.model"];
export const END_DESCRIPTION = scope.end;
export const ELDER_REPORT_DESCRIPTION = scope["begin.elder_report"];
export const AMEND_DESCRIPTION = scope["amend.tool"];
export const REFLECTION_DESCRIPTION = scope["amend.reflection"];
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
			required: ["stage", "elder_report", "fission", "time"],
			properties: {
				time: {
					type: "number",
					minimum: 0,
					description: scope["begin.time"],
				},
				stage: {
					type: "string",
					enum: [...WORKFLOW_STAGES],
					description: scope["begin.stage"],
				},
				elder_report: {
					anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
					description: ELDER_REPORT_DESCRIPTION,
				},
				fission: {
					type: "array",
					minItems: 1,
					description: FISSION_DESCRIPTION,
					items: {
						type: "object",
						additionalProperties: false,
						required: ["intent", "budget", "permission"],
						properties: {
							intent: { type: "string", minLength: 1, description: BEGIN_INTENT_DESCRIPTION },
							budget: { type: "object", additionalProperties: { type: "integer", minimum: 0 }, description: BUDGET_DESCRIPTION },
							permission: { type: "string", enum: ["ro", "rw"], description: PERMISSION_DESCRIPTION },
							model: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }], description: MODEL_DESCRIPTION },
						},
					},
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
