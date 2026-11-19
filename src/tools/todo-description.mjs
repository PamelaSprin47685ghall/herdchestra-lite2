// The todo tool contract: prose from resources/prompts/tools/todo.md.

import { loadDoc } from "../prompts/index.mjs";

const todo = loadDoc("tools/todo");

export const TODO_DESCRIPTION = todo.tool;
export const TODO_OP_DESCRIPTION = todo.op;
export const TODO_LIST_DESCRIPTION = todo.list;
export const TODO_TASK_DESCRIPTION = todo.task;
export const TODO_PHASE_DESCRIPTION = todo.phase;
export const TODO_ITEMS_DESCRIPTION = todo.items;
export const TODO_REASON_DESCRIPTION = todo.reason;

export const TODO_PARAMETERS = {
	type: "object",
	additionalProperties: true,
	properties: {
		op: {
			type: "string",
			enum: [
				"init",
				"start",
				"done",
				"rm",
				"drop",
				"block",
				"unblock",
				"append",
				"view",
			],
			description: TODO_OP_DESCRIPTION,
		},
		list: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: true,
				properties: {
					phase: { type: "string", description: TODO_PHASE_DESCRIPTION },
					items: {
						type: "array",
						items: { type: "string" },
						description: todo["list.item"],
					},
				},
			},
			description: TODO_LIST_DESCRIPTION,
		},
		task: { type: "string", description: TODO_TASK_DESCRIPTION },
		phase: { type: "string", description: TODO_PHASE_DESCRIPTION },
		items: {
			type: "array",
			items: { type: "string" },
			description: TODO_ITEMS_DESCRIPTION,
		},
		reason: { type: "string", description: TODO_REASON_DESCRIPTION },
	},
};
