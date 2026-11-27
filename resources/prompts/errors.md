## invalid-path

Every scope path segment must be `<role>.<name>` with `<role>` one of `manager`, `devops`, `editor`, or `inspector` (e.g. `"editor.eve"`, `"../inspector.peter/editor.eve"`, or `"/manager.tom/devops.alice"`). No empty segments, trailing slash, wildcards, `..` past `/`, bare names without a role, or `root` segment.

## duplicate-scope-path

Path `{{path}}` already exists (`{{status}}`). Every fork path must be unique; choose a fresh path instead.

## unknown-upscope

Upscope `{{upscopePath}}` does not exist. Fork only under `/` or an existing scope path shown in the directory (never under a scope created in the same batch).

## upscope-not-ready

Upscope `{{upscopePath}}` has no ready context snapshot yet (still initializing or failed before producing a turn). Retry once it has a snapshot, or fork under another upscope.

## cannot-abandon-root

Root (`/`) cannot be abandoned.

## cannot-abandon-self

A scope cannot abandon itself. Call `scope_return` directly instead.

## scope-already-done

Scope `{{target}}` is already `done` and cannot be abandoned.

## abandon-unknown-target

No scope exists at `{{target}}`. Use an exact `running` scope path from the directory.

## not-a-subscope

This scope is Root (`/`), not a forked subscope, so that lifecycle call has nothing to act on.

## invalid-fsm

Give the new scope a non-empty `fsm`.

## invalid-profession

Start `profession` with "You are " and name the role of the LLM in the new scope, for example "You are a precise reviewer who rejects a claim without evidence".

## invalid-budget

`budget` maps tool names to non-negative integer turns. Free tools need no entry; neither does a `read` or `write` of a built-in protocol URI, which spends no turn at any level.

## invalid-argument

`model` is a string or null.

## invalid-targets

`targets` must be an array of strings. An `editor` requires concrete file paths (e.g. `["src/foo.mjs", "tests/foo.test.mjs"]`) with no spaces, globs, or bare directories. A `manager`, `devops`, or `inspector` may also name a behavior, finding, or open-ended goal, e.g. `["the parts of the source that involve caching"]`.

## role-escalation

Role `{{callerRole}}` cannot open or abandon role `{{targetRole}}` (`{{path}}`). Privilege narrows monotonically: `manager > devops > editor > inspector`; use your own role or a narrower one.

## devops-already-running

Only one `devops` scope may be `running` at a time (`{{activePath}}` is still running). Wait for it to turn `done`, or abandon it and wait for `done`, before forking another `devops`.

## invalid-editor-targets

An `editor` must declare concrete target file paths in `targets` (e.g. `["src/foo.mjs", "tests/foo.test.mjs"]`). Prose, spaces, globs, and bare directories are refused.

## forbidden-role-budget

Tool `{{tool}}` is not available to role `{{role}}`. Remove it from `budget`, or choose a role that may hold it.

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
The batch did not start. Reduce the upscope's context or use a model with a larger window, then fork again.

## no-ready-subscope

No forked subscope has returned yet. Keep working, or wait for one with `scope_join`.

## join-context-exceeded

{{detail}}
The record stays ready; use a model with a larger window or shorten the record, then join again.

## invalid-return-oath

Pass `signed_sealed_hands_off_nothing_left_on_the_table` as exactly one of two values: `unfinished` to rewind, or `a_ferocious_audacious_master_would_change_nothing` to seal. A missing or other value is refused.

## mixed-return

`scope_return` must be the only call in its script: call it alone.

## return-unreceived

Root still owns {{count}} unreceived subscope(s). Receive them with `scope_join` before sealing.

## return-rewind-unavailable

The rewind is unavailable. The current record is unchanged.

## unknown-fork

This scope is not registered. Use the path from the fork receipt, or fork a new scope.

## fork-not-running

Subscope `{{path}}` is already `done` ({{status}}). Use `scope_join` for an unreceived record; otherwise continue or fork a new subscope.

## orphans-without-receiver

No live receiving scope owns this subscope. Join the subscopes it forked first.

## root-has-no-budget

The root is outside all scopes and has no ordinary tool budget. Delegate the work with `scope_fork`; control tools stay available, and so does every `read` or `write` of a built-in protocol URI (`skill://`, `local://`, `ssh://`, `agent://`, `xd://`…), which costs no turn at any level.

## no-branch-budget

Scope `{{ownerId}}` has no fork record, so it has no budget. Return with `scope_return` or fork the work.

## no-unreceived-work

This scope owns no unreceived work. This call created no receipt. Fork a new scope, or continue your own.

## model-unknown

forks[{{index}}]: model `{{selector}}` is not available. Available: {{available}}. Omit `model` to inherit the upscope's model.

## fork-register-failed

The fork could not be registered ({{code}}). Retry the fork; if it fails again, report the code.
