## stage-line

Stage: {{stage}}. Follow the [Stage: {{stage}}] section in your system prompt; the other stage sections do not apply inside this scope.

## stage-line.direct

Stage: direct-execution. This stage has no stage prompt; follow the orchestration-plan artifact.

## begin

You are now inside this scope.
Intent: {{intent}}
{{stage_line}}
Budget (innermost scope only): {{budget}}.
Only the innermost scope's budget is used. An unlisted budgeted tool has zero budget calls. scope, amend, defer, pin, ask, and wait are free where allowed; the write that resolves a staged ast_edit preview (xd://resolve or xd://reject) is free.
todo is free but forbidden inside any active scope. Close every scope before updating the ledger.
Calls in one assistant message spend at most one unit in total, split across budgeted tools by call count and rounded to two decimals. A tool whose balance runs out is blocked while the rest of the message still runs.
{{closing_line}}
Close with scope({ end: true }). This scope stays visible as the hot workbench. When opening its next sibling, pass its summary in begin.elder_report.

## begin.herd

While herd mode is on, you may stop here to wait for the user's input.

## begin.close

Do not write the final user-facing answer while inside a scope. Close every scope first.

## end.transitioning

Scope closed.

## end.inside

Scope closed. You are back inside the enclosing scope: {{intent}} (remaining budget: {{budget}}).

## end.outside

Scope closed. You are outside all scopes.

## end.elder-folded

Your elder sibling scope at this level was collapsed; its begin receipt now reads: {{report}}

## end.no-elder

No elder sibling scope was collapsed.

## end.keeps-turns

This scope keeps its internal turns until a younger sibling scope closes; its begin receipt will then read: {{report}}

## end.defers-delivered

{{count}} deferred finding(s) were delivered as a steering user message:

## end.defers-follow

{{count}} deferred finding(s) follow:

## end.no-defers

No deferred findings were recorded in this scope.

## end.todo-inside

todo cannot be called inside any scope. Before finishing, close every enclosing scope, then call todo to update the ledger. A non-empty ledger forbids stopping; an empty ledger triggers the relay handoff protocol.

## end.todo-outside

Call todo now to evaluate the ledger before writing the final user-facing answer. A non-empty ledger forbids stopping; an empty ledger triggers the relay handoff protocol.

## end.herd

Herd mode is on. You may stop and wait for the user's input.

## end.continue-inside

Do not write the final user-facing answer yet. Continue inside the enclosing scope, or close it when the whole task is complete. Finishing is not a tool call.

## end.promoted

You are outside all scopes. Only a promoted empty-ledger successor evaluation allows the final user-facing answer as ordinary assistant text. Do not put it in return_markdown. Finishing is not a tool call.

## end.finish

You are outside all scopes. Finishing is not a tool call.

## amend.replaced

Replacement text now standing in the record: {{text}}

## amend.undone

Amended the previous beat away. It will not appear in the next LLM request.

## amend.refunded

Refunded {{count}} tool call(s).

## amend.no-refund

No tool budget was refunded by that beat.

## amend.remaining

Remaining: {{budget}}.

## amend.residual

{{count}} defer finding(s) from that beat were withdrawn but remain valid; they will still be delivered when this scope ends.

## leave-framing

Herd mode is off. Leave decision-framing by closing this scope.

## inside-nudge

You are still inside scope level {{level}}: {{intent}}.{{leave_framing}} Do not write the final user-facing conclusion. Continue the task or close it with scope({ end: true }). Close all scopes before using todo. Only after the relay allows stopping may you write the final user-facing answer.

## inside-text

You are still inside scope level {{level}}: {{intent}}.{{leave_framing}} Do not write the final user-facing conclusion. Continue the task or close the scope. todo is forbidden inside every scope; close every scope before evaluating the ledger.

## receipt.inside

You are inside scope level {{level}}: {{intent}}. Remaining budget (innermost scope only): {{budget}}.

## receipt.outside

You are outside all scopes.

## receipt.herd

Herd mode: {{mode}}.

## receipt.stage

Stage: {{stage}}.

## receipt.no-ledger

No todo ledger submitted yet: new scopes must declare permission: "ro"; permission "rw" (including an omitted value) is refused.

## receipt.herd-rules

New scopes must use stage: "decision-framing". ask is allowed only when that stage is innermost. You may stop naturally to wait for the user.

## receipt.close-framing

Close the decision-framing scope; herd mode is off.

## receipt.can-stop

The relay allows you to stop. Write the final answer in your message body.

## receipt.todo

Before stopping, call todo to evaluate the ledger; finishing is not a tool call.

## receipt.finish

Finishing is not a tool call.

## receipt.close-handoff

Close all scopes before writing the pending relay handoff report.

## inside-nudge.simple

You are still inside scope level {{level}}: {{intent}}.{{leave_framing}} Do not write the final user-facing conclusion. Continue the task or close it with scope({ end: true }).

## inside-text.simple

You are still inside scope level {{level}}: {{intent}}.{{leave_framing}} Do not write the final user-facing conclusion. Continue the task or close the scope.

## receipt.simple-inside

Simple mode: this task runs without a ledger, so no relay applies. Finish the work, close every scope, then write the final answer. A todo write, even an empty list, turns on the full flow.

## receipt.simple-outside

Simple mode: this task runs without a ledger, so no relay applies. Write the final answer as ordinary assistant text. A todo write, even an empty list, turns on the full flow.

## language

(Routine reminder appended at the end of every turn; not a new user message.) 强制以简体中文思考，尤其要以简体中文词开头。强制简体中文回答用户。
