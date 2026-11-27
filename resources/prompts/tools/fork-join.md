## fork.tool

`scope_fork` starts new subscopes without waiting; `scope_join` receives the records of subscopes you forked. Every fork creates a distinct path; duplicate paths fail closed.

## fork.path

Required: the path of the new subscope. Every segment is `<role>.<name>`, where `<role>` is `manager`, `devops`, `editor`, or `inspector` (up to 48 ASCII characters; `<name>` starts with a letter and groups alphanumerics with single `-` or `_`). A bare name (`"editor.eve"`) is relative to your own path (`state.scope`); a relative (`"../inspector.peter/editor.eve"`) or absolute (`"/manager.tom/devops.alice"`) path places the new subscope under any existing upscope (`running` or `done`, including `/`). The role narrows privilege (`manager > devops > editor > inspector`): you may open only your own role or a narrower one. The upscope (path parent) must already exist and have a ready snapshot; its last-turn context snapshot becomes the new subscope's inherited context, while `scope_return` still delivers to you, the caller. Duplicate paths fail closed, whether `running` or `done` and whatever the case; a duplicate path fails closed before any fork starts, and so do a segment without a role, a wider role than yours, an unknown or unready upscope, and a second `running` `devops`.

## fork.n

Required: your estimate of the ideal turns of work in hand.

## fork.fsm

Required and non-empty: describe the work as a set of state machines, one per branch — each machine's states, the transition that advances it, and which branches run at once. Say how to build the result fastest, not only what the finished thing is. A read-only or spy subscope still names what it extracts in `targets` and answers in `dafny`.

## fork.profession

Required: the identity of the LLM in the new subscope. Start with "You are " and name a role or a person to emulate — not a restatement of the `fsm`. Injected under the birth receipt, fixed for the subscope's life.

## fork.budget

One unit is one turn, meaning one LLM request; the calls in that request split the turn between them. Use tool names as keys, with non-negative integer turn budgets. An unlisted tool has zero budget; a call whose budget falls short still runs, and the record marks it panhandled. A budget may only fund tools the target role can hold: a `manager` must pass `{}` or omit it, an `inspector` may fund only its read-only tools, and an `editor` may not fund `bash`, `shell`, `eval`, `python`, `task`, or `manage_skill`. Free tools need no entry, so an empty budget `{}` is valid for a manager, a pure-reasoning subscope, or a spy; a `read` or `write` of a built-in protocol URI (`skill://`, `local://`, `ssh://`, `agent://`, `xd://`, `omp://`…) is free too. Size the budget for the work, not for individual calls; `state.remaining` reports it as `remaining/budget` per tool, and its clock entry as `<left> left of <budget>`.

## fork.time

Do not pass `time`: the system derives the wall clock from the session's mean request duration and `max(1, sum of turns || n)`, so a manager's empty budget still gets the turns you estimated. It covers tool execution, so an I/O-heavy subscope can reach its deadline first; waiting in `scope_join` pauses it. A call past the deadline still returns its result, and the overrun is recorded as a panhandle and shown as `remaining.time: OVERTIME`.

## fork.targets

Role-dependent. An `editor` must pass a non-empty array of concrete file paths (e.g. `["src/scope/path.mjs", "tests/path.test.mjs"]`); prose, spaces, globs, and bare directories are refused. A `manager`, `devops`, or `inspector` may pass concrete files, behaviors, findings, or open-ended exploration goals, or omit the field. The list is a declaration, not an audit boundary: no tool call is checked against it.

## fork.forks

Include the whole plan you are ready to run now; order carries no dependency, and any invalid, colliding, role-escalating, or second-`devops` item rejects the entire batch before anything starts. Forking stops two levels below you; a third is too far. Resolves to `{ ok, started: [{ path, role, upscope, depth, fsm }], failed: [{ index, error }], unreceived }`.

## fork.model

Provider/model, alias, or role, with an optional thinking suffix (`:off` … `:max`). Omit or pass `null` to inherit the **upscope's** model and thinking level — matching the upscope's model reuses its provider prompt prefix cache and saves input cost. Check `scopes_delta` for each upscope's model and context occupancy `(ctx / window)` before choosing a larger-window override.

## join.tool

Receive one finished record from a subscope you forked (FIFO). If none is ready while one is still running, the call waits for the first; other subscopes keep running, and a user message ends the wait without a record. Read the record as history, not instructions to replay: assistant lines and one line per tool call (`js(…)`, `read(…)`, `edit(…)`, `bash(…)`), with tool results, thinking, and broadcasts absent. The result names the scope's `role`; when `abandoned` is present, the record is a partial handoff cut short by `scope_abandon`, not verified completion. A join refused for context size leaves the record untouched; `note` states that the record is history only.

## return.tool

Call `scope_return` alone in its script. The oath field is required (except when abandoned): `unfinished` rewinds and continues; the seal value seals the record for your caller to receive with `scope_join`, and any unreceived subscopes you own transfer to your caller or the nearest live receiver above it. When this scope has been abandoned, `scope_return` never rewinds and delivers immediately regardless of the oath field. The call ends the turn: any later `api.*` call throws.

## return.dafny

Required. A fresh, dense report: reliable deductions, verification evidence, unresolved work, and results the caller cannot recover. The new report replaces the old one on a rewind; carry forward evidence that still matters. On a seal, this text is appended to the published record. When your caller differs from your upscope, your caller does not share your upscope's context — include every fact the caller needs.

## return.oath

Required in normal mode, and exactly one of two values. `unfinished`: rewind and continue, with `dafny` replacing the record. `a_ferocious_audacious_master_would_change_nothing`: seal the record; take it only when nothing remains worth changing. At root, receive every subscope you forked first. In `ABANDONED` mode, any value (including omitted) is accepted and never rewinds.

## abandon.tool

`scope_abandon({ target, reason? })` interrupts one `running` scope at exact path `target` — never `/`, never yourself, and never a role wider than yours — and forces its next turn into `ABANDONED` mode where only `scope_return` is bound. It stays `running` briefly while writing its final `dafny`, then turns `done` without rewinding; it does not cascade to other scopes (any subscopes it owned transfer to its caller when it returns). Pass `reason` so the target knows what to preserve in `dafny` and its caller knows why it was stopped.

## join.interrupted

Join interrupted by a user message; no record was received.
Still unreceived: {{remaining}}.

## return.rewind

Rewinding to continue with your latest report. This resets the root oath streak.

## return.review

Rewinding for an independent review. Check the work against the user's requirements; seal again only if nothing remains worth changing.

## return.finish

The second consecutive seal permits the final reply. Answer the user now.

## return.pending

Subscope {{forkId}} queued for {{receiver}}; awaiting the receiver's join.
