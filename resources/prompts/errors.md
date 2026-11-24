## scope-context-empty

Give at least one of `pin` or `amend`; the call changed nothing.

## amend-reflection

Provide a non-empty `reflection` to replace the beat.

## amend-unavailable

Amend is unavailable. The record is unchanged; continue from the current record.

## pin-empty

Name at least one field with content: `assumption`, `deduction`, `induction`, `finding`, or `conclusion`.

## pin-unavailable

Pin is unavailable; the note is absent. Continue without it, or retry when the pin port is available.

## pin-internal

The note is absent; retry or continue without it.

## pin-internal-error

The pin failed. Treat the note as not saved.

## ask-blocked

Autopilot is on. Only the user can turn it off with `/herd-autopilot`.

## model-switch-warning

Could not verify {{command}}: {{reason}}. Use the model the host reports.

## invalid-scope-id

Use a short ASCII `scopeId` other than `root`.

## invalid-fsm

Give the new scope a non-empty `fsm`.

## invalid-profession

Start `profession` with "You are " and name the role of the LLM in the new scope, for example "You are a precise reviewer who rejects a claim without evidence".

## invalid-budget

`budget` maps tool names to non-negative integer turns. Free tools need no entry; neither does a `read` or `write` of a built-in protocol URI, which spends no turn at any level.

## invalid-time

Do not pass `time`. The system derives the scope's time limit from the session's mean LLM-request duration and the sum of the item's turns.

## invalid-argument

`model` is a string or null; `blocked` is a boolean.

## invalid-targets

`targets` must be a non-empty array of strings, each a natural-language description of what this scope expects to create, read, update, or delete. A file path is only one kind; `["fix any defect you find", "the parts of the source that involve caching"]` is valid. If it is empty, how could a scope with no output be a separate scope?

## fork-ledger-unavailable

No bracket ledger is attached; fork/join is unavailable in this session. Continue in the current scope, or report the configuration.

## missing-fsm

A new scope needs a non-empty `fsm`. Only a reuse of an existing `scopeId` may omit it.

## foreign-scope-id

Scope {{scopeId}} belongs to another owner. Only its owner may reuse it.

## scope-running-blocked

Scope {{scopeId}} is running, so it cannot be marked blocked. Reuse it with turns or a requirement instead.

## scope-reuse-empty

Reusing `{{scopeId}}` changed nothing. Add `budget`, `fsm`, or `targets`.

## scope-not-amendable

This scope cannot be reused in its current state. Fork a new scope instead.

## child-spawner-unavailable

No scope spawner is attached; this session cannot start new scopes. Continue in the current scope, or report the configuration.

## fork-context-exceeded

forks[{{index}}]: {{reason}}
The batch did not start. Reduce the calling scope's context or use a model with a larger window, then fork again.

## no-ready-child

No forked scope has returned yet. Keep working, or wait for one with `scope_join`.

## join-context-exceeded

{{detail}}
The record stays ready; use a model with a larger window or shorten the record, then join again.

## not-a-child

`scope_return` ends a forked scope. The scope that forked it receives the work with `scope_join`.

## unknown-fork

This scope is not registered. Use the `scopeId` from the fork receipt, or fork a new scope.

## fork-not-running

Fork {{scopeId}} is {{status}}. Use `scope_join` for a ready record; otherwise continue the work or fork a new scope.

## orphans-without-receiver

No receiving scope owns this fork. Join the scopes it forked first.

## root-has-no-budget

The root is outside all scopes and has no ordinary turns. Delegate the work with `scope_fork`; control tools stay available, and so does every `read` or `write` of a built-in protocol URI (`skill://`, `local://`, `ssh://`, `agent://`, `xd://`…), which costs no turn at any level.

## no-branch-budget

Scope `{{ownerId}}` has no fork record, so it has no turns. Return with `scope_return` or fork the work.

## accounting-failed-closed

Scope accounting failed closed: {{error}}. No tool ran. Retry the call; if it fails again, report the accounting error.

## inherited-ledger-unviewed

The previous holder stopped with open work, so its ledger is yours to read first. Call `todo({ op: "view" })` once. It is free and does not submit a ledger; then write your own.

## todo-native-unavailable

This host does not expose `ctx.invokeTool`, so the native todo implementation cannot run. Do not implement todo state locally.

## todo-native-failed

The native todo call failed: {{detail}}. The ledger is unchanged; use the native error as evidence.

## todo-native-invalid

The native todo call returned no result object. The ledger is unchanged.

## no-unreceived-work

This scope owns no unreceived work. This call created no receipt. Fork a new scope, or continue your own.

## tool-budget-exhausted

Tool `{{tool}}` has no turns left on this scope (remaining {{remaining}}/{{budget}}). The call runs anyway, and the receipt marks it panhandled. That mark is the whole cost, and it is enough: the scope that forked you reads it on return, and it says your sizing was wrong. The cheap exit is `scope_fork` (free) for whatever another scope can own; `scope_return` is the other.

## model-unknown

forks[{{index}}]: model `{{selector}}` is not available. Available: {{available}}. Omit `model` to inherit the calling scope's model.

## fork-register-failed

The fork could not be registered ({{code}}). Retry the fork; if it fails again, report the code.
