/**
 * Model-facing tool contracts. Every rule of the scope mechanism lives here,
 * not in the system prompt.
 */

export const SCOPE_DESCRIPTION = `Scope is the only way to use tools in this session. It opens or closes a budgeted unit of work for one task of moderate scope. As a rough heuristic for thinking about how much work one block should hold, if the whole user request seems to need about n tool calls, one moderate scope covers roughly sqrt(n) of them. Use this only while deciding the scope's grain before work begins. It is not a formula for the tool call count: once the actual work of a task is clear, budget the calls that work really needs instead of deriving a number from sqrt(n). Split the request into scopes of roughly that size instead of one giant scope or a scope per call.

A moderate scope names an outcome and the evidence that proves it. Its budget should cover the calls the work really needs; sqrt(n) only helps judge how large a block should be when you first plan the split, not how many calls the finished task must take. Aim for each scope to make a concrete contribution to the user's goal, such as a usable change or a completed deliverable; combine necessary investigation with action when practical instead of routinely spending whole scopes on research alone. Research-only scopes remain appropriate when investigation is itself the requested deliverable or is necessary before safe, informed action. For a heavy task, also budget task: parallel subagent workers take independent slices at once, and one batch of task calls costs one task unit. A scope is neither a single operation nor the whole user goal.

Call scope({ begin: { intent, budget } }) before using any other functional tool. todo is the only functional tool allowed outside all scopes; it is free and is forbidden inside every scope. Every tool call other than todo and the control tools must happen inside a scope. A batch of same-tool calls in one assistant message uses one unit of that tool's budget; different tools use their own units. scope, regret, defer, pin, and todo are free. A tool not listed in the budget has zero budget. Scopes nest, and only the innermost scope's budget is used.

Budget by batches, not individual calls. Several calls to the same tool in one assistant message are one simultaneous batch and consume one unit of that tool's budget. Two read calls in one assistant message cost 1 read unit; a third read in a later assistant message costs another read unit. Different tools in the same message each cost their own unit. Plan the budget around the number of same-tool batches you expect, and spend it with the same rule in mind.

Plan budget use ahead: estimate the tools the actual work needs for the outcome and its verification, and monitor the remaining budget as work progresses. Anticipate shortfalls and organize work early rather than waiting for the budget to be exhausted. Consider these options: (1) If the last eligible beat was clearly wrong, use regret to correct course and refund that beat's tool budget; do not undo useful work merely to recover budget. (2) If there is a coherent, independent unit of work, begin a sub-scope with its own budget; its calls use that budget, not the outer scope's. (3) For a relevant side finding that should be handled later, use defer to record actionable work; it will be delivered when this scope ends. (4) For a heavy task, budget task as well: parallel subagent workers take independent slices at once, so one task batch can replace many serial exploratory calls. Otherwise, when the current task is complete or permanently blocked, close the scope.

Call scope({ end: { return_markdown } }) only when the current task is complete or permanently blocked. return_markdown is your report to your future self: it replaces this scope's begin receipt when the scope is collapsed, and records what was accomplished, the evidence that proves it, what remains unfinished, and the lesson learned. It is not the user-facing deliverable. Write the user-facing answer as ordinary assistant text, and only when you are outside all scopes. Inside any scope, keep working or close the scope; do not present the final user-facing conclusion.

When a scope closes, its immediately elder sibling at the same level is collapsed: that sibling's begin receipt becomes its return_markdown and its interior is removed. The scope that just closed stays fully visible until a younger sibling closes. Collapse is local to one sibling chain, not global close order. A parent closing does not collapse its children; an enclosing scope's later collapse will remove their receipts. Put durable child results in the enclosing scope's return_markdown.

Provide begin, end, or both. With both, end the current scope first, then begin the new scope in the same call. end outside a scope is rejected, including when begin is also supplied. A particular scope cannot begin and end in the same assistant message: begin it in one message, do the work in later messages, then end it.`;

export const BEGIN_INTENT_DESCRIPTION =
	"A task of moderate scope: one outcome that can be completed and reviewed in a bounded stretch, plus the evidence that proves completion. As a heuristic for how much work one scope should hold, if the whole user request seems to need about n tool calls, a moderate scope covers roughly sqrt(n) of them; this is not a target for the call count and does not decide how many calls the task actually takes. Name the outcome and its proof, not a single file operation and not the whole user request. One to three sentences.";

export const BUDGET_DESCRIPTION =
	'Map each tool name to the maximum number of batches allowed in this scope. A batch is all calls to one tool in the same assistant message: several read calls issued together consume one read unit, while a read in a later message consumes another. Use actual tool names (bash, read, write, edit, glob, grep, lsp, task, wait, web_search, ask, debug, eval, etc.), not semantic descriptions. Example: {"bash": 6, "read": 7, "edit": 4}. Size each number by the batches the work actually needs, not by individual calls. For a heavy task, also budget task: parallel subagent workers take independent slices at once, and one batch of task calls costs one task unit. A tool not listed has zero budget. Only the innermost scope\'s budget is used. scope, regret, defer, and pin are never budgeted. todo is free, is only callable outside all scopes, and must not be given a budget. Values must be non-negative integers; an integer budget is a number of batches, not a promise that every call in a batch is independently charged.';

export const END_REPORT_DESCRIPTION =
	"Close the current scope. return_markdown is the report you leave for your future self: it replaces this scope's begin receipt when the scope is collapsed as an elder sibling, and records what was accomplished, the evidence that proves it, what remains unfinished, and the lesson learned. It is not the user-facing answer. Write the user-facing deliverable as ordinary assistant text only when you are outside all scopes. A parent close does not collapse its children; an enclosing scope's later collapse removes their receipts, so summarize durable child results here.";

export const RETURN_MARKDOWN_DESCRIPTION =
	"The report you leave for your future self, not the user-facing deliverable. It replaces this scope's begin receipt when the scope is collapsed as an elder sibling, so later scopes can recover what happened, what proved it, what remains, and the lesson. A nested scope's report survives only until an enclosing scope collapses; put durable child results in the enclosing scope's report. The user reads your ordinary assistant text, written only outside all scopes.";

export const REGRET_DESCRIPTION = `Undo the most recent completed beat inside the current scope. A beat is one assistant message (thinking and output) together with its tool calls and their results. On the next LLM request, that beat disappears completely, and the budget spent by its tool calls is refunded to the current scope. Several calls to the same tool in one assistant message are one batch: they consumed one unit, so undoing their beat refunds one unit. Multiple regret calls in the same beat undo several earlier beats, one per call. All regret calls in a beat are processed before any normal tool in that beat, so a refund can fund a later call.

Rules: only inside a scope; the target must come after the current scope's begin; a beat containing a scope call cannot be undone; a beat paid by an outer scope cannot be undone; a closed nested scope is a boundary, so do not regret across it. Defer calls in the undone beat are withdrawn from the pending list, but their text remains valid and is still delivered when the scope ends.

Use reflection to record the lesson: what failed, why it failed, and what the next attempt must do differently. Use regret when the previous attempt is clearly wrong and continuing would compound the error. Do not use it to hide evidence or avoid difficult work.`;

export const REFLECTION_DESCRIPTION =
	"A detailed lesson: what failed, why it failed, and what the next attempt must do differently. Must not be empty.";

export const DEFER_DESCRIPTION = `Record a finding that should be handled later without spending budget now. Only inside a scope. Returns OK immediately and costs no budget. When the current scope ends, every finding deferred in that scope is delivered as one steering user message, so you can request a new scope with enough budget to address it. A nested scope's findings are delivered when that scope ends, even if its enclosing scope is still active; treat them as work inside the enclosing scope. Use defer for real budget triage: something important you discovered, but not worth the remaining calls in this scope. Do not use it to avoid required work.`;

export const DEFER_INTENT_DESCRIPTION =
	"What must be done later and why it matters. Must be specific, actionable, and non-empty.";

export const PIN_DESCRIPTION = `Record a durable reasoning note in the transcript. pin costs no budget, has no call limit, and always returns OK; call it inside or outside a scope. Every field is optional Markdown. Pin records survive scope collapse: when a scope is collapsed, its pin calls and results move after the collapsed scope and stay in the conversation, so later work can recover the observation, the reasoning, and the conclusion that would otherwise disappear with the scope interior. Use pin for durable assumptions, deductions, inductions, findings, and conclusions; use defer for work that must be done later.`;

export const PIN_ASSUMPTION_DESCRIPTION =
	"A premise or assumption, in Markdown. Optional.";

export const PIN_DEDUCTION_DESCRIPTION =
	"A deductive step or consequence drawn from the premises, in Markdown. Optional.";

export const PIN_INDUCTION_DESCRIPTION =
	"An inductive generalization from observations, in Markdown. Optional.";

export const PIN_FINDING_DESCRIPTION =
	"A concrete observation or piece of evidence, in Markdown. Optional.";

export const PIN_CONCLUSION_DESCRIPTION =
	"The current conclusion, in Markdown. Optional.";

export const scopeParameters = {
	type: "object",
	additionalProperties: false,
	properties: {
		begin: {
			type: "object",
			additionalProperties: false,
			required: ["intent", "budget"],
			properties: {
				intent: { type: "string", minLength: 1, description: BEGIN_INTENT_DESCRIPTION },
				budget: {
					type: "object",
					minProperties: 1,
					additionalProperties: { type: "integer", minimum: 0 },
					description: BUDGET_DESCRIPTION,
				},
			},
			description:
				"Open a new innermost scope with a task of moderate scope (use sqrt(n), where n is the estimated tool call count for the whole request, only as a heuristic for how much work one scope should hold, never as the required number of calls) and a per-tool batch budget. For a heavy task, budget task too so parallel subagent workers can take independent slices.",
		},
		end: {
			type: "object",
			additionalProperties: false,
			required: ["return_markdown"],
			properties: {
				return_markdown: {
					type: "string",
					minLength: 1,
					description: RETURN_MARKDOWN_DESCRIPTION,
				},
			},
			description: END_REPORT_DESCRIPTION,
		},
	},
};

export const regretParameters = {
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
