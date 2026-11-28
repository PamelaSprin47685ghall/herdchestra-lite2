# Herdchestra Lite 2

Herdchestra 是基于 DeerFlow 的集成工作台：内核与视觉素材来自 DeerFlow，产品层由 Herdchestra 独立开发。

Herdchestra is an integration workbench built on DeerFlow: the kernel and visual assets come from DeerFlow, while the product layer is independently developed by Herdchestra.

Herdchestra Lite 2 gives an agent session parallel work that returns to the scope that asked for it. A parent calls `scope_fork` with one item per child; each child works in its own scope with its own budget, time and model, then takes the `scope_return` oath to submit its record. The parent calls `scope_join` to receive one finished child as a tool receipt. The parent keeps its own model, context and message line; it never becomes the child and the child never becomes the parent.

## Roles: the name is the privilege

Every scope path segment is `<role>.<name>`, and the role of the last segment decides what that scope may do. Root `/` is a `manager`. Privilege narrows monotonically - `manager > devops > editor > inspector` - and a scope may fork or abandon only its own role or a narrower one; the path is the only place the role is set.

| Role | Host tools | Reported capacity |
|---|---|---|
| `manager` | none: plans, forks, joins, answers | 3 |
| `devops` | every host tool, including `bash`, builds, and tests | 1, enforced globally |
| `editor` | reads and edits, without `bash`, `shell`, `eval`, `python`, `task`, or `manage_skill` | 10 |
| `inspector` | read-only: `read`, `grep`, `glob`, `find`, `ast_grep`, `web_search` | 10 |

Every role sees the same one `js` tool and the same system prompt, so chaining roles along one path with the same model reuses the provider prompt prefix cache: an `inspector` explores and turns `done`, then an `editor` forked under it edits without reading the same files again. `state.role` reports the current scope's role in every REPL probe.

Only the single running `devops` is an admission gate. The other numbers feed `state.scopes_summary`, which a `manager` probe prints when `state.scopes_delta` appears: reported capacity minus the scopes now `running` per role, with `+` marking the lower bound and zero-idle roles omitted. Root counts as one running manager.


Every `path` names one new subscope; a bare name (`"worker"`) is relative to the caller (`state.scope`), while a relative or absolute path (`"../api/spy"` or `"/api/spy"`) places the subscope under any existing upscope (`running` or `done`, including `/`). Duplicate paths fail closed (`DUPLICATE_SCOPE_PATH`), and no automatic `-2/-3` renaming occurs.

A scope's context is inherited from its `upscope` (its path parent's last closed turn snapshot), while its `scope_return` delivers to its `caller` (`ownerId`). To inspect or build on any `running` or `done` scope without disturbing it, fork a spy subscope under its path (e.g. `path: "/api/spy"`): it inherits `/api`'s context snapshot and prefix cache, and delivers `scope_return` directly back to you. Omitting `model` inherits the upscope's model and thinking level. The probe prints `state.scopes_delta` (only when changed) with overwrite semantics per path (`running | <model> | <base>+ / <window>` or `done | <model> | <ctx> / <window>`), including Root `/`.

## Fork, join and return

`scope_fork({ forks: [...] })` starts one new subscope per item. Each item carries `path`, `fsm`, `profession`, `n`, and an optional `model`; a blank `fsm` or `profession` rejects the item. `budget` and `targets` are optional: a `manager` passes `{}` or nothing, an `inspector` may fund only its read-only tools, an `editor` may not fund `bash`, `eval`, `python`, `task`, or `manage_skill`, and only an `editor` must name concrete file paths in `targets`. The wall clock is not a model field: the system derives it as the session's mean LLM-request duration times `max(1, sum of turns || n)` (one minute per turn until a request has been measured, and never less than one second). The clock covers tool execution too: a bash or test run spends wall time without spending turns, so an I/O-heavy scope can reach its deadline first — an over-deadline call still returns its result and is recorded in the panhandle count, so the clock is a receipt, not a fence; size the turns for the time the work needs. One invalid item rejects the whole call before any child starts; an array may hold several items, and one assistant message may hold several `scope_fork` calls. A scope is sized by the work in hand, not by a table: budget about `sqrt(2n)` turns, where `n` is that scope's share of the work counted in ideal turns. Two, because a worker's real work runs back and forth — about two turns for every ideal one. Fork as much as the work allows — a wide batch costs one call — and say so inside every item: a child that finds independent work forks again in turn. Nothing else is capped: no turn total, no items per call, no tree depth. A scope that is too small wastes one fork; a scope that is too large puts the whole job on one context, and no receipt can repay that.

`scope_join({})` receives one eligible child result. In a message with other calls, place it last: its result is a whole working record and reads best after the other results. `scope_return` runs alone in its script. The record holds what the child's assistant said, in order, with one line per tool call written as `name(key="value", ...)`: assistant text lines and `js(code="…")`, `read(path="a.mjs:1-20")`, `edit(path="b.mjs")`, `bash(command="ls -la")` lines, joined by newlines. A string argument is quoted, any other value is compact JSON, and no argument is truncated or filtered. Tool results, thinking blocks, and user broadcasts are absent. `scope_join` has no time limit: while it waits, the parent's wall clock stops and the wait is added back to its deadline. A child that will not return is closed with `scope_abandon({ target })` instead of being waited on. `scope_return` answers in the same beat: the record is sealed and queued for the parent's next join, and nothing is left parked, so a finished scope's session stays alive and idle. A manager's time budget does not include the people it hired; turns and time stay independent.

Call `scope_return` alone in its script, always with non-empty `dafny`. The oath field is required: `signed_sealed_hands_off_nothing_left_on_the_table: "unfinished"` rewinds the context and continues the same scope; a child keeps its birth instructions and latest report. The new report replaces the old one, so carry forward evidence and unresolved work that still matter. To publish a child's record, pass `"a_ferocious_audacious_master_would_change_nothing"`; the child seal appends the trimmed `dafny` to the record. At root the same oath carries the same weight: `unfinished` rewinds, and the seal value permits the final answer. Any unreceived children transfer to the receiving scope and keep their identities and turns. An unsealed child that stops is nudged to return.

A scope's budget and wall clock come from the `scope_fork` item that created it. The parent's budget never funds a child and never shrinks when a child starts. The root has no budget and no wall clock, so it cannot run ordinary tools: it plans, forks, joins and answers, and the work runs in a child. Free control tools (`scope_fork`, `scope_join`, `scope_return`, `scope_abandon`, `wait`, and `ask` in manual mode) stay available at the root; a `read` or `write` of a built-in protocol URI (`skill://`, `local://`, `ssh://`, `agent://`, `xd://`, `omp://`…) spends no turn wherever it is bound, and the root binds neither, because the active policy sections are already in its system prompt. Turns are a ledger, not a fence. When a scope's turns for a tool are spent, the call still runs and the receipt records that the call was panhandled; the scope's panhandle count travels with its record, so the caller reads it at `scope_join`. Panhandling buys the call and nothing else: it is the receipt saying in public that the scope sized itself wrong, and a scope that panhandles its way to a checkpoint has told its caller it could not plan. The root is the one exception, because it is outside every scope and holds no budget to overrun. `scope_return` belongs to every manager: at root it ends the session's work, and in a forked scope it submits the record to its caller.

The root (`Root`) keeps its native transcript and input stream. Descendants at every depth appear in the main transcript as labelled message and tool components; full records arrive through `scope_join`. Root and descendants compete equally for one streaming slot: the first stream holds it through completion, and an overlapping stream appears as a single block after it ends. The native working row displays `[Busy: X, Idle: Y]` and the path to the latest requesting scope, omitting `Root`. Each fork item supplies a short `scopeId` such as `oh-my-pie`, displayed as `Oh My Pie`. Only explicit tool prompts and approvals can use the root UI. An accepted child oath ends the child loop at the tool-result boundary, without an extra model request or an interruption message.

Depth is not a policy. A child reads the same rule its parent read — fork when the work splits, budget the turns the rule above derives from `n` — so a larger job becomes a deeper tree rather than a fatter scope, and the tree stops where the work stops. What each extra layer costs is context: the record compresses to prose once more, and every ancestor's plan rides in the child's prefix. A child's birth receipt states its place as `depth X` and attaches no default and no recommendation. A single-child relay layer buys nothing; ask first whether the leaves are cut too fine. Never serialize ten independent closures into repeated root waves to keep the tree shallow: that spends the root's attention on records instead of giving them one subtree.

The control tools exist in every supported configuration. There is no `scope` tool, no `begin`/`end` argument, no alias and no fallback: a configuration that cannot support fork/join/request refuses the call instead of registering the retired tool.

## Redirecting or stopping a running scope (`scope_abandon`)

`scope_abandon({ target, reason? })` interrupts any single `running` scope at exact path `target` (never `/` or yourself) and forces its next turn into `ABANDONED` mode where only `scope_return` is bound. It stays `running` briefly while writing its final `dafny`, then turns `done` without rewinding (any oath value is accepted); it does not cascade to other scopes. Pass `reason` so the target knows what to preserve in `dafny` and its caller knows why it was stopped. To redirect a running scope mid-flight, abandon it, wait for it to turn `done`, and fork a new subscope under its path (e.g. `"/api/v2"`).

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

With `omp plugin link`, `~/.omp/plugins/node_modules/herdchestra-host-omp` is a symlink at `host-omp/`, so every edit here is live after a restart — no sync step. `sync:plugin` detects that shape, prints `link install` and writes nothing; it also refuses to touch a link that points outside this repository. The three meta skills live in the core's `resources/skills/`; the feature policy sections live in `resources/prompts/features.md`. Both are composed into the managed system-prompt block only when enabled; the host package ships no `skills/` directory.

With `omp plugin install <git-url>`, the host installs and resolves a copy under its own plugin directory. That directory is the host's, not this tree's, so `sync:plugin` classifies it as `installed copy` and writes nothing; refresh it by installing again. A `--vendor` run is the separate case: only an explicit `--vendor` (or `HERDCHESTRA_SYNC=vendor`) lets the script write a real directory — the host package at the target root, and the core under the target's `node_modules/herdchestra-lite2` (including `resources/skills/` and `resources/prompts/features.md`). In that mode an edit here does not reach a running session until you sync again. `sync:plugin` never writes through a link, so it can no longer rewrite this repository's own `package.json`.

Restart the session afterwards; modules load at process start.

Tests stay in the repository root and cover all three packages: `bun test tests` runs the core domain, both host wirings, and the architecture ratchets that hold the boundaries. `bun run smoke:relay` tests the working tree against a fake host. It checks fork/join registration and refusals, along with return and rewind behavior. It does not test the installed copy.

## Skills and policy sections

The system prompt is mechanism plus feature policy. Mechanism lives in `resources/prompts/system.md` and `resources/prompts/tools/fork-join.md`; policy lives in `resources/prompts/features.md` as `## <feature>.<state>` sections. `src/prompts/inject.mjs` composes the managed block in `FEATURES` order.

Only three meta skills remain under `resources/skills/<name>/SKILL.md`; they are inlined only when `workspace=full`:

| Skill | Question |
|---|---|
| `polish` | How: preserve claims, causal links, and voice while improving expression |
| `prompt-craft` | Where model-facing text lives and how to write it |
| `skill-authoring` | How to split, name, and maintain a skill |

The former `constitution`, `decision-framing`, and `tdd-crowdsource` skills are now the `constitution.*`, `framing.*`, and `testing.*` policy sections. `workspace=personal` carries the human-facing repository conventions; `workspace=full` adds the three meta skills.

The inlined meta skills are authoritative when enabled: apply `prompt-craft` before changing model-facing text, `skill-authoring` before creating or splitting a skill, and `polish` before polishing an existing text. The `framing.*` and `testing.*` sections carry decision and verification policy. Keep design artifacts as skills under `.agent/skills/<name>/SKILL.md`.

Model-facing text lives in `resources/prompts/` as Markdown documents with `## section` blocks. Code loads them through `src/prompts/index.mjs`; no prompt, tool description, parameter description, receipt, or model-facing error is duplicated in source.

## Scope targets

Every fork item declares `targets`, a non-empty array of natural-language descriptions of what it expects to create, read, update, or delete. An item may name a file path, a part of the source, a behavior, or a goal; any human language is valid, and a path is only one kind of target. For example, `["fix any defect you find", "the parts of the source that involve caching"]` is valid. The field is required: a missing, empty, blank, or non-string entry rejects the whole batch.

`targets` is a declaration, not an enforcement boundary. The system never audits a tool call against the list; a scope that turns out to need another target may still touch it. The required list is the mistake-proofing: a scope that can name no output is not a separate scope, so think again before forking one. A refused batch changes no state, and no flow starts.

## Feature switches

Every switch uses one grammar, and the same names work as environment variables. `/herd` prints every value; `/herd <feature>` prints the current value and allowed states; `/herd <feature> <state>` sets and persists; `/herd <feature> <state> <text...>` also sends `<text>` as one plain user message. Only the user can set a switch; no model turn can enter or leave one.

`/herd-goal <instruction>` is not a switch and holds no state of its own. It starts one goal session at the root in `ROOT_AUTOPILOT` mode — `ask` is not bound and a natural stop is redirected to `scope_return` — and sends `<instruction>` as one plain user message. The mode ends by itself when the sealed final answer is delivered, so the next turn is ordinary manual mode again. An interrupted turn (Esc) keeps goal mode on, so the next message continues the goal; a bare `/herd-goal` turns it off immediately.

| Feature | States | Default | Effect |
|---|---|---|---|
| `chinese` | `off` / `on` | `on` | Adds the Chinese thinking/reply requirement to the system prompt and the per-turn probe. |
| `testing` | `off` / `no-red` / `lean` | `lean` | `no-red`: skip running Red. `lean`: adds static-first verification, focused checks, and unrun-check handoff. |
| `constitution` | `off` / `core` / `full` | `full` | `core`: ledger, Chesterton's fence, poka-yoke, anti-Goodhart, candor. `full`: adds style, clean break, read-the-whole, courage. |
| `framing` | `off` / `plan` / `full` | `full` | `plan`: goal, Bayesian model, residual, asymmetric bet. `full`: adds the three introspection gates. |
| `scope` | `off` / `adaptive` / `aggressive` | `aggressive` | `adaptive`: fork independent slices, put exact facts in `dafny`, watch the 50% context lock. `aggressive`: adds `sqrt(n)`, manager-not-labourer, and always-parallel guidance. |
| `workspace` | `off` / `personal` / `full` | `full` | `personal`: repository conventions, human-facing prose, ask-below-95%, design records. `full`: adds the three meta skills. |

`off` means no policy text for that feature: the model falls back to the host's defaults. The defaults above reproduce the 6.0 prompt, except that the three retired skills now live in `features.md`.

The canonical environment variable is `HERD_<FEATURE>` — `HERD_CHINESE`, `HERD_TESTING`, `HERD_CONSTITUTION`, `HERD_FRAMING`, `HERD_SCOPE`, `HERD_WORKSPACE`. Precedence is explicit environment > persisted state > fallback. `HERD_DISABLE_<FEATURE>=1` maps to `off` when `off` is valid. Legacy `HERD_CHINESE_REMINDER=on|off` and `HERD_DISABLE_CHINESE_REMINDER=1` map to `chinese`; the canonical variable wins. `HERD_HERD=off` disables `/herd` itself.

`ask` is bound only at the root in manual mode; `/herd-goal` withholds it for that goal session.

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

## Root return

At root, an `unfinished` return uses compaction to rewind and continue. Root keeps verbatim user prompts and steers as actual messages, plus the new `dafny` report. Do not repeat those user messages in the report. The old report is replaced, not appended: carry forward any evidence a later turn still needs.

Root must receive all outstanding children with `scope_join` before sealing. The oath then works exactly as it does in a subscope: `unfinished` rewinds through compaction, and the seal value ends the work — `canStop` flips on, the next turn binds no tools (`FINAL_ANSWER`), and root writes the final answer. Opening a new fork or receiving a new user message clears `canStop`. There is no review round and no oath streak. A natural stop is not a rewind or an oath. A goal session started by `/herd-goal` ends automatically once the sealed final answer is delivered.

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
  path: "review-results",
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
