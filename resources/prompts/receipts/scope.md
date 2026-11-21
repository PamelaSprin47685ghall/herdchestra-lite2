## stage-line

Stage: {{stage}}. Follow the [Stage: {{stage}}] section in your system prompt; the other stage sections do not apply inside this scope.

## stage-line.direct

Stage: direct-execution. This stage has no stage prompt of its own; follow the orchestration-plan artifact. Open each batch the plan specifies with all of its flows in one `scope({ begin })` call, fanning them at once. Never run a planned batch one flow after another. A flow that turns out to split into disjoint write sets may be split into further concurrent flows; a planned batch is never collapsed into a serial sequence.

Serialization carries the burden of proof: parallel work needs only "no known suspicious sharing", while collapsing a batch into one flow needs a named coupling or an irreversible external effect. A suspected overlap is marked and run concurrently, with tests as the detector.

## begin

You are now inside this scope.
Intent: {{intent}}
{{stage_line}}
Budget (innermost scope only): {{budget}}.
{{closing_line}}
This scope stays visible as the hot workbench. When opening its next sibling, pass its summary in begin.elder_report.

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

## end.keeps-turns

This scope stays visible verbatim as the hot workbench. Summarize it in begin.elder_report only if you later open another sibling at this level.

## end.todo-inside

todo cannot be called inside any scope. Before finishing, close every enclosing scope, then call todo to update the ledger. A non-empty ledger forbids stopping; an empty ledger triggers the relay handoff protocol.

## end.todo-outside

Call todo now to evaluate the ledger before writing the final user-facing answer. A non-empty ledger forbids stopping; an empty ledger triggers the relay handoff protocol.

## end.herd

Herd mode is on. You may stop and wait for the user's input.

## end.continue-inside

Do not write the final user-facing answer yet. Continue inside the enclosing scope, or close it when the whole task is complete. Finishing is not a tool call.

## end.promoted

You are outside all scopes. Only a promoted empty-ledger successor evaluation allows the final user-facing answer as ordinary assistant text. Finishing is not a tool call.

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

## receipt.pending-elder

Pending elder at this level: {{intent}} (summarize it in begin.elder_report if you open a sibling).

## receipt.no-pending-elder

No pending elder at this level (pass elder_report: null if you open a scope).

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

You are still inside scope level {{level}}: {{intent}}.{{leave_framing}} Do not write the final user-facing conclusion. Continue the task or close it with scope({ end: true }).

## receipt.simple-inside

Simple mode: this task runs without a ledger, so no relay applies. Finish the work, close every scope, then write the final answer. A todo write, even an empty list, turns on the full flow.

## receipt.simple-outside

Simple mode: this task runs without a ledger, so no relay applies. Write the final answer as ordinary assistant text. A todo write, even an empty list, turns on the full flow.

## language

(Routine reminder appended at the end of every turn; not a new user message.) 强制以简体中文思考，尤其要以简体中文词开头。强制简体中文回答用户。

## fission.begin

Fission batch {{batch}} registered with {{flows}} flow(s) in {{stage}}.
{{flow_lines}}
The owner retires after this receipt. Each flow opens its own scope beneath it, and the batch ends when every flow has closed.

## fission.flow-lines

- flow {{index}}: {{intent}}

## fission.flow-receipt

Fission flow {{label}} (batch {{batch}}, index {{index}}, stage {{stage}}).
Intent: {{intent}}
Budget: {{budget}}. Permission: {{permission}}. Model: {{model}}.
This receipt assigns this flow only; sibling receipts assign the other flows.
Your flow scope is already open. Call scope({ end: true }) when complete, or open a nested fission batch to delegate completion. Do not call todo.

## fission.flow-intent

Fission flow {{label}} (batch {{batch}}, index {{index}}, stage {{stage}}).
Intent: {{intent}}
Budget for this flow: {{budget}}. Permission: {{permission}}.
Your flow scope is already open. Call scope({ end: true }) when complete, or open a nested fission batch to delegate completion. Do not call todo.

## fission.flow-end-declared

Flow completion declared. The scheduler will close this scope after the tool result is persisted.
