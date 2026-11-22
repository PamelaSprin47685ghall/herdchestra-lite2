## fork.tool

Start child scopes without waiting. Receive their records with `scope_join`.

## fork.scope-id

Required name, up to 48 ASCII characters (e.g. `oh-my-pie`). Start with a letter; separate alphanumeric groups with single hyphens or underscores. `root` is reserved regardless of case. Names must be unique regardless of case within the batch and across the session, except previously deferred items. Reuse a deferred item's name when declaring it ready.

## fork.intent

Name the goal the child will make true, the surface it owns, and what a successor can accept. A closure is a goal, not an activity: "read the parser" is a waypoint; "the parser now rejects X on the sample" is done. Split where coordination cost falls faster than the work it saves; keep a shared mutable surface, an irreversible step, or one decision in one scope. Size it to finish and to be accepted.

## fork.budget

Use tool names as keys. Each assistant message spends one unit at most, split among its budgeted calls. The child's balance is separate from yours.

## fork.time

Wall-clock budget in seconds from launch. Ordinary tools get at most the remaining time plus one second. Waiting in `scope_join` or `scope_return` pauses that branch's clock.

## fork.permission

`ro` declares read-only intent; it is not a sandbox. In full flow, `rw` needs this generation's first todo submission.

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

Submit your working record and wait for the receiving parent to accept it. Any unreceived child work transfers to that parent. Put your conclusions in the record; do not send a user-facing answer. The last receipt at your level is sealed in full, with no elder report.

## return.pending

Fork {{forkId}} queued for {{receiver}}; awaiting acceptance.

## return.receipt

Fork {{forkId}} has been handed to {{receiver}}.
