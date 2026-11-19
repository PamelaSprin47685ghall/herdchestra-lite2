## tool

Scope is the only way to use tools in this session. It opens or closes a budgeted unit of work for one task of moderate scope. As a rough heuristic for thinking about how much work one block should hold, if the whole user request seems to need about n tool calls, one moderate scope covers roughly sqrt(n) of them. Use this only while deciding the scope's grain before work begins. It is not a formula for the tool call count: once the actual work of a task is clear, budget the calls that work really needs instead of deriving a number from sqrt(n). Split the request into scopes of roughly that size instead of one giant scope or a scope per call.

A moderate scope names an outcome and the evidence that proves it. Its budget should cover the calls the work really needs; sqrt(n) only helps judge how large a block should be when you first plan the split, not how many calls the finished task must take. Aim for each scope to make a concrete contribution to the user's goal, such as a usable change or a completed deliverable; combine necessary investigation with action when practical instead of routinely spending whole scopes on research alone. Research-only scopes remain appropriate when investigation is itself the requested deliverable or is necessary before safe, informed action. For a heavy task, also budget task: parallel subagent workers take independent slices at once, and one batch of task calls costs one task unit. A scope is neither a single operation nor the whole user goal.

Call scope({ begin: { intent, stage, budget, elder_report, permission } }) before using any other functional tool. The innermost scope determines the current stage; outside all scopes there is no stage. Only the user can toggle herd mode with /herd. In herd mode, only decision-framing can open. Otherwise, acceptance-cases, architecture-design, orchestration-plan, and direct-execution can open in any order. ask is allowed only in a decision-framing scope with herd mode on. wait is allowed only inside a scope. todo is the only functional tool allowed outside all scopes; it is forbidden inside every scope. One assistant message spends at most one unit in total, split across budgeted calls in proportion to their call counts and rounded to two decimals. scope, amend, defer, pin, todo, ask, and wait are free and take no share. Any other tool not listed in the budget has zero budget. Scopes nest, and only the innermost scope's budget is used. begin.permission is "ro" or "rw": "ro" is trusted and never enforced; "rw" is refused in decision-framing and until this generation submits its first todo ledger.

Budget by assistant turns, not individual calls. One assistant message spends at most one unit in total, however many tools and calls it makes; that unit is split across the tools in proportion to their call counts and rounded to two decimals. Two read calls in one message cost one read unit; a read and a bash in one message cost about half a read unit and half a bash unit. When a tool's balance is smaller than its share, that tool alone is blocked and the rest of the message still runs. Plan integer budgets around the number of turns you expect to use each tool in.

Plan budget use ahead: estimate the tools the actual work needs for the outcome and its verification, and monitor the remaining budget as work progresses. Anticipate shortfalls and organize work early rather than waiting for the budget to be exhausted. Consider these options: (1) If the last beat was not good enough (wrong direction, wasted calls, work a later beat already replaced), amend it in the same message as your next tool calls: no extra turn, no budget of its own, and the beat leaves the context. Do not undo useful work merely to recover budget. (2) If there is a coherent, independent unit of work, begin a sub-scope with its own budget; its calls use that budget, not the outer scope's. (3) For a relevant side finding that should be handled later, use defer to record actionable work; it will be delivered when this scope ends. (4) For a heavy task, budget task as well: parallel subagent workers take independent slices at once, so one task batch can replace many serial exploratory calls. Otherwise, when the current task is complete or permanently blocked, close the scope with scope({ end: true }).

Call scope({ end: true }) only when the current task is complete or permanently blocked. Closing writes no report and asks for no summary. The most recently closed scope at a level stays fully visible as the hot workbench. When you later open another sibling scope at that level, pass the prior scope's summary in begin.elder_report: a non-empty string to archive it, or null when no elder is pending. A closed scope whose elder_report is never written is sealed without a report; its deletable interior may be folded once economics or the watermark allows. Write the user-facing answer as ordinary assistant text only when you are outside all scopes. Inside any scope, keep working or close the scope with scope({ end: true }); do not present the final user-facing conclusion.

When a scope closes, its elder at the same level remains the hot workbench until a new sibling archives it with elder_report. Once archived, older elders strictly behind the hot workbench become foldable; a batch fold collapses them in one branch operation and keeps the hot workbench and any pinned receipts intact. Collapse is local to one sibling chain, not global close order. A parent closing seals its youngest unarchived child and subsumes its still-unfolded descendants.

Scope is an execution barrier in a batch: calls listed before it finish first, and calls listed after it wait for it. Put todo before a scope opening or after the final scope closes.

Provide begin, end: true, or both. begin.model optionally names a model spec for the new scope (provider/id, alias, role, or a :off/:minimal/:low/:medium/:high/:xhigh thinking suffix); the host performs the real model switch and restores the previous model when the scope closes. With both, close the current scope first, archive it with begin.elder_report, then open the new scope in the same call. end: true outside a scope is rejected, including when begin is also supplied. Do not open a fresh scope and close it in the same assistant message; begin a scope in one message, do the work in later messages, then end it.

## begin

Open a new innermost scope with a task of moderate scope (use sqrt(n), where n is the estimated tool call count for the whole request, only as a heuristic for how much work one scope should hold, never as the required number of calls) and a per-tool integer budget of assistant turns. permission declares ro|rw; rw is refused until this generation submits its first todo ledger. elder_report archives the previous scope at this level: a non-empty summary when one is pending, otherwise null. For a heavy task, budget task too so parallel subagent workers can take independent slices.

## begin.intent

A task of moderate scope: one outcome that can be completed and reviewed in a bounded stretch, plus the evidence that proves completion. As a heuristic for how much work one scope should hold, if the whole user request seems to need about n tool calls, a moderate scope covers roughly sqrt(n) of them; this is not a target for the call count and does not decide how many calls the task actually takes. Name the outcome and its proof, not a single file operation and not the whole user request. One to three sentences.

## begin.stage

Required workflow stage for this scope.

## begin.budget

Map each tool name to an integer budget of assistant turns. One assistant message spends at most one unit in total: that unit is split across budgeted calls in proportion to their call counts, rounded to two decimals. Several read calls issued together consume one read share once, while a read in a later message consumes another share. Use actual tool names (bash, read, write, edit, glob, grep, lsp, task, web_search, debug, eval, etc.), not semantic descriptions. Example: {"bash": 6, "read": 7, "edit": 4}. Size each number by the number of turns you expect to use that tool in, not by individual calls. For a heavy task, also budget task: parallel subagent workers take independent slices at once, and one batch of task calls costs one task unit. Only the innermost scope's budget is used. Do not budget scope, amend, defer, pin, todo, ask, or wait. A budget can be empty if only free tools are needed. An unlisted budgeted tool has zero budget. Values must be non-negative integers; the accounting splits them into two-decimal shares, and a tool whose balance is below its share is blocked while the rest of the message still runs.

## begin.elder_report

The summary of the previous scope at this level. Record its outcomes and remaining work; do not repeat user messages, which folding keeps before the scope's begin call. Pass a non-empty string only when an unarchived elder scope is pending at this level: the tail instruction names it and its intent. That summary archives the elder, turning it from pending into the hot workbench so older folded elders become eligible for batching. Pass null when no elder is pending, when the previous scope is not visible on the branch, or when this is the first scope at the level. This is a handoff receipt, not the user-facing answer.

## begin.permission

Declare the scope's write intent. "ro" is a read-only declaration and is trusted: the harness never enforces it. "rw" is refused in stage "decision-framing" and while this generation has not submitted its first todo ledger (a todo view does not count); submit the ledger first, or choose a later stage. An omitted or null value is treated as "rw", so forgetting the declaration never bypasses the gate.

## begin.model

Optional model spec for this scope: provider/id, settings alias or role, or a model with an off/minimal/low/medium/high/xhigh thinking suffix. The host performs the real model switch and restores the previous model when the scope closes.

## end

Close the current scope by passing true. No report is written at close time and no summary is required. The closed scope stays visible as the hot workbench at its level. If you later open another sibling scope at that level, pass this scope's summary in that begin's elder_report; if you leave the level or finish the task instead, write no summary at all.

## amend.tool

Amend the record: replace the most recent completed beat inside the current scope with the text you pass as reflection. It is one move — amend rides in the same message as your next tool calls, so it needs no extra turn and costs no budget of its own. A beat is one assistant message (thinking and output) together with its tool calls and their results. On the next LLM request, that beat no longer appears, your reflection text stands in its place, and the budget spent by its tool calls is refunded to the current scope. Every amend in a beat is processed before any normal tool in that beat, so a refund can fund a call in that same message. Multiple amend calls in the same beat replace several earlier beats, one per call.

Amend edits the record, not the world: file edits and commands that already ran stay exactly as they are. What goes away is the reasoning and tool traffic that led there, so the next request starts from the state before that beat, read together with your replacement text.

Reach for it whenever the last beat was merely not good, not only when it was clearly wrong: a wrong turn of direction, files you read but did not need, a half-written change you already replaced, the wrong tool or the wrong grain of work, a conclusion that new evidence overturned. Amend that beat and continue with a clean context instead of paying for it again in every later request.

Rules: only inside a scope; the target must come after the current scope's begin; a beat containing a scope call cannot be amended away; a beat paid by an outer scope cannot be amended; a closed nested scope is a boundary, so do not amend across it. Defer calls in the amended beat are withdrawn from the pending list, but their text remains valid and is still delivered when the scope ends.

Reflection is required, is the only cost, and is the replacement itself: it is the text the record keeps where the beat used to be. Say what you were attempting, why that attempt did not fit the task, and what the next attempt must do instead. Do not use amend to hide evidence or to skip the difficult part of the work; use it to replace work that was wrong, not work that was hard.

## amend.reflection

The text that replaces the beat: what you were attempting, why it did not fit the task, and what the next attempt must do instead. Must not be empty.

## defer.tool

Record a finding that should be handled later without spending budget now. Only inside a scope. Returns OK immediately and costs no budget. When the current scope ends, every finding deferred in that scope is delivered as one steering user message, so you can request a new scope with enough budget to address it. A nested scope's findings are delivered when that scope ends, even if its enclosing scope is still active; treat them as work inside the enclosing scope. Use defer for real budget triage: something important you discovered, but not worth the remaining calls in this scope. Do not use it to avoid required work.

## defer.intent

What must be done later and why it matters. Must be specific, actionable, and non-empty.

## pin.tool

Record a durable reasoning note. pin costs no budget, has no call limit, and always returns OK; call it inside or outside a scope. Every field is optional Markdown. Pins survive scope collapse and all historical pins are passed to the successor at relay handoff. After saving a stage artifact, pin its path and key conclusions. Use pin for durable assumptions, deductions, inductions, findings, and conclusions; use defer for work that must be done later.

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
