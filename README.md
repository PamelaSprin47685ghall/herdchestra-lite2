# Herdchestra Lite 2

Herdchestra 是基于 DeerFlow 的集成工作台：内核与视觉素材来自 DeerFlow，产品层由 Herdchestra 独立开发。

Herdchestra is an integration workbench built on DeerFlow: the kernel and visual assets come from DeerFlow, while the product layer is independently developed by Herdchestra.

Herdchestra Lite 2 gives an agent session parallel work that returns to the scope that asked for it. A parent calls `scope_fork` with one item per child; each child works in its own scope with its own budget, time and model, then `scope_return` submits its record. The parent calls `scope_join` to receive one finished child as a tool receipt. The parent keeps its own model, context and message line; it never becomes the child and the child never becomes the parent.

A `scopeId` that already exists — including a finished one — is reused instead of duplicated. `running` and `blocked` scopes take the budget as an increment, the `dafny_pseudo_code` as one more requirement, and merged `targets`; `ready` supersedes the old record and starts the next generation; `joined` and `failed` start a new generation with the old record as prior history. Only the owner may reuse it; another caller gets `FOREIGN_SCOPE_ID`. A requirement enters at the child's next turn boundary, never in the middle of a running tool. A new scope still needs `dafny_pseudo_code`; a reuse may carry budget, targets, or a requirement alone. A superseded generation stays frozen in the ledger, but the tool surface resolves a `scopeId` to its latest generation only.

## Fork, join and return

`scope_fork({ forks: [...] })` declares what remains and starts every item marked `blocked: false`. Each item carries `scopeId`, `dafny_pseudo_code`, `blocked`, `budget`, `targets`, and an optional `model`. The wall clock is not a model field: the system derives it as the session's mean LLM-request duration times the sum of that item's tool-budget points (one minute per point until a request has been measured, and never less than one second). The clock covers tool execution too: a bash or test run spends wall time without spending points, so an I/O-heavy scope can reach its deadline first — reserve `scope_panhandle` seconds for it. `blocked: true` records a checkpoint only: it starts nothing, spends nothing, and is never woken later — the next `scope_fork` declares it again. One invalid item rejects the whole call before any child starts; an array may hold several items, and one assistant message may hold several `scope_fork` calls. Scope size is held to a constant at every depth: about 18 total tool-budget points per scope and never more than 27 (reuses included), about 4 items per call and never more than 6. The caps are rebukes, not schema gates — an oversized call still runs and its receipt carries a `WARNING`. A default is also a floor: a plan split into one child for safety wastes the free budget a fresh subtree mints.

`scope_join({})` receives one eligible child result. In a message with other calls, place it last: its result is a whole working record and reads best after the other results. No tool is exclusive; the runtime does not reject a mixed message. The record holds what the child's assistant said, in order, with each tool call reduced to a bare `[name]` placeholder: assistant text lines and `[read]`, `[edit]`, `[bash]` markers, joined by newlines. Tool results, thinking blocks, tool arguments, and user broadcasts are absent. `scope_join` has no time limit: while it waits, the parent's wall clock stops and the wait is added back to its deadline. `scope_return` gets the same treatment while the parent has not yet taken the record. A manager's time budget does not include the people it hired; tool budget and time budget stay independent.

`scope_return({})` submits the child's own record; an optional `markdown` string is appended to the end of that record after leading and trailing whitespace is trimmed. In a message with other calls, place it last: the record is a whole working result and reads best after the other results. No tool is exclusive. A child may return while it still has unreceived children: those children move to the child's current parent, keep their identities and budgets, and are received there by `scope_join`.

A scope's tool budget and wall clock come from the `scope_fork` item that created it. The parent's balance never funds a child and never shrinks when a child starts. The root has no tool budget and no wall clock, so it cannot run ordinary tools: it plans, forks, joins and answers, and the work runs in a child. Free control tools (`scope_fork`, `scope_join`, `scope_context`, `todo`, `ask`, `wait`), and every `read` or `write` of a built-in protocol URI (`skill://`, `local://`, `ssh://`, `agent://`, `xd://`, `omp://`…), stay available at the root. `scope_panhandle` is free for a running branch: it holds out its hand for tool points and wall-clock seconds at once, about 6 points by default and at most 9 total points across all tools in one call, plus up to 300 seconds, and records the reason with the handout. It is the only call that still works after a budget refusal. `scope_return` is child-only: it submits a scope's own record, so the root has no use for it. `scope_context({ amend })` may not retract a beat at or before the scope's most recent structural call.

The root (`Root`) keeps its native transcript and input stream. Descendants at every depth appear in the main transcript as labelled message and tool components; full records arrive through `scope_join`. Root and descendants compete equally for one streaming slot: the first stream holds it through completion, and an overlapping stream appears as a single block after it ends. The native working row displays `[Busy: X, Idle: Y]` and the path to the latest requesting scope, omitting `Root`. Each fork item supplies a short `scopeId` such as `oh-my-pie`, displayed as `Oh My Pie`. Only explicit tool prompts and approvals can use the root UI. An accepted `scope_return` ends the child loop at the tool-result boundary, without an extra model request or an interruption message.

Tree depth is chosen the same way, from closures rather than from tool calls: one closure is an 18–27 point leaf that finishes and returns on its own. Up to about six closures stay one layer deep; seven to twenty-four default to two layers; a larger job is recommended through three. Two layers is the default and three is where a job stops being ordinary. These are recommendations, not a ceiling: a deeper tree runs, and a real reason is enough without writing it out. A child's birth receipt states its place, `depth X (default tree depth 2, recommended through depth 3)`, and a fourth layer still starts, carrying a calm `Note —` about what each extra layer costs — the record compresses to prose once more, and every ancestor's plan rides in the child's prefix. A single-child relay layer buys nothing; ask first whether the leaves are cut too fine. Never serialize ten independent closures into repeated root waves to keep the tree shallow: that spends the root's attention on records instead of giving them one subtree.

The three tools exist in every supported configuration. There is no `scope` tool, no `begin`/`end` argument, no alias and no fallback: a configuration that cannot support fork/join refuses the call instead of registering the retired tool.

## Running from source

The repository holds two packages. `herdchestra-host-omp` in `host-omp/` is the plugin: it declares the host extension entry and carries the host wiring. Its only dependency, `herdchestra-lite2` at the repository root, is the host-agnostic engine — ledgers, stations, tickets, prompts — and imports nothing from the host. Install once with `cd host-omp && bun install`; the core then resolves through `host-omp/node_modules/herdchestra-lite2`.

The boundary is one function in each direction. The core exports exactly `createEngine`; the host imports exactly that. The host hands `createEngine` its facts (five frozen groups: `session`, `model`, `accounting`, `fork`, `report`) and its verbs (the eight `tickets` capabilities), and receives one engine carrying the stations, the ready-to-register tool catalog, the scope read model, the text renderer, the resolved ports, and the fork wiring. Port assembly, the fork wiring, and the six tool bindings stay inside the core; the host never builds a table or an `execute`. The contract is code (`HOST_CONTRACT`, `TICKET_CONTRACT`, `ENGINE_ONLY_HOST_KEYS` in `src/engine.mjs`), and `tests/architecture/core-host-free.test.mjs` fails when a core file reaches outside it, when the core gains a second export, or when the host imports anything but `createEngine`.

The host loads the installed plugin at `~/.omp/plugins/node_modules/herdchestra-host-omp`. Three shapes are possible, and only one of them belongs to `sync:plugin`:

```sh
omp plugins link host-omp              # dev: the working tree IS the install
omp plugins install <git-url>          # host-owned copy, resolved by the host
bun run sync:plugin                    # report the shape; write only for a vendor target
bun scripts/sync-plugin.mjs --vendor   # fill a real directory from this tree
bun scripts/sync-plugin.mjs --check    # report drift without copying
bun run smoke:relay                    # check relay behavior in this working tree
```

With `omp plugins link`, `~/.omp/plugins/node_modules/herdchestra-host-omp` is a symlink at `host-omp/`, so every edit here is live after a restart — no sync step. `sync:plugin` detects that shape, prints `link install` and writes nothing; it also refuses to touch a link that points outside this repository. The six skills live in the core's `resources/skills/` and are inlined into the system prompt; the host package ships no `skills/` directory.

With `omp plugins install <git-url>`, the host installs and resolves a copy under its own plugin directory. That directory is the host's, not this tree's, so `sync:plugin` classifies it as `installed copy` and writes nothing; refresh it by installing again. A `--vendor` run is the separate case: only an explicit `--vendor` (or `HERDCHESTRA_SYNC=vendor`) lets the script write a real directory — the host package at the target root, and the core under the target's `node_modules/herdchestra-lite2` (including `resources/skills/`). In that mode an edit here does not reach a running session until you sync again. `sync:plugin` never writes through a link, so it can no longer rewrite this repository's own `package.json`.

Restart the session afterwards; modules load at process start. A `todo` result that shows a `Flow:` line comes from the current build, so a missing `Flow:` line means the session is still running an older copy.

Tests stay in the repository root and cover both packages: `bun test tests` runs the core domain, the host wiring, and the architecture ratchets that hold the boundary. `bun run smoke:relay` tests the working tree against a fake host. It checks fork/join registration and refusals, the `todo` status, and the relay transitions into and out of full flow. It does not test the installed copy.

## Skills

Guidance ships as Markdown under `resources/skills/<name>/SKILL.md` in the core. `src/prompts/skills.mjs` reads all six at startup, strips the YAML frontmatter, and `src/prompts/inject.mjs` embeds every body in the managed system-prompt block. The host package ships no `skills/` directory, so no `skill://` read is needed. Direct execution needs no skill.

| Skill | Question |
|---|---|
| `constitution` | Stance: engineering, communication, team, execution, candor, courage, language |
| `decision-framing` | Why: intent, non-goals, the decision and its bounds |
| `polish` | How: preserve claims, causal links, and voice while improving expression |
| `prompt-craft` | Where model-facing text lives and how to write it |
| `skill-authoring` | How to split, name, and maintain a skill |
| `tdd-crowdsource` | What and who: contracts, test seams, and a rolling dispatch plan |

The inlined skills are authoritative: apply `constitution` before work, `prompt-craft` before changing model-facing text, `skill-authoring` before creating or splitting a skill, and `polish` before polishing an existing text. Apply `decision-framing` when the goal or limits are unclear, and `tdd-crowdsource` before writing code or tests.

Red contracts may be written by the lead or delegated. As contracts become ready, pin the current dispatch plan instead of running Red, then start the corresponding Green slices without waiting for the rest. A child may pin unrun checks for its parent; only checks that ran count as verification. Keep design artifacts as skills under `.agent/skills/<name>/SKILL.md`.

### Full flow and simple mode

A session starts simple: a clear task finishes and answers. The first submitted `todo` ledger, empty or not, turns the full flow on: the skills and the relay apply from then on. The flow stays on across handoffs; only the promoted second empty evaluation ends it. After that a new task is simple again, until another ledger is submitted, empty or not; that submission turns the full flow back on without re-arming a handoff. A `todo` view never turns the flow on.

Model-facing text lives in `resources/prompts/` as Markdown documents with `## section` blocks. Code loads them through `src/prompts/index.mjs`; no prompt, tool description, parameter description, receipt, or model-facing error is duplicated in source.

## Scope targets

Every fork item declares `targets`, a non-empty array of natural-language descriptions of what it expects to create, read, update, or delete. An item may name a file path, a part of the source, a behavior, or a goal; any human language is valid, and a path is only one kind of target. For example, `["fix any defect you find", "the parts of the source that involve caching"]` is valid. The field is required: a missing, empty, blank, or non-string entry rejects the whole batch. Blocked checkpoints declare their targets too.

`targets` is a declaration, not an enforcement boundary. The system never audits a tool call against the list; a scope that turns out to need another target may still touch it. The required list is the mistake-proofing: a scope that can name no output is not a separate scope, so think again before forking one. A refused batch changes no state, and no flow starts.

## Autopilot

Autopilot is off by default and is toggled only by the user, with `/herd-autopilot`. No model turn can enter or leave it.

A bare `/herd-autopilot` flips the mode and sends nothing to the model: the next request learns the new mode from its receipt. `/herd-autopilot <text>` is that same flip followed by one plain user message carrying `<text>`, so the model starts exactly one turn and reads the sentence as the user's request.

- Off (manual duty): `ask` is allowed, a turn may end naturally to wait for the user, and the relay's two-empty-ledger, handoff, and ledger-evaluation rules do not run. Fork/join and its budgets still do.
- On (full automatic): `ask` is blocked, and the relay evaluates every successful `todo` write, including the two empty evaluations and the handoff chain.

`ask` needs one condition: autopilot off.

## Pinned context

`scope_context` carries both working-level bookkeeping moves. `scope_context({ pin })` records durable notes: assumptions, deductions, inductions, findings, and conclusions. Each call appends one record to the session state and costs no budget. Its receipt sends the caller to the `todo` ledger: a note that changes the plan should enter the work list now, not after the next receipt. Pins survive receipt shortening because they belong to the session, not to a scope. `scope_context({ amend })` replaces the record of the beat that just delivered, and both halves may arrive in one call; amend runs first so its refund is already in the ledger when the note lands.

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

`bun scripts/smoke-omp.mjs` loads the real host `AgentSession` from a local
checkout (`OMP_HOST`, default `~/Desktop/vibe/oh-my-pi`) and checks the two
prototype seams this extension patches, the six registered tools, the host
events it binds, and the append-only state log.

A checkout whose native addon is older than its source may import and then
fail on a symbol the newer source calls. Both smoke scripts read the addon's
stamped build version and, when `~/.omp/natives/<version>` already holds a
matching prebuilt addon, borrow it and re-run in a child process. CI sets
`OMP_SMOKE_BORROW=0` and `OMP_SMOKE_STRICT=1`, builds the native addon from
the latest host source, and treats missing host capabilities as failures.

`bun scripts/smoke-context.mjs` uses the same `OMP_HOST`. It runs the real
Agent loop and ExtensionRunner with the host's mock model, for both `prompt()`
and `continue()`. Each run executes four tools and five model requests. It
checks message order, stable prior prefixes, separate history arrays, and
the absence of per-call markers on committed Skills. It makes no API calls
and always fails if the host or its dependencies cannot load.

CI checks out the host's default branch (`latest`) and pins Bun `1.4.4`. A
host upgrade should pass both smoke scripts before use; the native cache is
keyed by the resolved host commit, so a new host rebuilds it instead of
reusing an older addon.

## Model selection

Set a fork item's `model` to a host `/switch` selector to use a different model for that child:

```js
scope_fork({ forks: [{
  scopeId: "review-results",
  dafny_pseudo_code: "requires: the replay module exists; ensures: each finding is pinned with file:line and severity",
  blocked: false,
  budget: { read: 3 },
  targets: ["src/transcript/replay.mjs"],
  model: "@smol",
}] })
```

Omit `model` or use `null` to inherit the model of the parent that opens the fork, or the session model at the root. The fork resolves and records the child's model once; it never changes the parent's model, and a join never adopts the child's model. The parent's model changes only through an explicit user switch. The host handles model resolution, credentials, and thinking level. Role and alias names such as `default` and `task` resolve before any model-name match; a fuzzy match only estimates the context window and price and never becomes the model a verification expects. If the switch fails, the tool reports the failure and records the model the host is actually using.

Scope admission is its own check. `scope_fork` does not check whether the child record will fit; `scope_join` estimates the parent's context size before accepting a record. A context-size refusal leaves the child record ready and unchanged. There is no receipt folding: a record is already a digest, so nothing is archived or shortened.

Third-party notices: see THIRD_PARTY_NOTICES.
