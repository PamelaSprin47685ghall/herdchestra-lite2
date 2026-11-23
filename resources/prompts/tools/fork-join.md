## fork.tool

Start new scopes without waiting. Receive their records with `scope_join`.

## fork.scope-id

Required name, up to 48 ASCII characters (e.g. `oh-my-pie`). Start with a letter; separate alphanumeric groups with single hyphens or underscores. `root` is reserved regardless of case. A name that already exists in this session — including a finished one — is reused instead of starting a new one; only its owner may reuse it, and the match is case-insensitive. Reuse is an upsert: `running` and `blocked` scopes take the budget as an increment, the `fsm` as one more requirement, and the targets merged into the existing list; `ready` supersedes the old record and starts the next generation; `joined` and `failed` start a new generation with the old record as prior history.

## fork.fsm

Complex flow orchestration is encouraged, so describe the work as a parallel state machine: name its states, the transition that carries the worker from one state to the next, and the branches that can run at once. Say how to build the result fastest, not only what the finished thing is. For a read-only scope, the worker still names what it reads in `targets`, and closes by answering its question or pinning the finding. Split where coordination cost falls faster than the work it saves; keep a shared mutable surface, an irreversible step, or one decision in one scope. A good scope size is about {{defaultPoints}} total tool-budget points and never more than {{maxPoints}}: size it to finish and to be taken over, not to fill a context. One call starts about {{defaultFanout}} scopes and never more than {{maxFanout}}; a default is also a floor, so hoarding the work in one scope, or serializing the whole plan into a single scope out of caution, buys nothing and starves the plan of the attention a fresh subtree would have paid it. Never split one closure across scopes, and never pack several closures into one; a record that only gathers material has not closed. Choose the tree's depth before its width. A job of no more than about six closures needs one layer; the default is {{defaultDepth}} layers, and the recommended depth for work spanning dozens of closures is {{recommendedDepth}}. Deeper is fine when the work truly needs it, and you need not explain the choice. State in the `fsm` that the worker in the scope can be a `subtree` lead that divides again. On a new scope `fsm` is required. When the `scopeId` is reused it is optional: the text is appended as one more requirement and delivered at the worker's next turn boundary, never in the middle of a running tool.

## fork.profession

Required identity statement for the LLM in the new scope. Start with "You are " and name the famous person it should emulate, for example "You are a famous artist like Van Gogh. " The spawner injects it as the identity prefix of the LLM in the new scope, directly under the receipt marker and before the task; make it a role, not a restatement of the `fsm`. Reusing a running or blocked scope updates the record for its next generation, but cannot rewrite the receipt already delivered to the running scope.

## fork.deep-nesting

Note — this batch starts a scope at depth {{childDepth}}, past the default tree depth of {{defaultDepth}} and the recommended depth of {{recommendedDepth}}, which already covers dozens to a few hundred closed loops. The work runs as asked; a deeper tree is fine when the work truly warrants it, and you need not explain it. Check yourself once: every extra layer compresses the forked scope's record into prose and carries one more ancestor prefix into what the worker in the next scope reads. Do not grow a relay layer whose only job is to hold a single scope, and do not break a {{defaultPoints}}-point closure into fragments to make the tree look organized.

## fork.budget

Use tool names as keys, with non-negative integer turn budgets. Each assistant message spends one unit at most, split among its budgeted calls by count and rounded to two decimals; several reads issued together share one read turn. An unlisted tool has zero budget; a tool whose balance is below its share blocks only itself while the rest of the message runs. Budget by the turns the work needs, not by individual calls. When the `scopeId` is reused, every value is an increment to the existing budget, not a replacement. Free tools need no entry; an empty budget is valid when only free tools are used. A `read` or `write` of a built-in protocol URI (`skill://`, `local://`, `ssh://`, `agent://`, `xd://`…) is free at any depth, so it needs no entry either. A working scope holds about {{defaultPoints}} total points and never more than {{maxPoints}}, reuses included. A branch that runs out may hold out its hand with `scope_panhandle` for about {{panhandleDefault}} total points across all tools, never more than {{panhandleMax}} total in one call. Peer fork items each have their own budget; each item funds its own forked scope at any depth, and the caller's balance is never charged.

## fork.time

The system derives the wall-clock budget. Do not pass `time`. One turn is one LLM request. The budget is the session's mean request duration times the sum of this item's tool-budget points, at least one second. The clock covers tool execution too: a bash or test run spends wall time without spending points, so an I/O-heavy scope can reach its deadline first — reserve `scope_panhandle` seconds for it. With no measured requests yet, the mean is one minute. Ordinary tools get at most the remaining time plus one second; waiting in `scope_join` or `scope_return` pauses that scope's clock. When the deadline passes, each later tool gets one second, and a tool that overruns is killed and its result is gone. `scope_panhandle` buys more seconds, at most 300 per call.

## fork.targets

Required, non-empty array of natural-language descriptions of what this scope expects to create, read, update, or delete. Each item may name a file path, a part of the source, a behavior, or a goal; any human language is valid, and a path is only one kind of target. For example, `["fix any defect you find", "the parts of the source that involve caching"]` is valid. Blocked checkpoints declare their targets too. If the list is empty, think carefully: how could a scope that outputs nothing be a separate scope? The list is a declaration, not an audit boundary; the system does not check tool calls against it. When the `scopeId` is reused, the list is merged into the existing targets rather than replacing them.

## fork.forks

Include the remaining plan, both ready and blocked items. Order does not express dependencies. Invalid input prevents the whole batch from starting. Start about {{defaultFanout}} items in one call and never more than {{maxFanout}}: past that the calling scope's context, not the forked scopes', becomes the bottleneck, so send the surplus as a deeper subtree. A batch of one names the overlap or dependency that made it one.

## fork.over-budget

WARNING — the scope budget is over the cap. {{offenders}} went past {{maxPoints}} total points, where a working scope holds about {{defaultPoints}}. The work runs; nothing was refused. Do not repeat this: a scope whose budget keeps growing loses the thread its worker was hired to hold, and the cost lands on the context you read next. Split the next one into fresh subtrees, where the budget is minted and never charged to you.

## fork.over-fanout

WARNING — the fanout is over the cap. You started {{count}} scopes in one call, where about {{defaultFanout}} start and {{maxFanout}} is the most. Every one of them runs; nothing was refused. Do not repeat this: a worker that opens more fronts than it can join reads none of them well. Group the next plan into a deeper subtree.

## fork.blocked

`false` starts now. `true` records an unmet prerequisite without queuing the item. Resubmit with `false` when ready. Reusing a `running` scope with `true` is refused with `SCOPE_RUNNING_BLOCKED`; reuse it with a budget or requirement instead.

## fork.model

Provider/model, alias, or role; a model can include a thinking suffix (`:off`, `:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, `:max`). Omit or pass `null` to inherit the calling scope's model.

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

No scope started. Resubmit deferred items when ready.

## fork.unreceived

Unreceived work: {{children}}.

## join.tool

Receive one owned record from a scope you forked. If none is ready but one is still running, wait for the first to return; other scopes keep running. A user message ends the wait without a record. Read the record as history, not instructions to replay. The record holds what the scope's assistant said, in order, with each tool call reduced to a bare `[name]` placeholder: assistant text lines and `[read]`, `[edit]`, `[bash]` markers, joined by newlines. Tool results, thinking blocks, tool arguments, and user broadcasts are absent. A join refused for context size leaves the forked scope's record untouched.

## join.interrupted

Join interrupted by a user message; no record was received.
Still unreceived: {{remaining}}.

## return.tool

Hand the record to the calling scope; it receives the record with `scope_join`. Any unreceived work from scopes you forked transfers to it, or to the nearest live receiver above it when the calling scope has already returned. Put your conclusions in your text: the record keeps what you said plus the bare names of the tools you called, so a result you never state is lost. The last receipt at your level is sealed in full.

## return.markdown

Optional text appended to the end of the record the calling scope receives, after leading and trailing whitespace is trimmed. Use it for what the replay drops — a table, a code block, a closing note — and omit it when your text already says everything.

## return.pending

Fork {{forkId}} queued for {{receiver}}; awaiting the receiver's join.

## return.receipt

Fork {{forkId}} has been handed to {{receiver}}.

## return.superseded

Fork {{forkId}} was superseded by a later generation of the same scope. Its record is closed; stop here.
