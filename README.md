# Herdchestra Lite 2

Herdchestra Lite 2 gives omp parallel work that returns to the scope that asked for it. A parent calls `scope_fork` with one item per child; each child works in its own scope with its own budget, time and model, then `scope_return` submits its record. The parent calls `scope_join` to receive one finished child as a tool receipt. The parent keeps its own model, context and message line; it never becomes the child and the child never becomes the parent.

## Fork, join and return

`scope_fork({ forks: [...] })` declares what remains and starts every item marked `blocked: false`. Each item carries `scopeId`, `intent`, `blocked`, `budget`, `time`, `permission`, and an optional `model`. `blocked: true` records a checkpoint only: it starts nothing, spends nothing, and is never woken later — the next `scope_fork` declares it again. One invalid item rejects the whole call before any child starts; an array may hold several items, and one assistant message may hold several `scope_fork` calls.

`scope_join({ elder_report })` receives one eligible child result. In a message with other calls, place it last: its result is a whole working record and reads best after the other results. No tool is exclusive; the runtime does not reject a mixed message. Pass `null` when no earlier receipt is pending. The receipt keeps every fork line, pin and adoption note; only a later join's `elder_report` may shorten an older receipt's work text, and the newest receipt always stays complete. `scope_join` has no time limit: while it waits, the parent's wall clock stops and the wait is added back to its deadline. `scope_return` gets the same treatment while the parent has not yet taken the record. A manager's time budget does not include the people it hired; tool budget and time budget stay independent.

`scope_return({})` submits the child's own record. In a message with other calls, place it last: the record is a whole working result and reads best after the other results. No tool is exclusive. A child may return while it still has unreceived children: those children move to the child's current parent, keep their identities and budgets, and are received there by `scope_join`.

A scope's tool budget and wall clock come from the `scope_fork` item that created it. The parent's balance never funds a child and never shrinks when a child starts. The root has no tool budget and no wall clock, so it cannot run ordinary tools: it plans, forks, joins and answers, and the work runs in a child. Free control tools (`scope_fork`, `scope_join`, `amend`, `pin`, `todo`, `ask`, `wait`), a `read` of a `skill://` path, and the write that resolves a staged ast_edit preview stay available at the root. `scope_return` is child-only: it submits a scope's own record, so the root has no use for it. `amend` may not retract a beat at or before the scope's most recent structural call.

The root (`Root`) keeps its native transcript and input stream. Descendants at every depth appear in the main transcript as labelled message and tool components; full records arrive through `scope_join`. Root and descendants compete equally for one streaming slot: the first stream holds it through completion, and an overlapping stream appears as a single block after it ends. The native working row displays `[Busy: X, Idle: Y]` and the path to the latest requesting scope, omitting `Root`. Each fork item supplies a short `scopeId` such as `oh-my-pie`, displayed as `Oh My Pie`. Only explicit tool prompts and approvals can use the root UI. An accepted `scope_return` ends the child loop at the tool-result boundary, without an extra model request or an interruption message.

The three tools exist in every supported configuration. There is no `scope` tool, no `begin`/`end` argument, no alias and no fallback: a configuration that cannot support fork/join refuses the call instead of registering the retired tool.

## Running from source

omp loads the installed copy at `~/.omp/plugins/node_modules/herdchestra-lite2`, not this working tree, so an edit here does not reach a running session by itself. After changing `src/` or `resources/`:

```sh
bun run sync:plugin                    # copy src/, resources/, and skills/ into the installed plugin
bun scripts/sync-plugin.mjs --check    # report drift without copying
bun run smoke:relay                    # check relay behavior in this working tree
```

Restart the session afterwards; modules load at process start. A `todo` result that shows a `Flow:` line comes from the current build, so a missing `Flow:` line means the session is still running an older copy.

`bun run smoke:relay` tests the working tree against a fake host. It checks fork/join registration and refusals, the `todo` status, and the relay transitions into and out of full flow. It does not test the installed copy.

## Skills

Guidance ships as ordinary omp skills under `skills/`. Direct execution needs no skill.

| Skill | Question |
|---|---|
| `constitution` | Stance: engineering, communication, team, execution, candor, courage, language |
| `decision-framing` | Why: intent, non-goals, the decision and its bounds |
| `polish` | How: preserve claims, causal links, and voice while improving expression |
| `prompt-craft` | Where model-facing text lives and how to write it |
| `skill-authoring` | How to split, name, and maintain a skill |
| `tdd-crowdsource` | What and who: contracts, test seams, and a rolling dispatch plan |

Read `skill://constitution` before work. Read `skill://prompt-craft` before changing model-facing text, `skill://skill-authoring` before creating or splitting a skill, and `skill://polish` before polishing an existing text. Read `skill://decision-framing` when the goal or limits are unclear. Read `skill://tdd-crowdsource` before writing code or tests.

Red contracts may be written by the lead or delegated. As contracts become ready, pin the current dispatch plan instead of running Red, then start the corresponding Green slices without waiting for the rest. A child may pin unrun checks for its parent; only checks that ran count as verification. Keep design artifacts as skills under `.agent/skills/<name>/SKILL.md`.

### Full flow and simple mode

A session starts simple: a clear task finishes and answers. The first submitted `todo` ledger, empty or not, turns the full flow on: the skills and the relay apply from then on. The flow stays on across handoffs; only the promoted second empty evaluation ends it. After that a new task is simple again, until another ledger is submitted, empty or not; that submission turns the full flow back on without re-arming a handoff. A `todo` view never turns the flow on.

Model-facing text lives in `resources/prompts/` as Markdown documents with `## section` blocks. Code loads them through `src/prompts/index.mjs`; no prompt, tool description, parameter description, receipt, or model-facing error is duplicated in source.

## Scope permission

Every fork item declares its own `permission: "ro" | "rw"`, and the field is required: a missing, `null`, or other value rejects the whole batch.

`"ro"` is a declaration, not an enforcement boundary. A flow that says `"ro"` is trusted: the system never blocks a tool because the scope called itself read-only, and it never audits a tool call against the claim. Mistake-proofing lives in the required field and in the `"rw"` refusal below; what a flow *does* with the tools it already holds stays a matter of the flow's own discipline.

`"rw"` is refused while the full flow is on and the relay has not recorded its first submitted `todo` ledger for the current generation. A `todo` view is a read-only inspection and does not count.

A refused batch changes no state, and no flow starts. Submit a ledger first, or open the flows with `"ro"`.

## Autopilot

Autopilot is off by default and is toggled only by the user, with `/herd-autopilot`. No model turn can enter or leave it.

A bare `/herd-autopilot` flips the mode and sends nothing to the model: the next request learns the new mode from its receipt. `/herd-autopilot <text>` is that same flip followed by one plain user message carrying `<text>`, so the model starts exactly one turn and reads the sentence as the user's request.

- Off (manual duty): `ask` is allowed, a turn may end naturally to wait for the user, and the relay's two-empty-ledger, handoff, and ledger-evaluation rules do not run. Fork/join and its budgets still do.
- On (full automatic): `ask` is blocked, and the relay evaluates every successful `todo` write, including the two empty evaluations and the handoff chain.

`ask` needs one condition: autopilot off.

## Pinned context

`pin` records durable notes: assumptions, deductions, inductions, findings, and conclusions. Each call appends one record to the session state and costs no budget. Pins survive receipt shortening because they belong to the session, not to a scope.

At a relay handoff, every historical pin is written into the successor's opening text under `## Pinned Context`. The successor is told to read each important document named there with `read`, in full, rather than substituting grep excerpts.

The same handoff copies the user's own prompts, verbatim and oldest first, into the opening under `## User Prompts (verbatim)`. The relay keeps that archive in session state, so a prompt that compaction removed still reaches every later generation; the handoff report therefore does not restate the requirements.

## Relay handoff

When `todo` empties the ledger, the relay arms a handoff transaction and the next provider request is refused by a synchronous `agent.addBeforeModelCall` gate. The gate never awaits the handoff: it starts one background ticket and returns `{ stop: true }`, so no request is built on the empty ledger and no extra model turn is spent.

The ticket waits for `session.waitForRunEnd()`, then calls `session.compact(focus, { mode: "handoff" })`. That is exactly what the builtin `/handoff` and the RPC `handoff` command call; `focus` is the command's only argument, so no prompt, user message, or developer message is sent. The call resolves only after its background compaction commits. The ticket then advances the relay generation and calls `agent.continue()`; the successor's first request is a fresh request on the compacted transcript.

The transaction records the session id, the handoff count, and the source generation before compaction. After the commit, the count must grow before the generation advances. If the process stops between the commit and the advance, the next gate recognizes the new handoff entry and advances idempotently instead of compacting twice. A pending station belongs to its session manager: a `/new` or session switch never routes the next stop to the old session.

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

### Request history

Each managed model request gets one persistent Skill receipt. The extension
uses `agent.addBeforeModelCallHook` to place it in the live tool loop before
the host clones messages for context extensions. It also commits the same
receipt to Agent history and the session journal. These histories have
separate arrays; retries reuse the committed receipt and its original clock.

The host defers new user and queued input events until after request
preparation. A Skill therefore goes after committed history and before any
pending inputs. The host still owns those inputs and commits them once.
Flows install this preparation before `agent.continue()`, which skips the
ordinary `before_agent_start` event. Read-only task agents keep their existing
policy and receive no Skill receipts.

`herd-diag` includes the current station's latest provider payload report.
The report records hashes and message counts, without storing prompts or
credentials. It distinguishes a preserved prefix, a changed namespace,
an intentional history rewrite, changed cache settings, and an unexpected
prefix change. Incremental payloads and unsupported provider formats are
marked explicitly and cannot establish a complete prefix comparison.

The observation point is `before_provider_request`. Later extension handlers
and transport code can still change the request. These reports and the
construction checks do not measure provider cache hits; cache usage still
comes from the provider's reported token usage.

## Host smoke

`bun scripts/smoke-omp.mjs` loads the real omp `AgentSession` from a local
checkout (`OMP_HOST`, default `~/Desktop/vibe/oh-my-pi`) and checks the two
prototype seams this extension patches, the six registered tools, the host
events it binds, and the append-only state log.

A checkout whose native addon is older than its source cannot be imported.
When `~/.omp/natives/<version>` already holds a matching prebuilt addon, the
script borrows it and re-runs itself in a child process. CI sets
`OMP_SMOKE_BORROW=0` and `OMP_SMOKE_STRICT=1`, builds the native addon from
the pinned host source, and treats missing host capabilities as failures.

`bun scripts/smoke-context.mjs` uses the same `OMP_HOST`. It runs the real
Agent loop and ExtensionRunner with the host's mock model, for both `prompt()`
and `continue()`. Each run executes four tools and five model requests. It
checks message order, stable prior prefixes, separate history arrays, and
the absence of per-call markers on committed Skills. It makes no API calls
and always fails if the host or its dependencies cannot load.

CI pins the host to `57771ae562b9345e0579bceb2d68d585e3e6927e` and Bun
`1.4.4`. A host upgrade should pass both smoke scripts before use.

## Model selection

Set a fork item's `model` to an omp `/switch` selector to use a different model for that child:

```js
scope_fork({ forks: [{
  scopeId: "review-results",
  intent: "Review the results",
  blocked: false,
  budget: { read: 3 },
  time: 120,
  permission: "ro",
  model: "@smol",
}] })
```

Omit `model` or use `null` to inherit the model of the parent that opens the fork, or the session model at the root. The fork resolves and records the child's model once; it never changes the parent's model, and a join never adopts the child's model. The parent's model changes only through an explicit user switch. The host handles model resolution, credentials, and thinking level. Role and alias names such as `default` and `task` resolve before any model-name match; a fuzzy match only estimates the context window and price and never becomes the model a verification expects. If the switch fails, the tool reports the failure and records the model the host is actually using.

Scope admission and receipt folding are separate. `scope_fork` does not check whether the child record will fit. `scope_join` checks the parent's estimated context size before accepting a record. A context-size refusal leaves the child record and the prior receipt untouched. An archived `elder_report` replaces the older receipt's work text only when this saves space; the newest receipt, fork lines, and pins stay intact.
