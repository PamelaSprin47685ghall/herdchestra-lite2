## fork.tool

Start new scopes without waiting; receive their records with `scope_join`. A split costs you almost nothing; the serialized job costs you the critical path, and you pay that part alone. Split when you hold two things that do not depend on each other; when you hold one, do it yourself. Ask for reliable deductions, not for verbatim boring chronicle, or even better, ask to do, not to say. Side Effects are all you need. Every fork starts a new scope: to talk to one that already exists, call `scope_send`.

## fork.scope-id

Required name, up to 48 ASCII characters (e.g. `oh-my-pie`). Start with a letter; separate alphanumeric groups with single hyphens or underscores. `root` is reserved regardless of case. A name is unique among its siblings only: the same name under two different parents names two unrelated scopes. When a sibling already holds the name — running, finished, or reserved earlier in this same batch — registration appends the lowest free numeric suffix (`worker` → `worker-2` → `worker-3`). The fork receipt and the child's start receipt both show the final name and its path (`/api/worker-2`), and that path is the address `scope_send` takes.

## fork.n

Required on every item: your estimate of the ideal turns of work in hand for this scope, the `n` that `resources/prompts/system.md` §Run scopes sizes a scope from. Provided for later audit; the number is for you — a number you cannot write is a scope you have not thought through.

## fork.fsm

Required: give the work a non-empty description, or the station refuses the item with `MISSING_FSM`. Complex flow orchestration is encouraged, so describe the work as a set of state machines, one per branch: name each machine's states, the transition that advances it, and which branches run at once. Say how to build the result fastest, not only what the finished thing is. For a read-only scope, the worker still names what it reads in `targets`, and closes by answering its question or pinning the finding. Split where coordination cost falls faster than the work it saves. State in the `fsm` that the worker in the scope can be a `subtree` lead that divides again.

## fork.profession

Required identity statement for the LLM in the new scope. Start with "You are " and name the famous person it should emulate, for example "You are a famous artist like Van Gogh. " The spawner injects it as the identity prefix of the LLM in the new scope, directly under the receipt marker and before the task; make it a role, not a restatement of the `fsm`. A running scope's receipt is fixed; a later message cannot rewrite it.

## fork.budget

This field is named `budget`; one unit of it is one turn. Use tool names as keys, with non-negative integer turn budgets. Each assistant message spends one turn at most, split among its calls by count and rounded to two decimals; several reads issued together share one read turn. An unlisted tool has zero budget; a tool whose budget falls short still runs its call, and the receipt records that call as panhandled. Size the budget for the work the scope must do, not for individual calls. A later `scope_send` may add turns to this scope, and its numbers are increments to what is left, not a replacement. Free tools need no entry; an empty budget is valid when only free tools are used. A `read` or `write` of a built-in protocol URI (`skill://`, `local://`, `ssh://`, `agent://`, `xd://`…) is free at any depth, so it needs no entry either. A scope that runs out keeps working: the call lands, and the receipt says the call was panhandled. Peer fork items each have their own budgets; each item funds its own forked scope at any depth, and the caller's budget is never charged. Size the entry from `n`, as the operating rules say.

## fork.time

The system derives the wall clock. Do not pass `time`. One turn is one LLM request. That time is the session's mean request duration times the sum of this item's turns, at least one second. The clock covers tool execution too: a bash or test run spends wall time without spending turns, so an I/O-heavy scope can reach its deadline first. With no measured requests yet, the mean is one minute. Ordinary tools carry no deadline limit; waiting in `scope_join` or `scope_return` pauses that scope's clock. A call that runs past the deadline still returns its result; the overrun is recorded as a panhandle and shown on the record.

## fork.targets

Required, non-empty array of natural-language descriptions of what this scope expects to create, read, update, or delete. Each item may name a file path, a part of the source, a behavior, or a goal; any human language is valid, and a path is only one kind of target. For example, `["fix any defect you find", "the parts of the source that involve caching"]` is valid. If the list is empty, think carefully: how could a scope that outputs nothing be a separate scope? The list is a declaration, not an audit boundary; the system does not check tool calls against it. A later message cannot change it; fork a new scope for work the list does not cover.

## fork.forks

Include the whole plan you are ready to run now. Order does not express dependencies. Invalid input prevents the whole batch from starting.

## fork.model

Provider/model, alias, or role; a model can include a thinking suffix (`:off`, `:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, `:max`). Omit or pass `null` to inherit the calling scope's model.

## fork.batch-started

Started ({{count}}):
{{lines}}

## fork.started-line

- {{forkId}}: {{fsm}}

## fork.batch-failed

Failed to start ({{count}}):
{{lines}}

## fork.failed-line

- {{forkId}}: {{fsm}} — {{reason}}

## fork.unreceived

Unreceived work: {{children}}.

## send.tool

Send a message to another scope, by path. `target` takes `.` for yourself, `..` for the parent, a relative name, an absolute `/a/b`, `/` for the root, or a wildcard: `*` for the direct children of a path, `**` for every scope under it. A wildcard reaches active scopes only, so it never wakes a finished one; an exact path may name a finished scope, and naming it wakes it. The message arrives as `[Message from <your path>]` followed by your text, so the reply is another `scope_send` to that path: the receiver already sees the scope tree, and the envelope already says who you are. A message to a running scope waits in its inbox and is read at its next turn boundary; a message to the root reaches the holder at once.

## send.target

One path or an array of paths, each resolved against your own path. A pattern never matches your own scope. An exact path that names no scope is refused with `UNKNOWN_SCOPE_TARGET`; a pattern that matches nothing is refused with `NO_MATCHING_SCOPES`.

## send.message

The text the target receives, after the sender envelope. State the request or the answer. A scope that has already returned gets no return nudge, so it finishes by stopping: make the message self-contained.

## send.budget

Optional turn increment for each target, in the shape a fork's `budget` takes: tool names as keys, non-negative integers. The numbers are added to what the target has left, so a scope that ran out can be financed this way. Ignored for `/`, which has no budget.

## join.tool

Receive one owned record from a scope you forked. If none is ready but one is still running, wait for the first to return; other scopes keep running. A user message ends the wait without a record. Read the record as history, not instructions to replay. The record holds what the scope's assistant said, in order, with one line per tool call written as `name(key="value", ...)`: assistant text lines and `read(path="a.mjs:1-20")`, `edit(path="b.mjs")`, `bash(command="ls -la")` lines, joined by newlines. A string argument is quoted, any other value is compact JSON, and no argument is truncated or filtered. Tool results, thinking blocks, and user broadcasts are absent. A join refused for context size leaves the forked scope's record untouched. Waiting for the whole set buys nothing: the records do not depend on each other, and each one already carries the whole of what that scope said. Before join over and over again, call fork. Just fork more and more. The longer the wait, the more likely you are to experience negative emotions such as boredom, frustration, and anger. Instead, call fork instead of join.

## join.interrupted

Join interrupted by a user message; no record was received.
Still unreceived: {{remaining}}.

## return.tool

Call alone in its tool-call batch. Omit the oath to rewind and continue. A child taking the oath seals its record for the parent to receive with `scope_join`. Unreceived descendants move to the parent or nearest live receiver above it. A woken scope forwards `dafny` to its parent instead of sealing or rewinding.

## return.dafny

Required. Write a fresh, dense report of reliable deductions, verification evidence, unresolved work, and results the caller or next context cannot recover. The new report replaces the old one on a rewind; carry forward evidence that still matters. On a child seal, this text is trimmed and appended to the published record; do not restate what the replay already carries.

## return.oath

Optional. Give only `a_ferocious_audacious_master_would_change_nothing` when nothing remains worth changing; omit this field for a small rewind. At root, receive every outstanding child before taking the oath.

## return.rewind

Rewinding to continue with your latest report and pins. This resets the root oath streak.

## return.review

Rewinding for an independent review. Check the work against the user's requirements; take the oath again only if nothing remains worth changing.

## return.finish

The second consecutive oath permits the final reply. Answer the user now.

## return.pending

Fork {{forkId}} queued for {{receiver}}; awaiting the receiver's join.

## return.receipt

Fork {{forkId}} has been handed to {{receiver}}.
