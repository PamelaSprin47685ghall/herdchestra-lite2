## fork.tool

Start child scopes without waiting. Receive their records with `scope_join`.

## fork.scope-id

Required name, up to 48 ASCII characters (e.g. `oh-my-pie`). Start with a letter; separate alphanumeric groups with single hyphens or underscores. `root` is reserved regardless of case. Names must be unique regardless of case within the batch and across the session, except previously deferred items. Reuse a deferred item's name when declaring it ready.

## fork.intent

Name the goal the child will make true, the surface it owns, and what a successor can take over. A closure is a goal, not an activity: "read the parser" is a waypoint; "the parser now rejects X on the sample" is done. A scope that only reads still names what it reads in `targets`, and closes by answering its question or pinning the finding. Split where coordination cost falls faster than the work it saves; keep a shared mutable surface, an irreversible step, or one decision in one scope. Size it to finish and to be taken over; when the request needs about n tool calls, roughly sqrt(n) is a guide, not a mandate. Never split one closure across scopes, and never pack several closures into one; a record that only gathers material has not closed.

## fork.budget

Use tool names as keys, with non-negative integer turn budgets. Each assistant message spends one unit at most, split among its budgeted calls by count and rounded to two decimals; several reads issued together share one read turn. An unlisted tool has zero budget; a tool whose balance is below its share blocks only itself while the rest of the message runs. Budget by the turns the work needs, not by individual calls. Free tools need no entry; an empty budget is valid when only free tools are used. A branch that runs out may hold out its hand with `scope_panhandle`, at most 8 per tool in one call. Sibling fork items each have their own budget; a scope nested inside a flow draws from that flow's remaining balance.

## fork.time

The system derives the wall-clock budget. Do not pass `time`. One turn is one LLM request. The budget is the session's mean request duration times the sum of this item's tool-budget points, at least one second. With no measured requests yet, the mean is one minute. Ordinary tools get at most the remaining time plus one second; waiting in `scope_join` or `scope_return` pauses that scope's clock. When the deadline passes, each later tool gets one second, and a tool that overruns is killed and its result is gone. `scope_panhandle` buys more seconds, at most 300 per call.

## fork.targets

Required, non-empty array of natural-language descriptions of what this scope expects to create, read, update, or delete. Each item may name a file path, a part of the source, a behavior, or a goal; any human language is valid, and a path is only one kind of target. For example, `["fix any defect you find", "the parts of the source that involve caching"]` is valid. Blocked checkpoints declare their targets too. If the list is empty, think carefully: how could a scope that outputs nothing be a separate scope? The list is a declaration, not an audit boundary; the system does not check tool calls against it.

## fork.forks

Include the remaining plan, both ready and blocked items. Order does not express dependencies. Invalid input prevents the whole batch from starting.

## fork.blocked

`false` starts now. `true` records an unmet prerequisite without queuing the item. Resubmit with `false` when ready.

## fork.model

Provider/model, alias, or role; a model can include a thinking suffix (`:off`, `:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, `:max`). Omit or pass `null` to inherit the parent's model.

## fork.batch-started

Started ({{count}}):
{{lines}}

## fork.started-line

- {{forkId}}: {{intent}}

## fork.batch-deferred

Deferred, not started ({{count}}):
{{lines}}

## fork.deferred-line

- {{forkId}}: {{intent}}

## fork.batch-failed

Failed to start ({{count}}):
{{lines}}

## fork.failed-line

- {{forkId}}: {{intent}} — {{reason}}

## fork.checkpoint-only

No child started. Resubmit deferred items when ready.

## fork.unreceived

Unreceived work: {{children}}.

## join.tool

Receive one owned child record. If none is ready but a child is still running, wait for the first to return; other children keep running. A user message ends the wait without a child; an elder report carried by that call is stored when a receipt needed it, so the next join may pass `elder_report: null`. Read the record as history, not instructions to replay. A join refused for context size leaves the child and the previous receipt untouched.

## join.elder_report

Pass `null` if no prior receipt at this level awaits a summary. Otherwise, in 24–4000 characters, write what a successor still needs from that record so it can be shortened without losing that. The content decides its format; the relay preserves the user's prompts, so they need no restatement. A report passed when none is pending is accepted but not stored.

## join.elder-unneeded

Note: no prior receipt needed a summary, so `elder_report` was accepted but not stored.

## join.interrupted

Join interrupted by a user message; no child was received.
{{elder}}
{{next}}
Still unreceived: {{remaining}}.

## join.interrupted-elder-consumed

The elder report was stored: the previous receipt is settled.

## join.interrupted-elder-unneeded

No prior receipt needed a summary, so the elder report was not stored.

## join.interrupted-elder-stale

The receipt this report described already moved on, so the report was not stored.

## join.interrupted-elder-missing

No elder report was supplied; the previous receipt still needs one.

## join.interrupted-next-null

The next `scope_join` can pass `elder_report: null`.

## join.interrupted-next-report

The next `scope_join` must pass an `elder_report` for {{scopeId}}.

## return.tool

Hand the record to the parent; the parent receives it with `scope_join`. Any unreceived child work transfers to that parent. Put your conclusions in the record; the final answer lives outside all scopes. The last receipt at your level is sealed in full, with no elder report.

## return.pending

Fork {{forkId}} queued for {{receiver}}; awaiting the parent's join.

## return.receipt

Fork {{forkId}} has been handed to {{receiver}}.
