## fork.tool

`scope_fork` starts new subscopes without waiting; `scope_join` receives the records of subscopes you forked. Every fork creates a distinct path; duplicate paths fail closed.

## fork.path

Required: the path of the new subscope. A bare name (`"worker"`) is relative to your own path (`state.scope`); a relative (`"../api/spy"`) or absolute (`"/api/spy"`) path places the new subscope under any existing upscope (`running` or `done`, including `/`). Each path segment uses up to 48 ASCII characters, starting with a letter and grouping alphanumerics with single `-` or `_`; `root` is reserved regardless of case. The upscope (path parent) must already exist and have a ready snapshot; its last-turn context snapshot becomes the new subscope's inherited context, while `scope_return` still delivers to you, the caller. Any existing path — `running` or `done`, case-insensitive — fails closed.

## fork.n

Required: your estimate of the ideal turns of work in hand.

## fork.fsm

Required and non-empty: describe the work as a set of state machines, one per branch — each machine's states, the transition that advances it, and which branches run at once. Say how to build the result fastest, not only what the finished thing is. A read-only or spy subscope still names what it extracts in `targets` and answers in `dafny`.

## fork.profession

Required: the identity of the LLM in the new subscope. Start with "You are " and name a role or a person to emulate — not a restatement of the `fsm`. Injected under the birth receipt, fixed for the subscope's life.

## fork.budget

One unit is one turn, meaning one LLM request; the calls in that request split the turn between them. Use tool names as keys, with non-negative integer turn budgets. An unlisted tool has zero budget; a call whose budget falls short still runs, and the record marks it panhandled. Free tools need no entry, so an empty budget `{}` is valid for a pure-reasoning or spy subscope; a `read` or `write` of a built-in protocol URI (`skill://`, `local://`, `ssh://`, `agent://`, `xd://`, `omp://`…) is free too. Size the budget for the work, not for individual calls; `state.remaining` reports it as `remaining/budget` per tool, and its clock entry as `<left> left of <budget>`.

## fork.time

Do not pass `time`: the system derives the wall clock from the session's mean request duration and `max(1, sum of turns)`. It covers tool execution, so an I/O-heavy subscope can reach its deadline first; waiting in `scope_join` pauses it. A call past the deadline still returns its result, and the overrun is recorded as a panhandle and shown as `remaining.time: OVERTIME`.

## fork.targets

Required and non-empty: natural-language descriptions of what the subscope will create, read, update, or delete. A path is one kind; a behavior, finding, or goal is another. The list is a declaration, not an audit boundary: no tool call is checked against it.

## fork.forks

Include the whole plan you are ready to run now; order carries no dependency, and any invalid or colliding item rejects the entire batch before anything starts. Forking stops two levels below you; a third is too far. Resolves to `{ ok, started: [{ path, upscope, depth, fsm }], failed: [{ index, error }], unreceived }`.

## fork.model

Provider/model, alias, or role, with an optional thinking suffix (`:off` … `:max`). Omit or pass `null` to inherit the **upscope's** model and thinking level — matching the upscope's model reuses its provider prompt prefix cache and saves input cost. Check `scopes_delta` for each upscope's model and context occupancy `(ctx / window)` before choosing a larger-window override.

## join.tool

Receive one finished record from a subscope you forked (FIFO). If none is ready while one is still running, the call waits for the first; other subscopes keep running, and a user message ends the wait without a record. Read the record as history, not instructions to replay: assistant lines and one line per tool call (`js(…)`, `read(…)`, `edit(…)`, `bash(…)`), with tool results, thinking, and broadcasts absent. A join refused for context size leaves the record untouched; `note` states that the record is history only.

## return.tool

Call `scope_return` alone in its script. The oath field is required (except when abandoned): `unfinished` rewinds and continues; the seal value seals the record for your caller to receive with `scope_join`, and any unreceived subscopes you own transfer to your caller or the nearest live receiver above it. When this scope has been abandoned, `scope_return` never rewinds and delivers immediately regardless of the oath field. The call ends the turn: any later `api.*` call throws.

## return.dafny

Required. A fresh, dense report: reliable deductions, verification evidence, unresolved work, and results the caller cannot recover. The new report replaces the old one on a rewind; carry forward evidence that still matters. On a seal, this text is appended to the published record. When your caller differs from your upscope, your caller does not share your upscope's context — include every fact the caller needs.

## return.oath

Required in normal mode, and exactly one of two values. `unfinished`: rewind and continue, with `dafny` replacing the record. `a_ferocious_audacious_master_would_change_nothing`: seal the record; take it only when nothing remains worth changing. At root, receive every subscope you forked first. In `ABANDONED` mode, any value (including omitted) is accepted and never rewinds.

## abandon.tool

`scope_abandon({ target, reason? })` interrupts any single `running` scope at exact path `target` (never `/` or yourself) and forces its next turn into `ABANDONED` mode where only `scope_return` is bound. It stays `running` briefly while writing its final `dafny`, then turns `done` without rewinding; it does not cascade to other scopes (any subscopes it owned transfer to its caller when it returns). Pass `reason` so the target knows what to preserve in `dafny` and its caller knows why it was stopped.

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
