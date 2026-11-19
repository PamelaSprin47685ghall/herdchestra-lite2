// The todo tool contract: description, parameter text, and JSON schema.

export const TODO_DESCRIPTION = `Record the ledger of remaining work. todo is free and is the only functional tool that may be called when all scopes are closed. It is forbidden inside any active scope at any level: close every scope first. The ledger is canonical: it is what the next relay holder reads before deciding whether work remains.

Operations: init replaces and submits the whole ledger; view is a read-only check that does NOT advance the relay evaluation and does not change the ledger; list: [] is an empty ledger. A non-empty ledger forbids a natural stop. An empty ledger does not allow a stop either: it triggers a relay handoff where you must stop calling tools and immediately write the handoff report in your message body, after which a compaction boundary is placed and the successor takes over. Only the successor's first submitted write-operation evaluation being empty (a promotion) allows a natural stop. The successor may open any number of scopes to investigate first; todo need not be the successor's first tool call. If the successor's first submitted evaluation is non-empty, it enters rework and is not the last holder: even if it later empties the ledger, it must reach another handoff to the next successor.

Write every item so the next agent can understand the work: the user requirement, acceptance evidence, unresolved risks, and the next concrete action. Summarize requirements without omitting or narrowing them; you do not need to quote them. The tool result appends RELAY STATE: the current generation, this generation's first evaluation, whether the ledger is empty, whether stopping is allowed, and the next required action.`;

export const TODO_OP_DESCRIPTION =
	"One incremental todo operation. Omit it and the native tool infers the operation from the other fields. init replaces and submits the entire ledger from list (list: [] submits an empty ledger). start moves an existing task to in_progress. done completes it. rm removes it. drop abandons it. block marks it blocked, with reason as the blocker note. unblock returns it to pending. append adds items to a phase. view is a read-only check: it does NOT advance the relay evaluation and does not change the ledger. To submit a ledger, use a write operation, most explicitly init with the full list. A failed call never advances the relay state.";

export const TODO_LIST_DESCRIPTION =
	"Full ledger replacement for op: init. Each entry is { phase, items }, where phase names the phase and items is an array of task strings. The list replaces every existing phase; an empty array is an empty ledger, which triggers the relay handoff protocol rather than allowing a stop.";

export const TODO_TASK_DESCRIPTION =
	"The existing task's verbatim content, used by start, done, rm, drop, block, and unblock. Copy it exactly from the ledger.";

export const TODO_PHASE_DESCRIPTION =
	"The phase name. Used by append and by the init list entries. Phase names are the lookup key for later operations.";

export const TODO_ITEMS_DESCRIPTION =
	"Task strings for op: append. Each string becomes a pending task in the named phase.";

export const TODO_REASON_DESCRIPTION =
	"When op is block, a short note on what the task is waiting for. Optional otherwise.";

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
						description: "Task strings for this phase.",
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
