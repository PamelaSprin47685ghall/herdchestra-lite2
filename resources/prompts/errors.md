## amend-reflection

amend.reflection must be a non-empty string.

## amend-scope

amend is only allowed inside a scope.

## amend-history

amend is only allowed inside a scope with a visible beat history.

## defer-intent

defer.intent must be a non-empty string.

## scope-model

scope.begin.model must be a non-empty string or null.

## scope-end-type

scope.end must be the boolean true; closing a scope no longer takes a report.

## scope-end-false

scope.end:false does not close a scope; provide begin or end:true.

## scope-neither

Provide begin, end, or both.

## scope-elder-report

scope.begin.elder_report must be a non-empty string or null.

## scope-handoff-pending

A relay handoff is pending. Do not open a new scope; wait for the successor.

## scope-permission

scope.begin.permission must be "ro" or "rw".

## rw-decision-framing

stage "decision-framing" answers why, not what, so it cannot carry a write scope. Declare permission: "ro" (trusted, never enforced), or open the write scope in a later stage.

## rw-before-ledger

The full flow is on and this generation has not submitted its first todo ledger yet, so permission "rw" is refused. Close all scopes and call todo with a write operation to submit the ledger (a todo view does not count), or declare permission: "ro" for a read-only scope. permission "ro" is trusted and never enforced. Submit the remaining work, or `todo({ op: "init", list: [] })` when no user-requested work remains: an empty ledger is a lawful submission.

## herd-only-framing

Herd mode is on. Only stage: "{{stage}}" can open.

## normal-stage

Herd mode is off. Choose a stage: {{stages}}.

## missing-elder-report

An unarchived elder scope is pending at this level. Pass its summary in begin.elder_report.

## scope-end-outside

scope end is only allowed inside a scope.

## same-message

A scope cannot begin and end in the same assistant message. Begin it in one message, do the work, then end it in a later message.

## context-exceeded

The retained context is estimated at {{tokens}} tokens; {{model}} has a {{window}}-token window.

## model-switch-warning

WARNING: {{command}} failed: {{reason}}

## stage-flags-unmet

The full flow requires one run of each earlier stage before "direct-execution". Missing: {{missing}}. Open each missing stage's scope before execution; simple mode has no such flag gate.

## not-in-scope

Outside all scopes, only todo and the free control tools (scope, amend, defer, pin) may be called. Open a scope with scope({ begin: { stage, elder_report, time, fission: [{ intent, budget, permission }] } }); one flow is a one-item fission array, and every item must declare permission. Time is required in seconds.

## scope-in-fission

Use scope({ end: true }) to finish this flow, or open a nested fission batch. A flow cannot open an ordinary scope.

## invalid-begin-shape

A begin requires stage, elder_report, time, and fission. The single-flow begin shape no longer exists; to open one flow, pass a one-item fission array.

## fission-with-end

A fission begin cannot also close a scope. Close the open scope first with a plain end: true call, then open the batch in a following call.

## fission-unavailable

Fission cannot start: the host exposes no abort() for owner retirement, or no scheduler is attached to the station registry.

## fission-pending

A fission batch from this agent has not retired yet; wait for its receipt before opening another.

## todo-inside-scope

todo is forbidden inside any active scope. Close every scope first; todo only works outside all scopes.

## ask-blocked

ask is allowed only when the user has enabled /herd and the current scope has stage: "decision-framing".

## flow-open

This flow is still open. When the work is complete, call scope({ end: true }).

## overtime-killed

OVERTIME: that tool ran {{elapsed}}ms in the chess-clock phase, past its {{limit}}ms limit, and was killed. Its result is gone. You are out of normal time: shrink the work, close the scope, or hand off now.
