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

## overtime-killed

Tool stopped at the scope deadline. Its result is gone. Calls now get one second each. Return with `scope_return` when ready, or hand off.

## invalid-scope-id

Use a short ASCII `scopeId` other than `root`.

## invalid-intent

Give the child a non-empty `intent`.

## invalid-budget

`budget` maps tool names to non-negative integers. Free tools need no entry.

## invalid-time

`time` is a positive number of seconds.

## invalid-argument

`model` is a string or null; `blocked` is a boolean.

## invalid-targets

`targets` must be a non-empty array of strings, each a natural-language description of what this scope expects to create, read, update, or delete. A file path is only one kind; `["fix any defect you find", "the parts of the source that involve caching"]` is valid. If it is empty, how could a scope with no output be a separate scope?

## fork-ledger-unavailable

No bracket ledger is attached; fork/join is unavailable in this session. Continue in the current scope, or report the configuration.

## duplicate-scope-id

Scope {{scopeId}} is already declared. Choose another `scopeId`.

## child-spawner-unavailable

No child spawner is attached; this session cannot start child scopes. Continue in the current scope, or report the configuration.

## fork-context-exceeded

forks[{{index}}]: {{reason}}
The batch did not start. Reduce the parent context or use a model with a larger window, then fork again.

## elder-report-type

`elder_report` is a string or null.

## elder-report-empty

`elder_report` is a non-empty string or null.

## no-ready-child

No child has returned yet. Keep working, or wait for one with `scope_join`.

## elder-report-missing

Receipt {{scopeId}} is still unreported. Summarize it in `elder_report`, then join again.

## join-context-exceeded

{{detail}}
The record stays ready; use a model with a larger window or shorten the record, then join again.

## stale-elder-reported

Receipt {{scopeId}} already has a summary. Retry with `elder_report: null`.

## stale-elder-uncommitted

The join took no result; its summary was not committed. Retry with an `elder_report` for {{scopeId}}.

## not-a-child

`scope_return` ends a child scope. The parent receives work with `scope_join`.

## unknown-fork

This scope is not registered. Use the `scopeId` from the fork receipt, or fork a new child scope.

## fork-not-running

Fork {{scopeId}} is {{status}}. Use `scope_join` for a ready record; otherwise continue the work or fork a new scope.

## orphans-without-receiver

No receiving scope owns this fork. Join its children first.

## root-has-no-budget

The root is outside all scopes and has no ordinary tool budget. Delegate the work with `scope_fork`; control tools and `skill://` reads remain available.

## no-branch-budget

Scope `{{ownerId}}` has no fork record, so it has no tool budget. Return with `scope_return` or fork the work.

## accounting-failed-closed

Scope accounting failed closed: {{error}}. No tool ran. Retry the call; if it fails again, report the accounting error.

## inherited-ledger-unviewed

The previous generation retired with open work, so its ledger is yours to read first. Call `todo({ op: "view" })` once. It is free and does not submit a ledger; then write your own.

## todo-native-unavailable

This host does not expose `ctx.invokeTool`, so the native todo implementation cannot run. Do not implement todo state locally.

## todo-native-failed

The native todo call failed: {{detail}}. The ledger is unchanged; use the native error as evidence.

## todo-native-invalid

The native todo call returned no result object. The ledger is unchanged.

## no-unreceived-work

This scope owns no unreceived work. This call created no receipt and any `elder_report` it carried was not committed. Fork a child, or continue your own scope.

## tool-budget-exhausted

Tool `{{tool}}` has no work budget left on this scope (remaining {{remaining}}, budget {{budget}}). Continue with another tool, or return with `scope_return`.

## model-unknown

forks[{{index}}]: model `{{selector}}` is not available. Available: {{available}}. Omit `model` to inherit the parent's model.

## fork-register-failed

The fork could not be registered ({{code}}). Retry the fork; if it fails again, report the code.

## elder-report-too-short

`elder_report` needs at least {{minimum}} characters. Say what the successor still needs from that record; the content decides its format.

## elder-report-too-long

`elder_report` exceeds {{maximum}} characters. Shorten it to what a successor cannot recover elsewhere.
