# Herdchestra Lite 2

Herdchestra Lite 2 adds budgeted work scopes to omp. Each scope controls which tools can run and how many times they can run. Use `scope({ end: true })` to close it.

When a scope folds, its user messages move before its opening `scope` call. Their content and order stay intact. The scope summary records outcomes and remaining work without repeating those messages.

## Stages

Every `scope({ begin })` must name a stage. The innermost open scope determines the current stage; outside all scopes there is no stage.

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

The stage sections for `decision-framing`, `acceptance-cases`, `architecture-design`, and `orchestration-plan` live in the system prompt as a stable prefix, so a provider can reuse its prompt cache. A begin receipt only names its stage; it does not repeat the prompt text. `direct-execution` has no section: it follows the `orchestration-plan` artifact.

## Scope permission

Every `scope({ begin })` declares `permission: "ro" | "rw"`. The declaration is mistake-proofing, not an enforcement boundary: `"ro"` is trusted, and the harness never blocks a write because a scope called itself read-only.

An omitted (or null) `permission` is treated as `"rw"`: forgetting to declare the field must not bypass the gate.

`"rw"` is refused in two cases:

- the scope's stage is `decision-framing`, which answers why rather than what;
- the relay has not recorded its first submitted `todo` ledger for the current generation. A `todo` view is a read-only inspection and does not count.

A refused begin changes no state. Submit a ledger first, or open the scope with `"ro"`.

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

## Model selection

Set `begin.model` to an omp `/switch` selector to use a different model for a scope:

```js
scope({ begin: { intent: "Review the results", stage: "direct-execution", budget: { read: 3 }, model: "@smol" } })
```

Omit `model` or use `null` to inherit the enclosing scope’s model, or the session model when there is no enclosing scope. Closing a scope restores the enclosing model. A combined `end: true` and `begin` inherits from the enclosing scope, not from the scope being closed. The host handles model resolution, credentials, and thinking level. Role and alias names such as `default` and `task` resolve before any model-name match; a fuzzy match only estimates the context window and price and never becomes the model a verification expects. If the switch fails, the tool reports the failure and records the model the host is actually using.

Each model has a separate record of the conversation prefix it has cached. The extension uses the target model’s context window when it can resolve it in advance. At 82% of that window it attempts to fold eligible history without dropping the current workbench. It refuses to open the scope if the retained context is estimated to occupy at least 95% of the target window.

Returning to a smaller model also folds eligible history at 82%, keeping the scope that just closed as the workbench. If the host truncates nested scopes, the extension restores the model of the surviving outer scope before the next request when it sees the boundary during compaction or before the agent starts.
