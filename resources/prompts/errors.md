## foreign-scope-id

That scope id belongs to another owner. Use a path from `state.scopes`.

## not-a-child

This scope is not a forked scope, so that lifecycle call has nothing to act on. At root, answer the user or fork the work.

## request-unreachable

`{{target}}` never started or already failed, so no turn can answer there. Ask a scope listed in `state.scopes`, or fork the work again.

## invalid-scope-id

Use a short ASCII `scopeId` other than `root`.

## invalid-fsm

Give the new scope a non-empty `fsm`.

## invalid-profession

Start `profession` with "You are " and name the role of the LLM in the new scope, for example "You are a precise reviewer who rejects a claim without evidence".

## invalid-budget

`budget` maps tool names to non-negative integer turns. Free tools need no entry; neither does a `read` or `write` of a built-in protocol URI, which spends no turn at any level.

## invalid-argument

`model` is a string or null.

## invalid-targets

`targets` must be a non-empty array of strings, each a natural-language description of what this scope expects to create, read, update, or delete. A file path is only one kind; `["fix any defect you find", "the parts of the source that involve caching"]` is valid. If it is empty, how could a scope with no output be a separate scope?

## fork-ledger-unavailable

No bracket ledger is attached; fork/join is unavailable in this session. Continue in the current scope, or report the configuration.

## missing-fsm

A new scope needs a non-empty `fsm`.

## missing-dafny

A return needs non-empty `dafny`. Carry forward the evidence and unresolved work that the next context or the caller would otherwise lose.

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

## invalid-return-oath

Omit `signed_sealed_hands_off_nothing_left_on_the_table` to rewind, or give it the exact value `a_ferocious_audacious_master_would_change_nothing` to take the oath.

## mixed-return

`scope_return` must be the only call in its script: call it alone.

## return-unreceived

Root still owns unreceived work. Receive it with `scope_join` before taking the oath.

## return-rewind-unavailable

The rewind is unavailable. The current record is unchanged.

## unknown-fork

This scope is not registered. Use the path from the fork receipt, or fork a new scope.

## fork-not-running

Fork {{scopeId}} is {{status}}. Use `scope_join` for a ready record; otherwise continue the work or fork a new scope.

## orphans-without-receiver

No receiving scope owns this fork. Join the scopes it forked first.

## root-has-no-budget

The root is outside all scopes and has no ordinary tool budget. Delegate the work with `scope_fork`; control tools stay available, and so does every `read` or `write` of a built-in protocol URI (`skill://`, `local://`, `ssh://`, `agent://`, `xd://`…), which costs no turn at any level.

## no-branch-budget

Scope `{{ownerId}}` has no fork record, so it has no budget. Return with `scope_return` or fork the work.

## no-unreceived-work

This scope owns no unreceived work. This call created no receipt. Fork a new scope, or continue your own.

## model-unknown

forks[{{index}}]: model `{{selector}}` is not available. Available: {{available}}. Omit `model` to inherit the calling scope's model.

## abandon-unknown-target

No scope answers to `{{target}}`. Use the exact path from the fork result or `state.scopes`.

## abandon-not-owned

`{{target}}` belongs to another scope. A scope can abandon only a scope it forked itself.

## fork-register-failed

The fork could not be registered ({{code}}). Retry the fork; if it fails again, report the code.
