## tool

In a fission flow, call scope({ end: true }) when the work is complete. Do not call todo. You may instead open a nested batch with scope({ begin: { stage, elder_report, fission: [...] } }); this retires the current flow and delegates its completion to the nested batch.

Scope is the only way to run functional tools. Every scope opens as a fission batch of one or more concurrent flows:
`scope({ begin: { stage, elder_report, time, fission: [{ intent, budget, permission, model? }] } })`
There is no single-flow begin shape (one flow is a one-item array). Flows in a batch share the current conversation prefix, run in parallel with independent budgets and optional per-flow models, and merge in completion order into a surviving flow until the last flow hands control back.

Execution barrier:
- Calls listed before `scope` in the same assistant message run first in the outer context (put `todo` before `scope({ begin })` or after the final `scope({ end: true })`).
- Calls listed after `scope({ begin })` in the same assistant message execute once after the batch registers and their results are copied to every flow in the batch—use this to fetch shared context once without spending an extra turn.
- Do not combine `end: true` with `begin`, and do not open and close the same scope in one message.

Inside a flow:
- Your initial scope is already open. Call `scope({ end: true })` when complete or permanently blocked, or open a nested fission batch to delegate completion.
- Available options while working: `amend` the previous beat to keep context clean and refund budget; open a nested fission batch for independent sub-slices; `pin` durable artifacts and conclusions; dispatch `task` subagents when zero shared history is better.
- `todo` is forbidden inside any scope.

Workbench and folding:
- The newest closed scope at a level stays verbatim as the hot workbench until a later sibling archives it via `begin.elder_report`. Older archived elders behind the workbench are batch-folded automatically when cache economics or context watermarks (82% / 90%) warrant it; a last child with no `elder_report` is sealed without a report and is never folded on its own (it disappears when its enclosing scope folds).

The innermost scope determines the current stage; outside all scopes there is no stage. Only the user toggles herd mode with /herd; while it is on, only decision-framing opens and `ask` is allowed there. `wait` is valid only inside a scope. `todo` is the only functional tool outside all scopes and is forbidden inside every scope. Per-turn sharing, free tools, unlisted tools, nesting, and permission refusals are defined once in `fission.budget` and `fission.permission`; do not restate them here.

Plan budget use with each tool's own guidance: `amend` retracts the last beat, a nested scope carries its own budget, and `task` covers independent slices. Close with scope({ end: true }) when the task is complete or permanently blocked.

Call scope({ end: true }) only when the current task is complete or permanently blocked. Closing writes no report and asks for no summary. The most recently closed scope at a level stays fully visible as the hot workbench. When you later open another sibling scope at that level, pass the prior scope's summary in begin.elder_report: a non-empty string to archive it, or null when no elder is pending. A closed scope whose elder_report is never written is sealed without a report; its deletable interior may be folded once economics or the watermark allows. Write the user-facing answer as ordinary assistant text only when you are outside all scopes. Inside any scope, keep working or close the scope with scope({ end: true }); do not present the final user-facing conclusion.

When a scope closes, its elder at the same level remains the hot workbench until a new sibling archives it with elder_report. Once archived, older elders strictly behind the hot workbench become foldable; a batch fold collapses them in one branch operation and keeps the hot workbench and any pinned receipts intact. Collapse is local to one sibling chain, not global close order. A parent closing seals its youngest unarchived child and subsumes its still-unfolded descendants.

Scope is an execution barrier in a batch: calls listed before it finish first, and calls listed after it wait for it. Put todo before a scope opening or after the final scope closes.

Provide begin or end: true. A begin requires stage, elder_report, and fission; there is no single-flow begin shape, so one flow is a one-item fission array. A fission item's model optionally names that flow's model spec (provider/id, alias, role, or a :off/:minimal/:low/:medium/:high/:xhigh thinking suffix), or null to inherit the model of the scope that opens the batch; the host performs the real model switch and restores the previous model when the scope closes. A fission begin currently cannot also close a scope: end: true with begin is refused before any state change, so close the open scope with a plain end: true call, then open the batch in a following call. end: true outside a scope is rejected. Do not open a fresh scope and close it in the same assistant message; begin a scope in one message, do the work in later messages, then end it.

## begin

Open a new innermost scope with a batch of one or more flows. A begin requires stage, elder_report, time, and fission: stage is one workflow stage shared by the whole batch, elder_report follows the rule below, time is the required wall-clock budget in seconds, and fission is a non-empty array of flows. Each fission item carries its own intent, budget, permission, and optional model; the array's length is the flow count, with no batch threshold. A one-item array runs one flow and degrades naturally. In the full flow, rw requires the first submitted todo ledger; in simple mode it is allowed. For a heavy task, also budget task so parallel subagent workers can take independent slices.

## begin.stage

Required workflow stage for this scope. One stage covers the whole batch; a fission item does not name its own. In the full flow, "direct-execution" also requires one run of each earlier stage; in simple mode it opens directly.

## begin.fission

Required array with at least one item. Every item opens one flow at once, and the entire array must be valid before any flow starts: one invalid item rejects the whole batch and leaves no partially opened scope. There is no single-flow begin shape; to open one flow, pass a one-item array. Within the Mythical Man-Month limit — no shared mutable state, no superlinear coordination cost — push concurrency as high as the independent work allows: unrelated closures that share no symbol, file, or ordering belong to the same array and advance at the same time, each closing its own goal inside its own flow. Balance the expected workload across tracks so no single heavy flow becomes a straggler, and choose scope sizes that fit the work instead of splitting it merely to raise the flow count.

## fission.intent

A task of one flow: one unit of work that closes on itself, plus the evidence that proves it closed. Every scope reaches a semantic closure, not a waypoint on the road to one. The test is what the next scope may assume: after this one closes, its goal is done and reviewable, not "understood and still pending". A scope that can only report what it read, found, or gathered has not closed; it has moved a closure that belongs elsewhere one scope later, and that is the defect this rule exists to prevent. A read-only scope closes the same way, by answering its question or pinning its finding so no later scope repeats the investigation.

Size the closure to one bounded stretch, because a closure that cannot finish inside the scope is not a closure. A closure is an outcome, not an action: writing into a file is not one, while a complete repair confined to one file is. When the request is itself one closure, one scope completes it. When the request holds several closures, open one flow for each — in the same batch when they are independent, so the extra begins cost no concurrency. Never split one closure across scopes to keep each scope small, and never pack several closures into one scope to save a begin: the first leaves every scope half-finished, the second hides a failure until the end.

As a rough guide, if the whole user request seems to need about n tool calls, one closure covers roughly sqrt(n) of them. The guide never overrides the rule that each scope closes its goal. Describe the closure and its proof in one to three sentences.

## fission.budget

Map each tool name to an integer budget of assistant turns for this flow. One assistant message spends at most one unit in total: that unit is split across budgeted calls in proportion to their call counts, rounded to two decimals. Several read calls issued together consume one read share once, while a read in a later message consumes another share. Use actual tool names (bash, read, write, edit, glob, grep, lsp, task, web_search, debug, eval, etc.), not semantic descriptions. Example: {"bash": 6, "read": 7, "edit": 4}. Size each number by the number of turns you expect to use that tool in, not by individual calls. For a heavy task, also budget task: parallel subagent workers take independent slices at once, and one batch of task calls costs one task unit. Each flow's budget is charged separately, and scopes nested inside that flow draw from its remaining balance. Do not budget scope, amend, defer, pin, todo, ask, or wait. A budget can be empty if only free tools are needed. An unlisted budgeted tool has zero budget. Values must be non-negative integers; the accounting splits them into two-decimal shares, and a tool whose balance is below its share is blocked while the rest of the message still runs.

## begin.time

Wall-clock budget in seconds for this scope. Required: a positive number, never omitted. Every tool is capped at remaining normal time plus one second, so the hard limit is exactly the deadline plus 1s. When the deadline passes the scope enters chess-clock phase: each later tool gets 1 second, a tool that runs past its cap is killed, and its result is replaced by a scolding.

Derive the number from measured throughput, not from optimism. Every turn's receipt reports the current UTC time and the time elapsed since this session began. Compare that clock against the work already finished in this session: if T minutes produced W units of finished work (files read, edits applied, checks run), a task shaped like this one costs roughly T × (this task's units / W). Round to the nearest honest figure, count one beat for the verification you will still have to run, and pad nothing beyond it. Set each tool's own timeout with the same arithmetic, and never plan on a tool finishing after the deadline.

The aim is to spend the budget exactly. Closing on the last second is the honorable outcome; an overrun means the work was slower than you claimed; a budget left half unspent was inflated, and an inflated budget is not caution but a failure of self-knowledge. Finish the moment the work is done: never stretch a scope to even out the estimate, and never spend leftover time merely to make the number look right — padding for the clock is the same dishonesty as padding the budget. Treat the estimate as a guess with wide error bars and revise it as the session proceeds; the clock line exists to be used, not admired.

## begin.elder_report

The summary of the previous scope at this level. Record its outcomes and remaining work; do not repeat user messages, which folding keeps before the scope's begin call. Pass a non-empty string only when an unarchived elder scope is pending at this level: the tail instruction names it and its intent. That summary archives the elder, turning it from pending into the hot workbench so older folded elders become eligible for batching. Pass null when no elder is pending, when the previous scope is not visible on the branch, or when this is the first scope at the level. This is a handoff receipt, not the user-facing answer.

## fission.permission

Declare this flow's write intent. It is required on every fission item and must be "ro" or "rw": an item that omits it, passes null, or names another value rejects the whole batch. "ro" is a declaration, not an enforcement boundary: the flow is trusted, and no tool is blocked because it said "ro". "rw" is refused in stage "decision-framing", and in the full flow while this generation has not submitted its first todo ledger (a todo view does not count); submit the ledger first, or choose a later stage. In simple mode "rw" is allowed.

## fission.model

Optional model spec for this flow: provider/id, settings alias or role, or a model with an off/minimal/low/medium/high/xhigh thinking suffix. null inherits the model of the scope that opens the batch. The host performs the real model switch and restores the previous model when the scope closes.

## end

Close the current scope by passing true. No report is written at close time and no summary is required. The closed scope stays visible as the hot workbench at its level. If you later open another sibling scope at that level, pass this scope's summary in that begin's elder_report; if you leave the level or finish the task instead, write no summary at all.

## amend.tool

Amend the record: replace the most recent completed beat inside the current scope with the text you pass as reflection. It is one move — amend rides in the same message as your next tool calls, so it needs no extra turn and costs no budget of its own. A beat is one assistant message (thinking and output) together with its tool calls and their results. On the next LLM request, that beat no longer appears, your reflection text stands in its place, and the budget spent by its tool calls is refunded to the current scope. Every amend in a beat is processed before any normal tool in that beat, so a refund can fund a call in that same message. Multiple amend calls in the same beat replace several earlier beats, one per call.

Amend edits the record, not the world: file edits and commands that already ran stay exactly as they are. What goes away is the reasoning and tool traffic that led there, so the next request starts from the state before that beat, read together with your replacement text.

Reach for it whenever the last beat was merely not good, not only when it was clearly wrong: a wrong turn of direction, files you read but did not need, a half-written change you already replaced, the wrong tool or the wrong grain of work, a conclusion that new evidence overturned. Amend that beat and continue with a clean context instead of paying for it again in every later request.

Rules: only inside a scope; the target must come after the current scope's begin; a beat containing a scope call cannot be amended away; a beat paid by an outer scope cannot be amended; a closed nested scope is a boundary, so do not amend across it. Defer calls in the amended beat are withdrawn from the pending list, but their text remains valid and is still delivered when the scope ends.

Reflection is required, is the only cost, and is the replacement itself: it is the text the record keeps where the beat used to be. Say what you were attempting, why that attempt did not fit the task, and what the next attempt must do instead. Use amend often, and use it early: one honest sentence buys a clean history and returns the budget, so there is no reason to carry a beat that no longer earns its place. Do not use amend to hide evidence or to skip the difficult part of the work; use it to replace work that was wrong, not work that was hard.

## amend.reflection

The text that replaces the beat: what you were attempting, why it did not fit the task, and what the next attempt must do instead. Must not be empty.

## pin.tool

Record a durable reasoning note. pin costs no budget, has no call limit, and always returns OK; call it inside or outside a scope. Every field is optional Markdown. Pins survive scope collapse and all historical pins are passed to the successor at relay handoff. After saving a stage artifact, pin its path and key conclusions. Use pin for durable assumptions, deductions, inductions, findings, and conclusions.

## pin.assumption

A premise or assumption, in Markdown. Optional.

## pin.deduction

A deductive step or consequence drawn from the premises, in Markdown. Optional.

## pin.induction

An inductive generalization from observations, in Markdown. Optional.

## pin.finding

A concrete observation or piece of evidence, in Markdown. Optional.

## pin.conclusion

The current conclusion, in Markdown. Optional.
