# Herdchestra Lite 2

Herdchestra 是基于 DeerFlow 的集成工作台：内核与视觉素材来自 DeerFlow，产品层由 Herdchestra 独立开发。

Herdchestra is an integration workbench built on DeerFlow: the kernel and visual assets come from DeerFlow, while the product layer is independently developed by Herdchestra.

Herdchestra Lite 2 gives an agent session parallel work that returns to the scope that asked for it. A parent calls `scope_fork` with one item per child; each child works in its own scope with its own budget, time and model, then takes the `scope_return` oath to submit its record. The parent calls `scope_join` to receive one finished child as a tool receipt. The parent keeps its own model, context and message line; it never becomes the child and the child never becomes the parent.

Every `scopeId` names one new scope among its siblings, and nothing else: a fork never reuses an existing scope. A name a sibling already holds — running, finished, or reserved earlier in the same call — is renamed by appending the lowest free numeric suffix (`worker` → `worker-2` → `worker-3`), and both the caller's receipt and the child's start receipt show the final path. The same name under two different parents names two unrelated scopes. To ask a scope that already exists a question, call `scope_request` with its exact path.

A scope is addressed by where it sits: the root is `/`, and a child's path is its parent's path plus its own name (`/api`, `/api/auth`). `scope_request` takes one exact path resolved against your own — `..` for the parent, a bare name for a child of yours, `/a/b` for an absolute path — and refuses a self-target. There are no wildcards: ask several scopes in parallel from one script, over `state.scopes`. A finished scope may still be named, and asking it wakes it for one reply turn. The probe prints `state.scopes`, every path that can still answer, in lexicographic order, so a receiver can address any scope without being told who is speaking.

## Fork, join and return

`scope_fork({ forks: [...] })` starts one new scope per item and cannot extend an existing one. Each item carries `scopeId`, `fsm`, `profession`, `n`, `budget`, `targets`, and an optional `model`; every one of them is required, and a blank `fsm` or `profession` rejects the item. The wall clock is not a model field: the system derives it as the session's mean LLM-request duration times the sum of that item's turns (one minute per turn until a request has been measured, and never less than one second). The clock covers tool execution too: a bash or test run spends wall time without spending turns, so an I/O-heavy scope can reach its deadline first — an over-deadline call still returns its result and is recorded in the panhandle count, so the clock is a receipt, not a fence; size the turns for the time the work needs. One invalid item rejects the whole call before any child starts; an array may hold several items, and one assistant message may hold several `scope_fork` calls. A scope is sized by the work in hand, not by a table: budget about `sqrt(2n)` turns, where `n` is that scope's share of the work counted in ideal turns. Two, because a worker's real work runs back and forth — about two turns for every ideal one. Fork as much as the work allows — a wide batch costs one call — and say so inside every item: a child that finds independent work forks again in turn. Nothing else is capped: no turn total, no items per call, no tree depth. A scope that is too small wastes one fork; a scope that is too large puts the whole job on one context, and no receipt can repay that.

`scope_join({})` receives one eligible child result. In a message with other calls, place it last: its result is a whole working record and reads best after the other results. `scope_return` runs alone in its script. The record holds what the child's assistant said, in order, with one line per tool call written as `name(key="value", ...)`: assistant text lines and `js(code="…")`, `read(path="a.mjs:1-20")`, `edit(path="b.mjs")`, `bash(command="ls -la")` lines, joined by newlines. A string argument is quoted, any other value is compact JSON, and no argument is truncated or filtered. Tool results, thinking blocks, and user broadcasts are absent. `scope_join` has no time limit: while it waits, the parent's wall clock stops and the wait is added back to its deadline. A child that will not return is closed with `scope_abandon({ target })` instead of being waited on. `scope_return` answers in the same beat: the record is sealed and queued for the parent's next join, and nothing is left parked, so a finished scope's session stays alive and idle. A manager's time budget does not include the people it hired; turns and time stay independent.

Call `scope_return` alone in its script, always with non-empty `dafny`. Omitting the oath rewinds the context and continues the same scope; a child keeps its birth instructions and latest report. The new report replaces the old one, so carry forward evidence and unresolved work that still matter. To publish a child's record, pass `signed_sealed_hands_off_nothing_left_on_the_table: "a_ferocious_audacious_master_would_change_nothing"`. The child seal appends the trimmed `dafny` to the record. Any unreceived children transfer to the receiving scope and keep their identities and turns. An unsealed child that stops is nudged to return.

A scope's budget and wall clock come from the `scope_fork` item that created it. The parent's budget never funds a child and never shrinks when a child starts. The root has no budget and no wall clock, so it cannot run ordinary tools: it plans, forks, joins and answers, and the work runs in a child. Free control tools (`scope_fork`, `scope_join`, `scope_return`, `scope_request`, `scope_abandon`, `wait`, and `ask` while autopilot is off) stay available at the root; a `read` or `write` of a built-in protocol URI (`skill://`, `local://`, `ssh://`, `agent://`, `xd://`, `omp://`…) spends no turn wherever it is bound, and the root binds neither, because the skills are already inlined in its system prompt. Turns are a ledger, not a fence. When a scope's turns for a tool are spent, the call still runs and the receipt records that the call was panhandled; the scope's panhandle count travels with its record, so the caller reads it at `scope_join`. Panhandling buys the call and nothing else: it is the receipt saying in public that the scope sized itself wrong, and a scope that panhandles its way to a checkpoint has told its caller it could not plan. The root is the one exception, because it is outside every scope and holds no budget to overrun. `scope_return` is child-only: it submits a scope's own record, so the root has no use for it.

The root (`Root`) keeps its native transcript and input stream. Descendants at every depth appear in the main transcript as labelled message and tool components; full records arrive through `scope_join`. Root and descendants compete equally for one streaming slot: the first stream holds it through completion, and an overlapping stream appears as a single block after it ends. The native working row displays `[Busy: X, Idle: Y]` and the path to the latest requesting scope, omitting `Root`. Each fork item supplies a short `scopeId` such as `oh-my-pie`, displayed as `Oh My Pie`. Only explicit tool prompts and approvals can use the root UI. An accepted child oath ends the child loop at the tool-result boundary, without an extra model request or an interruption message.

Depth is not a policy. A child reads the same rule its parent read — fork when the work splits, budget the turns the rule above derives from `n` — so a larger job becomes a deeper tree rather than a fatter scope, and the tree stops where the work stops. What each extra layer costs is context: the record compresses to prose once more, and every ancestor's plan rides in the child's prefix. A child's birth receipt states its place as `depth X` and attaches no default and no recommendation. A single-child relay layer buys nothing; ask first whether the leaves are cut too fine. Never serialize ten independent closures into repeated root waves to keep the tree shallow: that spends the root's attention on records instead of giving them one subtree.

The control tools exist in every supported configuration. There is no `scope` tool, no `begin`/`end` argument, no alias and no fallback: a configuration that cannot support fork/join/request refuses the call instead of registering the retired tool.

## Asking a scope

`scope_request({ target, message, interrupt })` is the only way to talk to a scope after its creation, and it spends no turn. `target` is one exact path resolved against your own — `..`, a child's name, or `/a/b`; there are no wildcards and a scope cannot ask itself. The call resolves to `{ ok, from, reply }`, so the requester waits on the answer inside the same script and continues on the next line with it.

The question arrives as the target's next turn in `AWAITING_REPLY`: its `api` holds only `scope_reply`, and `state.request` carries `{ from, message }`. It answers with one string, which resolves the caller's request and lifts the mode. A second question waits in the same queue and is answered in the next reply turn, so concurrent callers are served in arrival order and each costs the target one turn.

`interrupt: true` cuts the target off in the middle of its work and makes it answer now; the default `false` lets the question land at its next request. The interrupt travels on its own reason, never the user's abort, so the web stop button still cancels the whole tree while a request never does. A question that would close a cycle of scopes waiting on each other is refused at the call instead of deadlocking the tree.

A finished scope is still addressable: a question wakes it for one `scope_reply` turn and it stops again. Its sealed record is untouched, so waking it creates no second result for the parent to join.

## Running from source

The repository holds three packages. `herdchestra-host-omp` in `host-omp/` is the plugin: it declares the host extension entry and carries the host wiring. Its only dependency, `herdchestra-lite2` at the repository root, is the host-agnostic engine — ledgers, stations, tickets, prompts — and imports nothing from the host. Install once with `cd host-omp && bun install`; the core then resolves through `host-omp/node_modules/herdchestra-lite2`.

`herdchestra-host-omp-ui` in `host-omp-ui/` is the second plugin and the standalone web bridge: one loopback manager that lists the machine's `omp` sessions and reuses DeerFlow's UI components. It does not depend on `herdchestra-host-omp`, and the two plugins never import each other. Build its static assets with `cd host-omp-ui && bun run build:web`; the TUI plus browser acceptance loop is `.agent/skills/manual-acceptance/web-tui.md`.

The boundary is one function in each direction. The core exports exactly `createEngine`; the host imports exactly that. The host hands `createEngine` its facts (five frozen groups: `session`, `model`, `accounting`, `fork`, `report`) and its verbs (the eight `tickets` capabilities), and receives one engine carrying the stations, the ready-to-register tool catalog, the scope read model, the text renderer, the resolved ports, and the fork wiring. Port assembly, the fork wiring, and the five tool bindings stay inside the core; the host never builds a table or an `execute`. The contract is code (`HOST_CONTRACT`, `TICKET_CONTRACT`, `ENGINE_ONLY_HOST_KEYS` in `src/engine.mjs`), and `tests/architecture/core-host-free.test.mjs` fails when a core file reaches outside it, when the core gains a second export, or when the host imports anything but `createEngine`.

The host loads the installed plugin at `~/.omp/plugins/node_modules/herdchestra-host-omp`. Three shapes are possible, and only one of them belongs to `sync:plugin`:

```sh
omp plugin link host-omp              # dev: the working tree IS the install
omp plugin install <git-url>          # host-owned copy, resolved by the host
bun run sync:plugin                    # report the shape; write only for a vendor target
bun scripts/sync-plugin.mjs --vendor   # fill a real directory from this tree
bun scripts/sync-plugin.mjs --check    # report drift without copying
bun run smoke:relay                    # check relay behavior in this working tree
```

With `omp plugin link`, `~/.omp/plugins/node_modules/herdchestra-host-omp` is a symlink at `host-omp/`, so every edit here is live after a restart — no sync step. `sync:plugin` detects that shape, prints `link install` and writes nothing; it also refuses to touch a link that points outside this repository. The six skills live in the core's `resources/skills/` and are inlined into the system prompt; the host package ships no `skills/` directory.

With `omp plugin install <git-url>`, the host installs and resolves a copy under its own plugin directory. That directory is the host's, not this tree's, so `sync:plugin` classifies it as `installed copy` and writes nothing; refresh it by installing again. A `--vendor` run is the separate case: only an explicit `--vendor` (or `HERDCHESTRA_SYNC=vendor`) lets the script write a real directory — the host package at the target root, and the core under the target's `node_modules/herdchestra-lite2` (including `resources/skills/`). In that mode an edit here does not reach a running session until you sync again. `sync:plugin` never writes through a link, so it can no longer rewrite this repository's own `package.json`.

Restart the session afterwards; modules load at process start.

Tests stay in the repository root and cover all three packages: `bun test tests` runs the core domain, both host wirings, and the architecture ratchets that hold the boundaries. `bun run smoke:relay` tests the working tree against a fake host. It checks fork/join registration and refusals, along with return and rewind behavior. It does not test the installed copy.

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

Red contracts may be written by the lead or delegated. As contracts become ready, write the current dispatch plan into the design record instead of running Red, then start the corresponding Green slices without waiting for the rest. A child may report unrun checks to its parent; only checks that ran count as verification. Keep design artifacts as skills under `.agent/skills/<name>/SKILL.md`.

Model-facing text lives in `resources/prompts/` as Markdown documents with `## section` blocks. Code loads them through `src/prompts/index.mjs`; no prompt, tool description, parameter description, receipt, or model-facing error is duplicated in source.

## Scope targets

Every fork item declares `targets`, a non-empty array of natural-language descriptions of what it expects to create, read, update, or delete. An item may name a file path, a part of the source, a behavior, or a goal; any human language is valid, and a path is only one kind of target. For example, `["fix any defect you find", "the parts of the source that involve caching"]` is valid. The field is required: a missing, empty, blank, or non-string entry rejects the whole batch.

`targets` is a declaration, not an enforcement boundary. The system never audits a tool call against the list; a scope that turns out to need another target may still touch it. The required list is the mistake-proofing: a scope that can name no output is not a separate scope, so think again before forking one. A refused batch changes no state, and no flow starts.

## Autopilot

Autopilot is off by default and is toggled only by the user, with `/herd-autopilot`. No model turn can enter or leave it.

A bare `/herd-autopilot` flips the mode and sends nothing to the model: the next request learns the new mode from its receipt. `/herd-autopilot <text>` is that same flip followed by one plain user message carrying `<text>`, so the model starts exactly one turn and reads the sentence as the user's request.

- Off (manual duty): `ask` is allowed and root may stop naturally.
- On (autopilot): `ask` is blocked and root is nudged to call `scope_return` before stopping. If children remain unreceived, the join nudge takes precedence.

`ask` needs one condition: autopilot off.

## Rewind

A rewind keeps the latest return report, plus the birth instructions in a child. The report is where durable findings live now, so write it as the record a later turn needs; read the documents it names in full rather than relying on grep excerpts.

## Context pressure

A scope is asked to return when it outgrows half of its own headroom. The
midpoint is `(window - baseline) / 2 + baseline`, where the baseline is the
input the provider reported for the scope's first request and the window is the
model's input limit. When the occupancy the last response ended at is strictly
above that midpoint, the scope's projection collapses to `CONTEXT_LIMIT`: only
`scope_return` is bound, and the probe carries one `> // Context Pressure:` line
that weighs the record against another turn. Below the midpoint the ordinary
capability set returns, so a scope settles rather than reads the same sentence
every turn.

The mode and the probe never touch the system prompt: both are rebuilt for
every request and are not part of the cached prefix, so arming and disarming
costs the provider nothing. `injectSystemPrompt` is byte-identical to what it
produced before this feature.

Every unknown refuses to arm: no measured baseline, no measured occupancy, or
no known window means no nudge. A scope born at or past its window arms at
once, since it has no room left to grow into. A rewind re-baselines at the new
birth; a fold keeps the baseline and simply reclaims room.

## Root return and review

At root, a small return (no oath) uses compaction to rewind and continue. Root keeps verbatim user prompts and steers as actual messages, plus the new `dafny` report. Do not repeat those user messages in the report. The old report is replaced, not appended: carry forward any evidence a later turn still needs.

Root must receive all outstanding children with `scope_join` before taking the oath. The first oath rewinds for a fresh review against the user's requirements. A second consecutive oath permits the final reply. If review identifies work worth doing, continue working; a small rewind resets the streak. A natural stop is not a rewind or an oath.

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
prototype seams this extension patches, the five registered tools, the host
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
  fsm: "states: locate the replay module, read it, record each finding; transition: a finding with no file:line and severity sends the read back; parallel: none",
  profession: "You are a careful reviewer like Barbara Liskov. ",
  budget: { read: 3 },
  targets: ["src/transcript/replay.mjs"],
  model: "@smol",
}] })
```

Omit `model` or use `null` to inherit the model of the parent that opens the fork, or the session model at the root. The fork resolves and records the child's model once; it never changes the parent's model, and a join never adopts the child's model. The parent's model changes only through an explicit user switch. The host handles model resolution, credentials, and thinking level. Role and alias names such as `default` and `task` resolve before any model-name match; a fuzzy match only estimates the context window and price and never becomes the model a verification expects. If the switch fails, the tool reports the failure and records the model the host is actually using.

Scope admission is its own check. `scope_fork` does not check whether the child record will fit; `scope_join` estimates the parent's context size before accepting a record. A context-size refusal leaves the child record ready and unchanged. There is no receipt folding: a record is already a digest, so nothing is archived or shortened.

Third-party notices: see THIRD_PARTY_NOTICES.
