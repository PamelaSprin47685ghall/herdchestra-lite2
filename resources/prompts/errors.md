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

This generation has not submitted its first todo ledger yet, so permission "rw" is refused. Close all scopes and call todo with a write operation to submit the ledger (a todo view does not count), or declare permission: "ro" for a read-only scope. permission "ro" is trusted and never enforced.

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

stage "direct-execution" requires one run of each earlier stage. Missing: {{missing}}. Open each missing stage's scope before execution.
