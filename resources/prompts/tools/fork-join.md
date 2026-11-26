## fork.tool

`scope_fork` starts new scopes without waiting; `scope_join` receives their records. Ask for results, not for a chronicle: side effects are all you need. To reach a scope that already exists, call `scope_request`; a fork always starts a new one.

## fork.scope-id

Required, up to 48 ASCII characters, starting with a letter and grouping alphanumerics with single `-` or `_`. A name is unique among the scopes at the same level only: the same name under two different scopes names two unrelated scopes. When a scope at that level already holds the name, registration appends the lowest free numeric suffix (`worker` → `worker-2`), and the result's `started` entry reports the final path that `scope_request` takes. `root` is reserved regardless of case.

## fork.n

Required: your estimate of the ideal turns of work in hand.

## fork.fsm

Required and non-empty: describe the work as a set of state machines, one per branch — each machine's states, the transition that advances it, and which branches run at once. Say how to build the result fastest, not only what the finished thing is. A read-only scope still names what it reads in `targets` and answers in `dafny`.

## fork.profession

Required: the identity of the LLM in the new scope. Start with "You are " and name a role or a person to emulate — not a restatement of the `fsm`. The spawner injects it under the receipt marker, fixed for the scope's life.

## fork.budget

One unit is one turn, meaning one LLM request; the calls in that request split the turn between them. Use tool names as keys, with non-negative integer turn budgets. An unlisted tool has zero budget; a call whose budget falls short still runs, and the record marks it panhandled. Free tools need no entry, so an empty budget is valid when the scope uses only free tools; a `read` or `write` of a built-in protocol URI (`skill://`, `local://`, `ssh://`, `agent://`, `xd://`, `omp://`…) is free too and needs no entry either. Size the budget for the work, not for individual calls; `state.remaining` reports it as `remaining/budget` per tool.

## fork.time

Do not pass `time`: the system derives the wall clock from the session's mean request duration and this item's turns. It covers tool execution, so an I/O-heavy scope can reach its deadline first; waiting in `scope_join`, `scope_request`, or `scope_return` pauses it. A call past the deadline still returns its result, and the overrun is recorded as a panhandle and shown as `remaining.time: OVERTIME`.

## fork.targets

Required and non-empty: natural-language descriptions of what the scope will create, read, update, or delete. A path is one kind; a behavior or a goal is another. The list is a declaration, not an audit boundary: no tool call is checked against it, and a later message cannot change it.

## fork.forks

Include the whole plan you are ready to run now; order carries no dependency, and invalid input prevents the batch from starting. The call resolves to `{ ok, started: [{ path, depth, fsm }], failed: [{ index, error }], unreceived }`: read `started` for the paths you now own.

## fork.model

Provider/model, alias, or role, with an optional thinking suffix (`:off` … `:max`). Omit or pass `null` to inherit the calling scope's model.

## join.tool

Receive one owned record. If none is ready but one is still running, the call waits for the first; other scopes keep running, and a user message ends the wait without a record. Read the record as history, not instructions to replay: assistant lines and one line per tool call (`js(…)`, `read(path="a.mjs:1-20")`, `edit(path="b.mjs")`), with tool results, thinking, and broadcasts absent. A join refused for context size leaves the record untouched; `note` states that the record is history only.

## request.tool

Ask an existing scope and wait for its reply in the same script: `const { reply } = await api.scope_request({ target: "/api", message: "…" })`. The target answers in one reply turn. Use it for facts and decisions you cannot recover; use `scope_join` for a record. A cycle of scopes waiting on each other is refused at the call, not deadlocked. Resolves `{ ok, from, reply }`.

## request.target

One exact path, resolved against your own: `..` for the scope above you, a name, or `/a/b`. No wildcards and no self-target; to ask several scopes, ask them in parallel with `Promise.all`.

## request.message

State what you need so the answer can be one short string; the target sees your question, not your context.

## request.interrupt

`true` cuts the target off now and makes it answer; `false`, the default, lets the question land at its next request. Interrupt only when the answer gates your next move.

## reply.tool

Call once with a string while in `AWAITING_REPLY`: the requester's `scope_request` resolves with exactly it, and the mode lifts.

## return.tool

Call `scope_return` alone in its script. Omit the oath to rewind and continue. A scope taking the oath seals its record for the scope that started it to receive with `scope_join`, and unreceived scopes below it move to that scope or the nearest live receiver above it. The call ends the turn: any later `api.*` call throws.

## return.dafny

Required. A fresh, dense report: reliable deductions, verification evidence, unresolved work, and results the caller cannot recover. The new report replaces the old one on a rewind; carry forward evidence that still matters. On a seal, this text is appended to the published record, so do not restate what the replay already carries.

## return.oath

Optional, and only when nothing remains worth changing. At root, receive every scope you forked first.

## join.interrupted

Join interrupted by a user message; no record was received.
Still unreceived: {{remaining}}.

## abandon.tool

`scope_abandon({ target })` closes one exact scope this scope forked when it will not return. The bracket closes as failed, the scopes below it close with it, its agent stops, and a join that is waiting takes the failure. A user message ends a parked join without a record and leaves that scope running; close it with `scope_abandon` when its work is no longer owed. `target` is the exact path of a scope this scope forked directly, never a wildcard; the record is kept so the join can report it.

## return.rewind

Rewinding to continue with your latest report. This resets the root oath streak.

## return.review

Rewinding for an independent review. Check the work against the user's requirements; take the oath again only if nothing remains worth changing.

## return.finish

The second consecutive oath permits the final reply. Answer the user now.

## return.pending

Fork {{forkId}} queued for {{receiver}}; awaiting the receiver's join.
