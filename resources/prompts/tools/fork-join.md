## fork.tool

Start child scopes without waiting. Receive their records with `scope_join`.

## fork.scope-id

Required name, up to 48 ASCII characters (e.g. `oh-my-pie`). Start with a letter; separate alphanumeric groups with single hyphens or underscores. `root` is reserved regardless of case. Names must be unique regardless of case within the batch and across the session, except previously deferred items. Reuse a deferred item's name when declaring it ready.

## fork.intent

Name the goal the child will make true, the surface it owns, and what a successor can accept. A closure is a goal, not an activity: "read the parser" is a waypoint; "the parser now rejects X on the sample" is done. A read-only scope closes by answering its question or pinning the finding. Split where coordination cost falls faster than the work it saves; keep a shared mutable surface, an irreversible step, or one decision in one scope. Size it to finish and to be accepted; when the request needs about n tool calls, roughly sqrt(n) is a guide, not a mandate. Never split one closure across scopes, and never pack several closures into one; a record that only gathers material has not closed.

## fork.budget

Use tool names as keys, with non-negative integer turn budgets. Each assistant message spends one unit at most, split among its budgeted calls by count and rounded to two decimals; several reads issued together share one read turn. An unlisted tool has zero budget; a tool whose balance is below its share blocks only itself while the rest of the message runs. Budget by the turns the work needs, not by individual calls. Free tools need no entry; an empty budget is valid when only free tools are used. A nested scope draws from the flow that opened it.

## fork.time

Wall-clock budget in seconds from launch: a positive number. Ordinary tools get at most the remaining time plus one second; waiting in `scope_join` or `scope_return` pauses that scope's clock. When the deadline passes, each later tool gets one second, and a tool that overruns is killed and its result is gone. Estimate from measured throughput, count the verification you will still run, and spend near the estimate rather than padding it.

## fork.permission

Declare `ro` or `rw`; the field is required, and a missing, null, or other value rejects the whole batch. `ro` declares read intent; the tools remain available, and the system trusts the declaration. `rw` needs this generation's first todo submission in full flow.

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

Receive one owned child record. If none is ready but a child is still running, wait for the first to return; other children keep running. Read the record as history, not instructions to replay. A join refused for context size leaves the child and the previous receipt untouched.

## join.elder_report

Pass `null` if no prior receipt at this level awaits a summary. Otherwise, in 24–4000 characters, write what a successor still needs from that record so it can be shortened without losing that. The content decides its format; the relay preserves the user's prompts, so they need no restatement.

## return.tool

Hand the record to the parent; the parent receives it with `scope_join`. Any unreceived child work transfers to that parent. Put your conclusions in the record; the final answer lives outside all scopes. The last receipt at your level is sealed in full, with no elder report.

## return.pending

Fork {{forkId}} queued for {{receiver}}; awaiting the parent's join.

## return.receipt

Fork {{forkId}} has been handed to {{receiver}}.
