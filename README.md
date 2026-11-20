# Herdchestra Lite 2

Herdchestra Lite 2 adds budgeted work scopes to omp. A scope opens as a fission batch of one or more flows, controls which tools can run and how many times they can run in each flow, and closes with `scope({ end: true })`.

When a scope folds, its user messages move before its opening `scope` call. Their content and order stay intact. The scope summary records outcomes and remaining work without repeating those messages.

## Fission batches

`scope({ begin: { stage, elder_report, fission: [{ intent, budget, permission }] } })` opens one batch of flows. `begin.fission` is a non-empty array; there is no single-flow begin shape, so one flow is a one-item array. `begin.stage` covers the whole batch, `begin.elder_report` is required (a string or `null`), and each item carries its own `intent`, `budget`, `permission`, and optional `model`. The entire array is validated before any flow starts: one invalid item rejects the whole batch and opens nothing.

A fission begin currently cannot also close a scope. `scope({ begin, end: true })` is refused before any state change; close the open scope with a plain `scope({ end: true })` call, then open the batch in a following call. A flow does not open or close its own scope — the scheduler writes both ends.

`scope({ begin })` is also an execution barrier. Tool calls listed after it in the same assistant message run once on the owner, and their results are copied into every flow in the batch; calls listed before it run first in the outer context. `amend` is available inside every flow: it edits that flow's own record, refunds its budget, and never rewrites the shared journal. A beat revoked by `amend` is not copied into a sibling flow, and a flow cannot amend across its own begin or a closed sibling boundary.

## Running from source

omp loads the installed copy at `~/.omp/plugins/node_modules/herdchestra-lite2`, not this working tree, so an edit here does not reach a running session by itself. After changing `src/` or `resources/`:

```sh
bun run sync:plugin                    # copy src/ and resources/ into the installed plugin
bun scripts/sync-plugin.mjs --check    # report drift without copying
bun run smoke:relay                    # prove the current build's tool text and gates
```

Restart the session afterwards; modules load at process start. A `todo` result that shows a `Flow:` line comes from the current build, so a missing `Flow:` line means the session is still running an older copy.

`bun run smoke:relay` answers that question without a restart. It loads this
working tree, activates the extension against a fake host, and drives the
registered `todo` and `scope` tools: it asserts the `Flow:` lines, the empty
ledger's relay handoff, the promoted successor's return to simple mode, and both
directions of the `direct-execution` gate. A build that emits no `Flow:` line
exits non-zero, so a stale copy cannot pass quietly.

## Stages

Every `scope({ begin })` batch names one `begin.stage`, shared by all its flows. The innermost open scope determines the current stage; outside all scopes there is no stage.

## Design records

The contract lives here. The reasoning behind it lives in three places:

- [Stage design](docs/design/stages.md) — why the five stages exist, and the line between designing the artifact and designing the work.
- [ADR 0001: stage names](docs/adr/0001-stage-names.md) — the S1–S5 renaming, kept as history only.
- [Changelog](CHANGELOG.md) — what changed and how to migrate.

| Stage | Question | Allowed when |
|---|---|---|
| `decision-framing` | Why: intent, non-goals, the decision and its bounds | Herd mode only |
| `acceptance-cases` | Experience: what the user will live through, as cases with a 0-100 rubric | Default mode |
| `architecture-design` | What: the artifact's structure, boundaries, and contracts | Default mode |
| `orchestration-plan` | How: the process of completing the work, as literate pseudocode | Default mode |
| `direct-execution` | Do: implement, run the real checks, accept, deliver | Default mode |

In default mode the four non-framing stages may be opened in any order, repeated, or revisited; no stage gates another. While herd mode is on, only `decision-framing` may open.

### Stage flags

`acceptance-cases`, `architecture-design`, and `orchestration-plan` each start
false. Opening one turns its flag true. In the full flow, `direct-execution` may
open only when all three are true; it never clears them, so execution may run
again. Opening
`decision-framing` clears all three, because a new decision starts a new line of
work. A relay handoff also clears all three, in the same transaction that
advances the generation: a successor must run the stages itself, because the
predecessor's runs prove nothing about its intent. The flags persist with the
session and survive compaction, but never a handoff.

### Full flow and simple mode

A session starts simple: a clear task that needs no orchestration opens
`direct-execution` directly, with `"rw"` and without the stage flags. The first
submitted `todo` ledger, empty or not, turns the full flow on: the stage flags,
the five-stage protocol, and the relay all apply from then on. The flow stays on
across handoffs; only the promoted second empty evaluation ends it. After that a
new task is simple again, until another ledger is submitted, empty or not; that
submission turns the full flow back on without re-arming a handoff. A `todo`
view never turns the flow on.

The flags describe the main session's own work line. Subagent sessions, read-only
and read-write alike, are exempt from the ordering gate: they may open any stage
in any order, repeat it, or move backward, and they never write the flags.

Model-facing text lives in `resources/prompts/` as Markdown documents with
`## section` blocks. Code loads them through `src/prompts/index.mjs`; no prompt,
tool description, parameter description, receipt, or model-facing error is
duplicated in source.

Open order is nevertheless a principle, not a prohibition: the work runs `acceptance-cases`, then `architecture-design`, then `orchestration-plan`, and only then `direct-execution`. Each stage leaves its artifact on disk and pins its path, the plan maximizes genuine parallelism, and execution follows the plan rather than deciding the design a second time. The freedom to jump serves exploration, rework, and repair; it is not a license to skip.

The stage sections for `decision-framing`, `acceptance-cases`, `architecture-design`, and `orchestration-plan` live in the system prompt as a stable prefix, so a provider can reuse its prompt cache. A begin receipt only names its stage; it does not repeat the prompt text. `direct-execution` has no section: it follows the `orchestration-plan` artifact.

## Scope permission

Every fission item declares its own `permission: "ro" | "rw"`, and the field is required: a missing, `null`, or other value rejects the whole batch, so forgetting the declaration cannot bypass the gate.

`"ro"` is a declaration, not an enforcement boundary. A flow that says `"ro"` is trusted: the system never blocks a tool because the scope called itself read-only, and it never audits a tool call against the claim. Mistake-proofing lives in the required field and in the two `"rw"` refusals below; what a flow *does* with the tools it already holds stays a matter of the flow's own discipline.

`"rw"` is refused in two cases:

- the batch's stage is `decision-framing`, which answers why rather than what;
- in the full flow, the relay has not recorded its first submitted `todo` ledger for the current generation. A `todo` view is a read-only inspection and does not count.

A refused batch changes no state, and no flow starts. Submit a ledger first, or open the flows with `"ro"`.

## Herd mode

Herd mode is toggled only by the user, with `/herd`. No stage or model turn can enter or leave it.

A bare `/herd` flips the mode and sends nothing to the model: the next request learns the new mode from its receipt. `/herd <text>` is that same flip followed by one plain user message carrying `<text>`, so the model starts exactly one turn and reads the sentence as the user's request.

- While it is on, new scopes may open only `decision-framing`, `ask` is allowed inside that scope, and a turn may end naturally to wait for the user. The relay's stop rules stay suspended until the user toggles herd mode off.
- While it is off, `decision-framing` cannot open, `ask` is always blocked, and the relay's ledger and handoff rules run as usual.

`ask` needs both conditions: herd mode on, and the innermost scope's stage `decision-framing`.

## Pinned context

`pin` records durable notes: assumptions, deductions, inductions, findings, and conclusions. Each call appends one record to the session state and costs no budget. Pins survive scope collapse because they belong to the session, not to a scope.

At a relay handoff, every historical pin is written into the successor's opening text under `## Pinned Context`. The successor is told to read each important document named there with `read`, in full, rather than substituting grep excerpts.

## Relay handoff

When `todo` empties the ledger, the relay arms a handoff transaction and the next provider request is refused by a synchronous `agent.addBeforeModelCall` gate. The gate never awaits the handoff: it starts one background ticket and returns `{ stop: true }`, so no request is built on the empty ledger and no extra model turn is spent.

The ticket waits for `session.waitForRunEnd()`, then calls `session.compact(focus, { mode: "handoff" })`. That is exactly what the builtin `/handoff` and the RPC `handoff` command call; `focus` is the command's only argument, so no prompt, user message, or developer message is sent. The call resolves only after its background compaction commits. The ticket then advances the relay generation and calls `agent.continue()`; the successor's first request is a fresh request on the compacted transcript.

The transaction records the session id, the branch handoff count, and the source generation before compaction. After the commit, the count must grow before the generation advances. If the process stops between the commit and the advance, the next gate recognizes the new handoff entry and advances idempotently instead of compacting twice. A pending station belongs to its session manager: a `/new` or session switch never routes the next stop to the old session.

## Diagnostics

Failures the extension once swallowed now land in a 64-entry ring: `herd-diag`
prints it, and the status line carries `⚠ N` while records remain.

On the first `session_start` of a session, a host seam that failed to install
(the `activateVibeTools` method or the `extensionRunner` getter) raises a
visible error naming it, so folding and the relay never degrade in silence.

Session state is append-only. Each turn appends a delta against the previous
snapshot under the host's `parentId` tree, with a checkpoint every 64 writes;
`restore` replays back to the nearest checkpoint and still reads the older
full-snapshot entries. A measured 400-turn session writes 4.5% of what
per-turn snapshots would write.

## Host smoke

`bun scripts/smoke-omp.mjs` loads the real omp `AgentSession` from a local
checkout (`OMP_HOST`, default `~/Desktop/vibe/oh-my-pi`) and checks the two
prototype seams this extension patches, the five registered tools, the host
events it binds, and the append-only state log.

A checkout whose native addon is older than its source cannot be imported.
When `~/.omp/natives/<version>` already holds a matching prebuilt addon, the
script borrows it and re-runs itself in a child process, so the seams are
verified against the real class instead of skipped. `OMP_SMOKE_BORROW=0`
disables the borrow and keeps the honest skip; the exit code stays 0 either
way, and only a genuine seam failure exits 1.

## Model selection

Set a fission item's `model` to an omp `/switch` selector to use a different model for that flow:

```js
scope({ begin: {
  stage: "direct-execution",
  elder_report: null,
  time: 120,
  fission: [{ intent: "Review the results", budget: { read: 3 }, permission: "ro", model: "@smol" }],
} })
```

Omit `model` or use `null` to inherit the model of the scope that opens the batch, or the session model when there is no enclosing scope. Closing a flow's scope restores the enclosing model. A combined `end: true` and `begin` is currently refused, so a batch always inherits from the scope that opens it. The host handles model resolution, credentials, and thinking level. Role and alias names such as `default` and `task` resolve before any model-name match; a fuzzy match only estimates the context window and price and never becomes the model a verification expects. If the switch fails, the tool reports the failure and records the model the host is actually using.

Each model has a separate record of the conversation prefix it has cached. The extension uses the target model’s context window when it can resolve it in advance. At 82% of that window it attempts to fold eligible history without dropping the current workbench. It refuses to open the scope if the retained context is estimated to occupy at least 95% of the target window.

Returning to a smaller model also folds eligible history at 82%, keeping the scope that just closed as the workbench. If the host truncates nested scopes, the extension restores the model of the surviving outer scope before the next request when it sees the boundary during compaction or before the agent starts.
