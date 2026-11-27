# Changelog

All notable changes to this extension. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [9.0.1] — 2026-11-27

### Changed — every layer is one station, one ticket, one owner of each fact

Whole-repository clean break that brings `src/`, `host-omp/`, and `host-omp-ui/` back
under the Ticket Station Method without changing observable behaviour.

- **Capabilities are injected once.** `SessionStation` no longer seeds a dozen
  `forkXxxPort` lambdas and lets two wiring stages overwrite them one at a time.
  One immutable `ForkContext` (`src/station/domain/fork-context.mjs`) is attached at
  construction; the read-only facades delegate to it, and a station without one
  answers from an unbound bundle instead of throwing mid-turn.
- **Process-wide state has an explicit owner.** The `Symbol.for` carrier on the
  ledger, the module-level `RUNNING_BY_LEDGER` table, and the lazily defined
  `WeakMap` on the wiring are gone: one `ForkProcess` value object holds the
  registry, the ledger index per conversation, the running set per ledger, and the
  per-station attach record. In the host, one `host/process-registry.mjs` owns
  `forkWiring`, `statusState`, `transcriptListeners`, and `captureState`, with each
  slot's arbitration policy written next to it.
- **`src/scope/**` is statically synchronous.** The parking half of the fork
  registry (`park`, `waitForReady`) moved to the ticket layer
  (`src/tools/join-wait.mjs`), so the eslint exemption for
  `src/scope/fork-registry.mjs` is removed and the whole directory is covered.
- **Tickets never write station fields.** Root and child rewinds, the host-boundary
  cache, the printed-tree baseline, the receipt bookkeeping, and the model-switch
  queue are five pure kernels under `src/station/domain/` (`rewind`,
  `host-boundary`, `directory-baseline`, `projection`, `usage-sample`); `gates.mjs`,
  `handoff-state.mjs`, `models.mjs`, `return-controls.mjs`, and
  `spawn-ticket.mjs` call station methods (`noteHostBoundary`, `armRootRewind`,
  `consumeChildRewind`, `commitChildRewind`, `displayContext`) instead of assigning
  internal fields. The child rewind rewrites the branch through the station, so
  root and child rewind share one reset implementation.
- **Host shape and engine entry are single.** `shapeHost`/`mergeHost` moved to
  `src/core/host-shape.mjs` and accept the grouped shape only; `src/engine.mjs`
  exposes `station`, `peekStation` (never mints a station), and
  `isReadOnlySubagent`, so `host-omp` no longer probes two spellings or mirrors the
  `"read-only-subagent"` string.
- **Two claim-one-receipt defects are fixed.** `childReceiptText` renders the
  identity line itself, so the priced length and the sent text are the same
  string even when `profession` carries surrounding whitespace; join admission and
  join delivery read one `joinEnvelope`, and `finalizeJoinRecord` is the single
  commit path.
- **Refusals are one table.** `src/station/errors.mjs` holds every decision code
  with its documentation entry, placeholders, and structured details; the fork,
  join, return, and abandon handlers carry no second copy of the wording.
- **`host-omp-ui` station does not reach into the host.** `delta-merger` moved to
  `station/domain/`, `SERVER_FRAMES` and `DRAFT_FRAME` to `protocol-codec.mjs`,
  `commitTicketResult` to `station/domain/ticket-result.mjs`, and the interaction
  route is decided by the station. `manager/server.mjs` is transport only:
  `ManagerStation` owns the clients, agents, waiters, and operation tokens, and
  three tickets own the async flows.
- **Message and frame vocabularies have one home.** `host-omp/src/host/usage-ledger.mjs`
  owns the Σ and the new-ledger rule; `branch/refusals.mjs` owns the branch
  refusal and limitation codes; `child-display/tool-tray.mjs` owns the active-tool
  tray; `host/tickets/attachments.mjs` owns the attachment envelope.

### Added — ratchets that fail on the next regression

- `tests/architecture/skill-records.test.mjs` checks that every design record under
  `.agent/skills/` names its own directory and quotes only paths that exist.
- `tests/host-omp-ui/frame-vocabulary.test.mjs` checks that every frame the bridge
  sends has a browser case.
- `tests/host/user-abort-routing.test.mjs` checks that an interrupt answers from one
  engine, never calls a second match, and never builds a station for a context
  nobody owns.
- `station-ratchet.test.mjs` gained rewind and cache ownership sections;
  `host-omp-ui-boundary.test.mjs` now forbids `src/station/**` importing
  `../host/**`; `fork-fsm-pricing.test.mjs` pins priced-equals-sent with padded
  input; `manager-session-contract.test.mjs` pins the release of a timed-out
  new-session slot.

### Fixed — an interrupt could abort twice or build a stray station

- `host/user-abort.mjs` stopped at the first engine that owns the context and
  recorded a diagnostic on a miss, instead of calling every match and then calling
  the last engine anyway (which entered `stationFor` and minted a station for a
  foreign context).
- `manager/session-service.mjs` bounds `newFlights` with the same deadline as
  `inFlight`, so a launch that never registers can no longer hold a cwd's slot for
  the life of the process.

### Removed — dead weight and the last transitional facades

- `src/scope/forkjoin.mjs`, `src/scope/persistence.mjs`, `src/scope/plain.mjs`, and
  `src/scope/amount.mjs`: every caller imports the leaf module; the shared helpers
  live in `src/core/primitives.mjs`.
- The duplicated `JSDoc` blocks in `ledger-serialize.mjs`, `ledger-entry.mjs`, and
  `ledger-charge.mjs`, the dead `ledgerOf` read model, and the `gates.onAgentEnd`
  synchronous rewind fallback (a second implementation of a rewind the host ticket
  owns).

## [9.0.0] — 2026-11-27

### Changed — root `scope_return` matches every other manager (breaking)

- Root no longer runs a two-seal review gate. The seal oath (`a_ferocious_audacious_master_would_change_nothing`) ends root's work on the first call: `canStop` flips on, the next turn projects `FINAL_ANSWER` with no tools bound, and root writes the final answer. `unfinished` still rewinds through compaction with the latest report and the verbatim user messages.
- Removed the `review` feature (`/herd review off|on`, `HERD_REVIEW`), `relay.bigStreak`, and `pendingRewind.big`; `resetRootPromotion` now only clears `canStop` on a new user message or a new root fork.
- `system.md`, `fork-join.md`, `receipts/relay.md`, `README.md`, and `.agent/skills/scope-orchestration/SKILL.md` follow the single-seal protocol; `return.review` and `reborn.review` are gone.

### Changed — `autopilot` is a one-shot goal, not a switch (breaking)

- Removed the persistent `autopilot` feature (`/herd autopilot off|on`, `HERD_AUTOPILOT`). Root now defaults to manual mode: `ask` is bound and a natural stop is allowed.
- New command `/herd-goal <instruction>` starts a single goal session in `ROOT_AUTOPILOT` mode and sends `<instruction>` as one plain user message; `ask` is withheld and a natural stop is redirected to `scope_return`.
- The goal session ends automatically on the next turn after the sealed final answer is delivered, so manual mode returns without a second command. `state.autopilot` still reports whether a goal session is active.

### Added — goal mode is visible and holdable

- The working row reports goal mode: `[Busy: N, Idle: M, Goal: ON]` while a goal session is active, and the plain `[Busy: N, Idle: M]` otherwise.
- An interrupted turn (Esc) keeps the goal session; the next message continues it. Only the sealed delivery or a bare `/herd-goal` releases it.
- A bare `/herd-goal` turns goal mode off immediately and is idempotent when it is already off.

## [8.0.0] — 2026-11-27

### Changed — role-bearing scope paths (breaking)

- A scope path segment is now `<role>.<name>`: the role decides which host tools the scope may hold. Root `/` is a `manager`, and privilege narrows monotonically — `manager > devops > editor > inspector` — so `scope_fork` and `scope_abandon` refuse a wider role than the caller's. A segment without a role is no longer a valid scope id.
- New `src/scope/roles.mjs` owns the ranks, the per-role host-tool sets, the `editor` concrete-file `targets` check, and the single-`running`-`devops` mutex; `fork-join.mjs`, `capabilities.mjs`, `abandon.mjs`, and `tool-view.mjs` consume it without importing each other.
- `scope_fork` items now require `path`, `fsm`, `profession`, and `n`; `budget` and `targets` are optional and role-checked (`FORBIDDEN_ROLE_BUDGET`, `INVALID_EDITOR_TARGETS`). `state.role` reports the scope's role in every REPL probe.
- `README.md`, `resources/prompts/**`, the scope receipt, and `.agent/skills/scope-orchestration/SKILL.md` document the role model; the host UI tool view follows the new control surface.


## [7.0.0] — 2026-11-27

### Changed — immutable-context decoupling (`upscope` / `subscope` / `caller`)

- Removed `scope_request`, `scope_reply`, `AWAITING_REPLY`, `request-queue.mjs`, `request-controls.mjs`, `cold-wake.mjs`, and `resumeBranchSession`.
- `scope_fork` now takes `path` (relative to caller or absolute `/...`), fails closed on duplicate paths (`DUPLICATE_SCOPE_PATH`), unknown/unready upscopes (`UNKNOWN_UPSCOPE` / `UPSCOPE_NOT_READY`), and invalid segments. Omitting `model` inherits the upscope's resolved model and thinking level; fork admission checks the upscope's context snapshot against the new subscope's window; empty `{}` budgets receive at least 1 turn of derived wall-clock time.
- Cross-branch spy subscopes inherit their upscope's `safeSnapshotLeafId` (validated closed, no dangling `toolCall`) while delivering `scope_return` directly to `caller` (`ownerId`).
- Global scope directory (`running | <model> | <base>+ / <win>` and `done | <model> | <ctx> / <win>`, including Root `/`) is delivered via sparse overwrite-semantics `state.scopes_delta` (zero noise while `running`, baseline reset on Turn 1 / rewind / compaction / resume).
- `scope_abandon({ target, reason? })` interrupts any single `running` scope (never `/` or self) and forces its next turn into `ABANDONED` mode (only `scope_return` bound, never rewinds, skips oath validation, reparents orphans on return, idempotent if already abandoning, with bounded-nudge forced-close fallback).
- Ledger snapshot bumped to `version: 3`.

## [6.2.1] — 2026-11-27

### Changed — one module per responsibility across the ledger, the stations, and the host

Five modules had grown into catch-alls: `src/scope/forkjoin.mjs` (1554 lines),
`src/scope/persistence.mjs` (1418), `src/station/fork-controls.mjs` (927),
`host-omp/src/host/pricing.mjs` (595), and `host-omp/src/host/host-tickets.mjs` (578).
Each now sits behind single-purpose modules:

- `src/scope/ledger-{entry,brackets,charge,serialize}.mjs` plus `state-delta.mjs`,
  `state-codec.mjs`, `amount.mjs`, and `entry-plan.mjs` carry the ledger;
  `forkjoin.mjs` and `persistence.mjs` keep only their own coordination.
- `src/station/{fork-reads,join-controls,return-controls,abandon-controls}.mjs` split the
  `scope_fork` / `scope_join` / `scope_return` / `scope_abandon` controls out of
  `fork-controls.mjs`.
- `host-omp/src/host/tickets/{prompt,model,model-identifiers,rewind,steer}.mjs` replace
  `host-tickets.mjs`; `host-omp/src/host/pricing/` replaces `pricing.mjs`;
  `host-omp-ui/src/host/tickets/{delta-merger,fence-ticket}.mjs` replace `bridge-tickets.mjs`.
- `host-omp-ui/src/station/domain/{artifact-hydration,fence-lifecycle,history-window,snapshot-doc}.mjs`
  split `ui-bridge-station.mjs`.

### Changed — the tool-view protocol is shared source, not two copies

`host-omp-ui/shared/tool-view.mjs` and `shared/transcript-groups.mjs` now hold the
rendering protocol that the extension and the web bundle both read, and `shared/` joined
the package `files` list. `web/src/protocol/tool-view.ts` keeps only the web-side types,
and its parity test runs against the shared module.

### Changed — `src/wiring/fork-wiring.mjs` is the single wiring module

`src/scope/fork-wiring.mjs` and `host-omp/src/host/index.mjs` are gone; the composition
root lives in `src/wiring/` and nothing outside it assembles tickets.

### Changed — the probe's clock entry states its direction

`state.remaining.time` printed `6:46/6:58`, which reads as an elapsed span as
easily as a balance. It now prints `6:46 left of 6:58`; `OVERTIME` is unchanged.
`resources/prompts/system.md`, `resources/prompts/tools/fork-join.md`, and the
`ScopeState.remaining` comment now spell out the whole field: every tool entry is
`remaining/budget` in turns, the clock is `<left> left of <budget>` in `m:ss`, and
`panhandled` is the cumulative count of calls that ran past their budget.

## [6.2.0] — 2026-11-27

### Changed — `scope_return` requires an explicit oath (breaking)

The oath is no longer optional. Pass `unfinished` to rewind or the seal value to
deliver; a missing field, `undefined`, `null`, or a typo is refused with
`INVALID_RETURN_OATH` instead of defaulting to a small handoff.

### Added — one process-wide FIFO barrier for file-writing tools

Two concurrent `edit`/`write` calls on one file both read the old bytes, so the
later write silently erased the earlier one while both reported success.
`host-omp/src/host/write-serialization.mjs` queues every write tool (including
`ast_edit` and patch input) behind one module-level FIFO. A write whose targets
cannot be named takes the exclusive key instead of guessing; a nested write runs
at once only when its ancestor already covers its targets; an aborted queued
call leaves the queue immediately.

### Fixed — a pending root rewind survives the host's async pause

`onAgentEnd` returned early on every `willContinue: true` event, including the
pause created by the rewind run-hold job itself, so the rewind never resumed. It
now proceeds when the pause reports `awaitingAsyncWork`, holds the host run until
`agent_start`, and emits an error assistant when takeover fails.

### Fixed — context preparation tolerates repeated or appended tails

Tail positioning no longer aborts the turn when the same frame repeats an entry
or another writer appends after it; the mismatch is recorded as a tolerated
diagnostic.

### Fixed — `cwdOf(ctx)` never guesses a cwd

The write barrier needs the session cwd to key two paths to one lock. It returns
`null` when the context carries none, so the call takes the exclusive key instead
of pairing two writes under different locks.

## [6.1.2] — 2026-11-27

### Fixed — single shared `ForkRegistry` for `scope_request` / root runtime and full post-seal drain

- Stopped storing `StationRegistry` on `station.registry` and froze `createStationRegistry()`'s returned method table so accidental writes throw `TypeError` instead of splitting state across extension instances.
- Added `SessionStation.prototype.forkRegistry()` and `forkRegistryOf(station)` so `capabilitySnapshot`, `requestRuntime`, `noteRootRuntime`, `beginRootBeat`/`endRootBeat`, `skillReceipt`, `request-controls.mjs`, `handleAbandonCall`, `cancelTree`, and `returnTicket` all read and write the shared `ForkRegistry`.
- Initialized `requests`, `waitFor`, `waitEdgeRefs`, `requestRuntime`, and `requestSeq` on `createForkRegistry()` and made `request-queue.mjs` read/delete helpers side-effect free.
- Moved root beat tracking (`beginRootBeat` / `endRootBeat`) onto `SessionStation` and cleared child runtime + pending requests on `cancelTree`.
- Replaced single-item post-seal delivery in `spawnChildTicket` with `drainRequests()`, and skipped draining/idle registration when a child branch is cancelled.

## [6.1.1] — 2026-11-27

### Fixed — root is told that `api.bash` is absent

Root holds the control plane and no host tools, so a `bash` call throws
`TypeError: api.bash is not a function` and spends a turn for nothing. The
prompt says so beside the rule that root plans, forks, joins and answers, and
names the remedy: fork a scope that holds the capability, then join its record.

## [6.1.0] — 2026-11-27

### Changed — one `/herd` command replaces `/herd-autopilot` (breaking)

`/herd-autopilot` is gone. Use `/herd autopilot off|on`; the same grammar sets
every feature: `/herd` lists, `/herd <feature>` shows the allowed states,
`/herd <feature> <state>` persists, and `/herd <feature> <state> <text...>`
also sends one user message. Only the user can set a feature.

### Added — eight orthogonal feature switches

`autopilot`, `review`, `chinese`, `testing`, `constitution`, `framing`,
`scope`, and `workspace`. Defaults reproduce 6.0. Each switch accepts
`HERD_<FEATURE>`; explicit environment beats persisted state, which beats the
fallback. `HERD_DISABLE_<FEATURE>=1` maps to `off`. Legacy
`HERD_CHINESE_REMINDER` and `HERD_DISABLE_CHINESE_REMINDER` still map to
`chinese`.

### Added — `resources/prompts/features.md`

The prompt is now mechanism plus `## <feature>.<state>` policy sections. The
three retired skills — `constitution`, `decision-framing`,
`tdd-crowdsource` — moved into those sections. Only `polish`,
`prompt-craft`, and `skill-authoring` remain as meta skills, inlined only at
`workspace=full`.

### Changed — session state carries `features`

`state.autopilot` is replaced by `state.features`; the map is shared by root
and children. Persistence writes `features` and migrates an old
`autopilot: true` snapshot to `autopilot=on`. The capability signature now
includes `chinese`, so a mid-session change refreshes the receipt.

### Fixed — `scope_abandon` in the Api declaration

The control-plane declaration now lists `scope_abandon`, matching the live
binding.

### Fixed — disable switches for ports without `off`

`HERD_DISABLE_<PORT>=1` is refused when the port has no `off`
implementation, instead of returning an illegal `off`.

### Fixed — js interrupt behavior decided from in-flight ops

A `js` call is one beat, and its interrupt decision now reads the in-flight
operation type instead of the tool name or the script text. `scope_join`,
`scope_request`, `wait`, and `ask` are waits; every other call is work. A
steering message aborts only waits and lets the script finish; an explicit
abort aborts every operation. After a steer, a new wait throws
`BEAT_NO_MORE_WAITS` and a new work call throws `BEAT_STEERED`. An interrupted
beat closes once, records the abandoned operations, and refuses later `api`
calls without dispatching or billing them.

## [6.0.0] — 2026-11-27

### Changed — the language reminder prints as an output comment

The per-turn probe closes with a plain output line `# System Requirement: ...`,
with no `> ` input prefix, so it reads as a YAML comment under the state block
rather than as a command line.

### Changed — scope copy speaks in location, and the split guidance is two rules

The model in a forked scope is the same self at another path, so model-facing
text no longer calls scopes parents, children or siblings. It says "the scope
above you", "a scope you started", "`..` for the scope above you". Split
guidance is two rules: forking stops two levels below you, and the count is
about `sqrt(n)` for an `n`-turn estimate. The per-scope sizing formula and the
paragraphs on batching, blocked items, and dependency scheduling are gone; the
tool mechanics are unchanged.

### Changed — the REPL probe and js results print block YAML

The probe used to end with one `util.inspect` line, and a js result used the
same renderer: multi-line text arrived as `\n` escapes and a deep table sat
on one row. Both now go through `renderYamlView`, which prints block mappings
and sequences, a `|`/`|-` literal block for multi-line strings, and quoted
scalars only where YAML would read them differently. Bun's own `stringify`
stays out of the display path: on 1.4.4 it emits one flow line, keeps newlines
escaped and throws on `BigInt`.
- The probe's command line stays
  `> ({ api: Object.keys(api), ...state })`, a valid JS expression; the js
  tool renders its value with the same `renderYamlView`, so the printed
  document is what that command returns.
- Strings still pass through raw in a js result; only non-string values render
  as YAML.

### Added — `scope_abandon` closes a child that will not return

A forked scope that never calls `scope_return` used to hold the parent's join
open; `scope_return` refuses while a child is unreceived, so nothing
model-facing could close it. One new verb closes the bracket. The join itself
keeps waiting for as long as the child takes — a bound would waste a slow
child's work — and a user message ends a parked join without a record.
- `scope_abandon({ target })` closes one exact child: a running child becomes
  ready-with-failure so a parked join takes it, its descendants close with it,
  its agent stops, its queued `scope_request`s reject, and the registry wakes
  every waiter. The record is kept so the join can report the failure.

### Changed — one `js` tool replaces the native tool surface (breaking)

The model sees exactly one tool. Every other capability — the host's file,
shell and web tools, MCP tools, and this extension's own control plane — is an
async method on the `api` object that the single `js` tool builds each turn.
The point is not fewer tools for their own sake: a fixed `tools` array and a
fixed system prompt are what let the provider cache survive every state
transition, and a capability the model cannot name is one it cannot call.

- `projectCapabilities()` in `src/station/domain/capabilities.mjs` is the one
  owner of "what is bound this turn". It feeds three consumers from the same
  projection: the methods the `js` ticket binds, the trailing REPL probe that
  prints them, and the signature that decides whether a committed receipt can
  be reused.
- The trailing per-turn message is now a REPL transcript rather than an
  `<additional-system-instructions>` block: `> ({ api: Object.keys(api), ...state })`
  followed by one object literal, plus a `> delete api.<name>` line on the one
  turn where a method disappears. Same `role`/`attribution`/`herdSkill`
  envelope as before, so the web client keeps folding it into a step group.
- The signature hashes the exact object the probe prints, not just the mode.
  A mode-only signature let a stale `remaining`, scope list, or clock survive
  every turn inside one mode and print a budget that had already been spent.
  The probe is the last message, so rewriting it costs no cached prefix.
- Four hard modes replace prose nagging: `AWAITING_REPLY` (only `scope_reply`),
  `CONTEXT_LIMIT` (only `scope_return`), `FINAL_ANSWER` (no `api` methods), and
  the default family (`CHILD`, `ROOT_MANUAL`, `ROOT_AUTOPILOT`). The order is
  `AWAITING_REPLY` > `CONTEXT_LIMIT` > `FINAL_ANSWER` > default.
- `scope_request({ target, message, interrupt })` replaces the asynchronous
  `scope_send` mailbox. It waits for the target's `scope_reply(text)` and
  rejects a wait-for cycle before parking, so a request can never deadlock the
  tree. `interrupt: true` aborts through its own symbol, never through the
  user's abort, so the web stop button still cancels the whole tree and a
  request never does.
- Tool results are info-rich objects (`{ ok, started, failed, unreceived }` for
  fork, `{ ok, scope, reason, record, persisted, note }` for join) instead of
  prose receipts. `scope_fork` keeps its explicit `{ forks: [...] }` batch.
- Removed with the tool face: `pin`, `amend`, and every `scope_context`
  argument; `todo` exposure; the fake first-turn `bash("pwd")` probe; the
  append-only inbox and its glob engine; the retired `labels.md` prompt
  document and the `ask-blocked` / `model-switch-warning` error keys; and
  `resolveModelPolicy` with the rate-table parsing behind it.
- The web client reads `toolResult.details.innerCalls` to rebuild a script's
  inner calls as their own cards and as artifact-drawer entries, and gives the
  scope control plane question/answer/subtask cards instead of raw JSON.

### Fixed — a fork issued from the `js` sandbox passes validation

The `js` tool compiles model code in a fresh `vm` context, so every object a
script builds carries that context's `Object.prototype`. `isPlainObject`
compared against this realm's prototype, so it answered no for every budget —
an empty one included — and `scope_fork` refused all of them with
`INVALID_BUDGET` while the item was otherwise valid. The single tool therefore
could not start a single scope.

- `src/scope/plain.mjs` is now the one owner of the predicate. It decides
  shape, not realm: a null prototype, or a prototype whose own prototype is
  null, is plain data; a class instance, `Date`, `Map` or array still is not.
- `state`, `forkjoin`, `turns`, `panhandle`, and `persistence` import it
  instead of carrying a copy; `forkjoin` held the second copy with the same
  defect.
- `tests/station/domain/fork-join.test.mjs` pins a budget built in another
  realm as accepted, and a `Map` as still refused.

### Fixed — the control plane's contract reaches the model again

`js` is the only registered tool, so the five `scope_*` methods have no JSON
schema, and the refactor deleted `src/tools/descriptions.mjs`, the only thing
that carried `tools/fork-join.md` into one. The prose stayed, the tests kept
asserting it, and the model stopped receiving it: a fork had to guess
`budget` keys, the non-empty `targets` list, and the `"You are "` prefix, then
learn each rule from a refusal.

- `inject.mjs` compiles every section of `tools/fork-join.md` that declares no
  placeholder into the managed block, between §scope-rules and the tool
  declarations. A section that declares `{{…}}` is a receipt rendered
  elsewhere, so it is skipped: no raw template enters the prompt.
- The prose is trimmed in the same pass, 1 500 words to about 900, keeping
  every rule and dropping what `system.md` §Run scopes already owns.
- `system.md` drops the `Close the work` section that repeated §scope-rules,
  and the free protocol-URI rule moves back to §Run scopes with the budget it
  belongs to.
- `receipts/scope.md` drops `receipt.branch`, `receipt.branch-missing`, and
  `mode.remaining` (no renderer) and `context.nudge` (the hard mode replaced
  it); `fork.child-status` says "Turns left", so the retired word `balance`
  is gone from the model-facing copy.
- `errors.md` loses the eight sections no path renders: the `scope_request`
  and `js` refusals are worded in code, `mixed-return-tool-calls` duplicated
  the live `mixed-return` under an unread key, and three accounting sections
  were inlined with the panhandle long ago. `mixed-return` now says "script",
  not the retired "tool-call batch".

### Fixed — a forked scope is addressed by the frame that requested it

The `js` runtime mints a synthetic call id for each inner call
(`<frame>#<index>`), and the control plane used it as if it were the assistant
tool call in the journal. A child session is built from that frame, so every
fork refused with `NO_FORK_FRAME`; the refusal then left a joined scope in the
address book that no session could answer — one idle scope that never settled.

- `js-ticket` dispatches the enclosing frame beside the call id, and the
  catalog, the tickets, the station cores, and the fork/join/return handlers
  carry it. The synthetic id still keys the processed-call cache and the
  ledger's `forkId`, so one script may fork several times.
- The spawn spec writes `sourceToolCallId` from the frame, the join result
  reports `closeToolCallId` from it, and the return batch check compares
  against it.
- `listAddressableScopePaths` drops a record whose outcome failed, so a scope
  that never produced a session leaves `state.scopes`.
- `scope_request` refuses a target that never started or already failed with
  `REQUEST_UNREACHABLE`, instead of parking the caller on a promise nothing
  can resolve.

### Fixed — an inner tool resolves approval from the session, and a beat costs one turn

- The host's extension wrapper derives the approval mode from
  `context.settings`. An extension context carries none, so every host tool
  called through `js` resolved to always-ask: the root prompted, and a child —
  which has no interactive UI — threw `requires approval but no interactive UI
  available` and could not run `bash`, `write`, or `edit` at all. The catalog
  now attaches the session's own settings (`session.settingsOf` on the host
  bag) to the dispatch context, so `tools.approvalMode` decides for root and
  child alike.
- `chargeBranch` charged every call the tool's whole share of the beat: three
  reads in one script spent three turns. Each call now pays its tool's share
  over that tool's call count, so one beat costs one turn (two-decimal split).
- A child that fails or never publishes its record rejects its queued
  `scope_request`s instead of leaving callers parked, and `scope_request`
  refuses a finished scope with no wake hook with `REQUEST_UNREACHABLE`.
- §CONTEXT_LIMIT said "fork the remainder" while only `scope_return` is bound;
  the rules and the receipt now say to fork after the rewind, which
  re-baselines the context.

### Added — a stopped scope answers a request from its branch

A scope that finished its return kept an idle prompt handle only while its
process lived. Once that handle was gone — a reload, an abandoned cascade —
`scope_request` had nothing to wake, and a caller either parked or was
refused.

- The fork record carries `branchTail`: the child branch's leaf after the
  last completed turn, written by the spawn ticket wherever a turn is sent.
  `validRecord` accepts a non-empty string or absence; no snapshot bump.
- `resumeBranchSession` (host-omp) rebuilds one session over that branch —
  the live proxy when it exists, otherwise a proxy opened at the recorded
  leaf — and hands back a one-shot prompt.
- `coldWakeEntry` drives it: one wake turn per queued request, then teardown.
  The core installs the child identity for the wake and drops it after, so the
  record, its address, and its liveness are exactly what they were: a live
  scope stays live, a stopped one stays stopped.
- The reachability guard reads the runtime table from the registry as well as
  the station, so a live idle handle is never mistaken for a dead address.

## [5.1.0] — 2026-11-26

### Added — a scope that outgrows its context midpoint is asked to return

`(window - baseline) / 2 + baseline` is the midpoint between the context a
scope was born with and the model's input limit. When the occupancy the last
response ended at is strictly above that midpoint, the next request carries one
more `skill` in the per-turn trailing injection — the
`<additional-system-instructions>` block this session already receives at the
end of every turn — that weighs the record against another turn and urges
`scope_return` with a fresh `dafny`. Below or at the midpoint the skill is
absent, so a scope is not nagged forever.

- Baseline is measured, never estimated: it is the input the provider reported
  for the scope's first measured request, which for a fork is the first request
  of its own session. A rewind or a reborn scope re-baselines there, and a fold
  keeps the birth it already had.
- Occupancy is `lastTotalInput + lastOutputTokens`, the end of the last
  response, not the projected size of the next one.
- Every unknown refuses to arm: an unmeasured baseline, an unmeasured
  occupancy, or an unknown window. A window at or below the baseline arms at
  once instead, because the scope has no room left to grow into.
- The boundary is strict. Equality is the point where continuing still pays.
- The nudge never enters the system prompt. `injectSystemPrompt` produces the
  same bytes it produced before this feature, so arming and disarming cost the
  provider nothing: the trailing block is rebuilt per turn and is not part of
  the cached prefix. The text lives in `resources/prompts/receipts/scope.md`
  under `context.nudge`, rendered by `skillReceiptText`.
- `contextWindowTokens()` on the station is now the one owner of the window
  resolution order, and the fork admission reads it instead of resolving the
  catalog a second time.

## [5.0.0] — 2026-11-26

### Changed — `scope_return` rewinds unless the oath hands off (breaking for callers)

The relay ledger is gone, and `scope_return` becomes the one verb that both
continues and hands off. `todo` leaves the tool surface: it is host-side
working notes, and this extension neither reads nor drives it.

- `scope_return({ dafny })` without the oath rewinds the calling scope through
  compaction and continues it. The scope keeps its birth instructions, its
  pins, and its latest return report; a new report replaces the previous one
  instead of stacking generations, and the record's `handoffCount` counts these
  small self-handoffs.
- Root follows the same shape behind a review gate: the first oath rewinds it
  for an independent review against the user's own prompts, and the second
  consecutive oath promotes it to write the final answer without a rewind. A
  fork that starts new work on Root clears the streak synchronously, and a
  small handoff resets it.
- Root must receive every outstanding child before an oath; the refusal is a
  tool error, not a silent drop. A host that cannot rewind the Root session
  refuses the rewind before any state moves, so Root never holds a pending
  rewind that can never land.
- `scope_return` must be alone in its batch. A sibling tool call in the same
  message is refused, because a competing call could race the rewind boundary.
- The relay shrinks to rewind prompts: `ledger`, `policy`, and `texts` are
  deleted, and `receipts/relay.md` keeps only the `reborn` sections. The
  successor handoff, the verbatim user-prompt archive, the `Flow:` receipt, and
  the two-empty-ledger evaluation stop existing.
- A child's record starts at the latest birth receipt rather than the first
  message carrying the marker, so a scope that returned and was reborn no
  longer replays an older generation's inherited transcript.

### Removed

- The `todo` tool, `todoTicket`, and its prompt document. `resources/prompts/`
  no longer carries `tools/todo.md`, and no receipt reports ledger state.

## [4.2.0] — 2026-11-26

### Changed — child activity uses the native assistant stream

omp 19.2 settles a custom transcript message the moment it mounts. Updating
that settled message afterward cannot keep a long stream visible: a terminal
retires its rows into scrollback, and a native surface drops the fine-grained
watchers that were driving the redraw. A child's live thinking and prose now
enter the host's ordinary assistant channel, preceded by a settled one-line
scope label.

- The child stream starts, updates, and ends as an assistant message. It stays
  live until the child ends, so completed paragraphs retire while the current
  tail continues to redraw.
- Only one child owns that live channel at a time. When it finishes, the next
  child that is still producing text takes the channel immediately and starts
  from the text already accumulated.
- A cumulative provider snapshot and an incremental delta are reconciled by
  content position. An update that carries both does not append the delta a
  second time, and a final message replaces the accumulated draft.

### Fixed — a finished todo no longer pins the transcript

omp 19.2 deliberately leaves a completed `todo` tool card unsettled so a later
`todo` call in the same turn can replace it. In a root turn that then forks
and joins many scopes, that one card held the scrollback frontier at the top
of the screen. A completed root or child `todo` is now a settled checklist
card and retires with the transcript. The root's persisted `todo` result still
updates the host's todo HUD; a child's result does not overwrite it.

### Fixed — Esc cancels the live scope tree

The stop decision is no longer inferred from the terminal shape of an aborted
assistant message. omp 19.2 can omit `session_stop`, settle Esc as a pause, or
leave the last assistant message with a different stop reason while a join is
still parked.

- `AgentSession.abort` is the native entry. An explicit user or parent-kill
  interrupt fires a typed user abort synchronously before the host waits for
  the session to unwind. An internal abort and a steer that redirects queued
  messages do not cascade.
- The web stop command uses the same typed entry, and each activation reaches
  only the engine that owns its session.
- The cascade starts from the conversation root. It stops running children,
  children woken after returning, and children woken after their result was
  joined. A child still being created receives the abort when creation returns
  and never starts its prompt. A child abort also stops its retry, setup, and
  background task machinery without reentering the user-abort gate.

### Fixed — a persisted assistant snapshot matches its live request

The host may persist an enriched snapshot of an assistant message before the
tool result reaches agent state. That snapshot now matches the live assistant
frame, so a tool result whose call is already committed is deferred instead of
refusing the request as history corruption.

### Fixed — finished tools use the host's settled card

A finished tool is emitted as the host's start and completion together. While
it is running it stays in the bottom tray, so neither a live child tool nor a
root tool pins the transcript behind an open card.

## [4.1.2] — 2026-11-25

### Fixed — a forked scope's first request reuses the owner's prompt cache

`before_agent_start` chose the managed block's rule section per request: a
child got `child-rules`, a root got `autopilot-rules` or `manual-rules`. `omp`
compares the incoming system prompt against the digest it recorded for the
session and clears the inherited `providerPromptCacheKey` on any mismatch, so a
child's first request re-prefilled the whole prompt — 26 329 tokens and about
8.4 s to first token in one measured session — while every later request hit
again. A second child with the same variant then hit immediately, which is what
made the first request look like a cold cache rather than a changed prefix.

- The three sections are one fixed `scope-rules` section that states the scope
  duty and both autopilot states. The managed block no longer depends on the
  request at all: root and child, manual and autopilot produce the same bytes,
  `injectSystemPrompt` hands back the array it was given, the gate returns no
  result, and the inherited cache key survives.
- The mode is still announced, in the receipt: `skillReceiptText` keeps
  rendering the current autopilot state and the scope's identity per message.

### Fixed — a forked scope inherits the beats its parent had retired

`projectContext` drops the beats listed in `state.amends`, but a child station
started with an empty list, so beats the parent had already amended came back
into the child's outbound messages and its request prefix stopped matching the
parent's.

- The keys now travel as data on the child identity: `fork-wiring` copies the
  parent's list into `buildChildIdentity`, the registry keeps a string-only
  copy, and `bindForkPorts` merges them into the child's own array once. Later
  amends on either side stay local.

## [4.1.1] — 2026-11-25

### Added — one URL is now a working install

`omp plugin install https://github.com/PamelaSprin47685ghall/herdchestra-lite2`
used to fetch a package that registered no extension at all: the root manifest
named no `omp.extensions`, so `omp` reported `enabled: true` for a plugin that
loaded nothing. The root manifest now declares both entries, which is the
manifest a one-command install actually fetches:

```json
"omp": { "extensions": ["./host-omp/src/main.mjs", "./host-omp-ui/src/main.mjs"] }
```

`host-omp` keeps its own entry, so `omp plugin link ./host-omp` still works as
before. The core stays a library: it declares no `pi` field, its `src/` tree
still imports no host module, and `tests/architecture/core-host-free.test.mjs`
now asserts the root contract instead of asserting the field is absent.

`files` also names `host-omp/` and `host-omp-ui/`. Without them a tarball-pack
install would ship a manifest whose entries point at directories it omitted —
the same silent no-op by a different route.

The Web UI artifact is still not in Git: `host-omp-ui/web/dist/` is built from
a sibling `../deer-flow/frontend` checkout that a fresh clone does not have.
Distribute it out of band (`scp -r`) into the installed copy; `host-omp` works
without it.

## [4.1.0] — 2026-11-25

### Changed — a long session pays for the frame, not for its history

A conversation that ran for days grew to gigabytes on disk and stalled for
about a second at a time. Neither symptom was a timer: `src/` and `host-omp/`
hold no interval, and the stall was the cost of whole-history work repeated on
every assistant message, tool call and model request. The work is now bounded
by what the event changed.

- **A delivered record body leaves the ledger.** A child's record has exactly
  one reader: the parent's join receipt. `releaseRecordText` drops the body
  once that receipt is rendered, and only when the station's outcome table
  still holds a copy, so a second render reproduces the receipt byte for byte.
  Before this, every later ledger baseline re-serialized every delivered
  transcript, and a baseline's size grew with the session's own history.
  `fsm`, `targets`, `budget`, `inbox`, and the outcome stay: a wake and a
  restart read those, and neither reads the body.
- **`contextMessages()` projects once per branch leaf.** It returned
  `buildSessionContext()?.messages` on every call, and the station calls it
  three to four times per assistant message, once or twice per tool call, and
  six to eight times per model request — each a full walk of the branch. The
  leaf id is the branch's identity, so an unchanged leaf answers from the
  cached projection; a manager without `getLeafId` never caches, which is the
  old behavior rather than a guess. A throwing rebuild clears the cache
  instead of serving it.
- **The boundary scan runs once per projected array.** `hostBoundaryKey` walks
  backwards to the last handoff marker, so a transcript with none cost a full
  scan per turn. It is now memoized on the array's identity and length, which
  an append is the only thing to change.
- **Character counting stops copying.** `messageChars` and `prefixChars` count
  a message and a sequence prefix without building the prefix array;
  `usage-ledger` had allocated `messages.slice(0, index)` per assistant
  message only to discard it.
- **Boundary frames write through the persistent sequence.** `message_start`,
  `message_end`, `agent_end` and the tool frames used to copy the history into
  an array, mutate it, and rebuild the whole trie and its render indexes —
  three passes over the session per event, plus `streamDirtyFrom: 0`, which
  forced the view to regroup every message. They now derive a new `MessageLog`
  by replacing only the messages they touch, layer the new indexes over the
  prior ones, and report the exact first index they changed.
- **Snapshot and catalog work is bounded.** `snapshot-fit` remembers the
  measured size of a shaped message; `onSessionHydrate` projects artifacts in
  contiguous runs of at most 256 ordinals instead of allocating a pairing map
  pair per message; `machine-catalog` reads a session header under a 1 MiB
  byte budget with a 256 KiB single-line ceiling and reuses it while `mtime`
  and size are unchanged, so a multi-gigabyte JSONL can neither block the scan
  to EOF nor have a multi-megabyte `scope.state` line parsed as a header.
- **The append digest is streamed.** `digestText` had re-hashed the whole
  growing prefix on every write — O(L) hashing and a 2L buffer allocation per
  persist, O(L^2) over a session. `digestAppend` keeps the un-terminated hash
  state beside the digest and extends it with the new suffix, so a write pays
  for its tail. The emitted `append` operation carries the same `digest` and
  the same `text`, so replay and restore are byte-identical.

### Added

- `src/scope/append-only-inbox.mjs`, `src/scope/record-mutation.mjs`: a
  structurally shared, frozen inbox and the single door through which a fork
  record is edited, so a delta's base cannot be invalidated by a writable
  reference escaping.
- `src/scope/ledger-cache.mjs`: revision tracking over the ledger, so an
  unchanged fork is a reused pointer instead of a deep compare and a copy.
- `src/station/persistence-anchor.mjs`: anchored baselines with patch replay,
  so a restart replays the entries after the newest anchor rather than the
  whole branch.
- `tools/compact-session-jsonl.mjs`: offline reclamation for sessions already
  on disk. An older `scope.state` entry under the newest state checkpoint,
  full ledger baseline, and amends prefix is replaced by a tombstone — the
  entry's id, parents, and position are kept, so the session tree, its
  branches, and every fold are untouched. `analyze`, `compact`, and `verify`
  are separate commands, and `verify` compares the folded state before and
  after.
- 100 new test files, including `tests/joined-record-release.test.mjs`,
  `tests/hot-path-context-cache.test.mjs`,
  `tests/host-omp-ui/boundary-structural-sharing.test.mjs`,
  `tests/restore-long-session.test.mjs`, and `tests/persistence-v3-safety.test.mjs`.

### Fixed

- A boundary frame that reused a message id recorded the position of the
  first occurrence, as `findIndex` did, instead of remapping it; the later
  message is now recorded as a duplicate so the streaming marker cannot land
  on the wrong message.
- `machine-catalog` no longer parses a line larger than 256 KiB, which a
  persisted state blob can easily exceed.

### Migration

- Existing sessions keep working unchanged: the release only stops new writes
  from carrying bodies nobody reads, and no snapshot version moved. Sessions
  that have already grown past a comfortable size need
  `bun tools/compact-session-jsonl.mjs analyze <file>` followed by `compact`;
  the host refuses to rewrite a live journal, so run it on a closed session.

## [4.0.0] — 2026-11-24

### Changed — `scope_fork` only creates; `scope_send` carries every later exchange (breaking for callers)

- `scope_fork` is pure creation again, so `scope_fork` and `scope_join` pair
  1:1. The `blocked` field, the `BLOCKED` state, `amendFork`,
  `reviveBlockedFork`, `supersedeFork`, `continuesForkId`, and the `:g<N>`
  generation suffix are gone. A repeated `scopeId` among the same siblings is
  never an upsert: registration appends the lowest free numeric suffix
  (`worker` → `worker-2`), and both the caller's receipt and the child's start
  receipt carry the final path. The same name under two different parents
  means two unrelated scopes. The ledger snapshot is version 2; a version-1
  snapshot is refused rather than migrated.
- Identity is a path. Root is `/` and is outside every scope; a child's path is
  its parent's path plus `/<scopeId>`, so the tree `parentOwnerId` already
  encodes is its own address space. There is no global name table.
- `scope_send({ target, message, budget? })` is a free control tool. It
  resolves `.`, `..`, a relative `sub`, `../sibling`, an absolute `/a/b` or
  `/`, and GitHub-style `*` / `**`. A pattern resolves against active scopes
  only, so a wildcard never wakes a finished one; an exact path may also name a
  finished scope, and naming it wakes it. Delivery wraps the body as
  `[Message from <senderPath>]`, so the receiver answers by addressing that
  path. `budget` is an optional per-tool turn increment using the same grant
  arithmetic as a fork, and it is ignored for `/`.
- `ready` is no longer a locked door. A scope's first `scope_return` seals its
  record and returns immediately instead of parking in `waitForJoin`, so its
  session stays alive and idle; a send that names it wakes it in place without
  changing the parent's `ready` or `joined` state and without a second record.
  A woken scope receives no return nudge and ends at natural stop. Calling
  `scope_return` while woken is a send to `..`, so one delivery path carries
  every upward message.
- Each turn's `<additional-system-instructions>` carries a third sibling
  `<skill>` element listing every unfinished path in lexicographic order with
  the receiver's own path on the first line. Finished scopes drop out of the
  list and stay addressable by exact path; hiding is a display rule, not a
  deletion.

### Fixed — a forked scope that stops without returning is steered back

- `nudgeDecision` now knows the child's return obligation. A forked scope that
  ends a turn without a tool call while its own bracket is still `running`
  earns the child return nudge as an in-turn steer, so the model is told to
  call `scope_return` before its run is allowed to end. Before this, the
  decision handled only the receive obligation: a child with no unreceived
  children of its own stopped with no steer at all, and the obligation was
  left to the spawn ticket's out-of-turn prompt.
- The join steer still outranks it — an unreceived child can be parked inside
  `scope_return`, and only the parent's take releases it. A returned, failed,
  blocked, superseded, or missing record earns no steer. One steer per
  assistant message, root excluded. `tests/return-nudge.test.mjs`; `RUNNING`
  joins the scope index's public names.
- Both legs share one bound. `MAX_RETURN_NUDGES` and the spent count moved to
  `src/scope/return-nudge.mjs`: the count is `record.returnNudges` on the
  ledger bracket, absent in an older snapshot and read as zero. The station
  charges it only after a steer is accepted, and the session-stop gate asks
  again when the host drops that steer, so the reported symptom — a child's
  natural stop allowed through — no longer depends on the in-turn leg landing.
  The ticket charges the same field and closes the bracket as failed when it
  is spent, so one counter bounds both paths and a new requirement resets it.
  A snapshot whose `returnNudges` is not a non-negative integer is refused.

## [3.5.1] — 2026-11-24

### Fixed — Esc cancels the whole scope tree

- A user abort (`stopReason: "aborted"`, or an aborted signal that is not the
  queued-message tool interrupt) now closes every descendant bracket the level
  still owes a receive — running, ready and blocked alike — and hands the
  running ids to the host wiring, which stops each child agent once. Before
  this, `onSessionStop` treated an abort as "the host already stopped" and
  returned with no side effect, so children kept working after the user
  pressed Esc.
- The ledger closes first, so the reason a parent reads is `cancelled by the
  parent scope`, never a prompt that resolved with "aborted". A second Esc and
  a child's own aborted stop are no-ops.
- A provider error and a tool interrupt still leave children alive: both are
  retryable, and a steer must not end the branch.
- The spawn ticket registers its live session with the wiring, skips the
  prompt when its fork was cancelled during session creation, and drops its
  own outcome once the ledger closed the bracket.

### Changed — a serialized ledger shares its records instead of recopying them

- `serializeLedgerShared` keeps one immutable snapshot per ledger and rebuilds
  only the records that moved since it; an untouched record is the same object
  in the old and the new snapshot, and an untouched ledger returns the previous
  snapshot whole. `serializeLedger` still returns a full copy, because callers
  that write into the result rely on owning it.
- The persistence anchor now serializes with the shared form. Measured on a
  200-fork ledger (197 KB): 1000 consecutive passes over an unchanged ledger
  return the same object in 0.16 ms, changing one record copies one record
  instead of 200, and keeping 200 successive snapshots costs 1.03 MB of heap
  where full copies cost about 39 MB.
- Dirty marks live in module-private `WeakMap`s, so no ledger or record gains a
  property: the JSON shape, `validRecord` and `validLedger` are unchanged.
  A hand-built ledger nobody registered still serializes by value.
- `foldStateChain` replays a chain into one working tree: the checkpoint is
  cloned once and each delta patches it in place, instead of cloning the whole
  state once per delta (up to 64 times per cold start). `applyDelta` keeps its
  contract and still never mutates its base; a written value is cloned so a
  stored operation can never be corrupted through the replayed state.
- `annotateFork` copies `targets`, so a later amend no longer pushes into the
  array the caller handed in.

### Fixed — one panhandled charge no longer discards the session on reload

- `accounting` records an admitted call that had no budget left as
  `{ amount: 0, panhandled: true }`. `copyCharges` dropped the flag and
  `validCharges` required a positive amount, so a single such entry failed
  validation and `deserializeState` fell back to `createState`: every fork,
  pin and relay of the session was lost on the next reload.
- The flag now survives serialization, and a zero amount is accepted exactly
  when it is flagged. A zero amount without the flag still fails.

### Changed — charge receipts and panhandle history are bounded

- A closed branch drops its `record.charges` map (`markReady`, `takeReady`,
  `supersedeFork`, `abandon`) and announces the change to the snapshot cache.
  No amend can name a closed branch's tool call, so the receipts were dead
  weight; `spent` and `remaining` stay exact.
- A running branch keeps the newest 16 distinct `groupKey`s and the newest 32
  ungrouped calls, which is one amend window rather than the branch's history.
- `state.charges` drops the entries of every branch that is no longer running
  or blocked once it passes 16 entries, and caps the charging branch at the
  same window. `charges` stays out of `createFlowState`'s shared set on
  purpose: a child station observes its own host boundary, and sharing the map
  would let a child erase the parent's refund memory.
- `record.panhandles` keeps the newest 16 entries and carries
  `panhandleTotal` and `panhandleTools`, so the parent still reads the true
  count ("panhandled 50x") while the record stops growing. A record from an
  older snapshot has both counters seeded from the entries it holds.

## [3.5.0] — 2026-11-24

### Changed — a scope is sized from `2n`, not `10n`

- `resources/prompts/system.md` §Run scopes now asks a scope to match `sqrt(2n)`
  turns, so `sqrt(2n)` scopes finish the total `2n` work. The 2 is the
  back-and-forth a worker's real work costs, about twice the ideal estimate —
  the same reasoning as before, with a smaller coefficient.
- `README.md` states the same rule once, with the same reason.
- The tests assert `sqrt(2n)` and "twice the ideal estimate" instead of the
  retired `10n` wording.

## [3.4.2] — 2026-11-24

### Fixed — a bare `bun test` no longer collects the `deer-flow` submodule

- `bunfig.toml` carries `[test] pathIgnorePatterns = ["deer-flow/**"]`. A bare
  `bun test` from the repository root previously walked into the vendored
  submodule and ran its 503 test and spec files, failing in dependencies that
  belong to its own pnpm toolchain.
- Measured on Bun 1.4.4: bare `bun test` went from 656 files / 2124 tests with
  502 failures to 153 files / 1617 tests and 0 failures. `bun run test` was
  already clean, because its positional `tests` scoped the run; the config now
  covers every invocation instead of one script line.

## [3.4.1] — 2026-11-24

### Fixed — `lint` no longer reads the `deer-flow` submodule

- `eslint.config.mjs` ignores `deer-flow/**`. ESLint 10 looks for a flat config
  beside each linted file, so `eslint .` walked into
  `deer-flow/frontend/eslint.config.js` and failed with `ERR_MODULE_NOT_FOUND`
  for `@eslint/eslintrc` — that submodule carries its own pnpm toolchain and
  its own lint command, so it is not this repository's to lint.
- `scripts.test` already drew that line with
  `--path-ignore-patterns 'deer-flow/**'`, so both gates now cover the same
  files and `bun run lint` exits 0 where it previously exited 2.

## [3.4.0] — 2026-11-24

### Changed — a record carries each tool call with its arguments

The child record used to keep only a tool's name: `[read]`, `[bash]`. A parent
could not tell which file was read or which command ran, so the child had to
restate its own calls in `dafny` and the record answered less than it held.

- `src/transcript/replay.mjs` renders one line per tool call as
  `name(key="value", ...)`, in the order the arguments object has. A string is
  a JSON-quoted literal, so a newline stays `\n` and the call stays on one
  line; every other value is compact JSON, so a nested `forks` array keeps its
  shape on that same line. Nothing is sliced, filtered, or capped — no
  argument count limit, no key allow list, no `…`.
- The record grows with the arguments it names, and `estimateJoinTokens`
  already prices a record by its measured characters, so join admission sees
  the larger number instead of a value estimated from the old form.
- `fork-join.md` §join.tool, §return.tool, and §return.dafny, `errors.md`
  §missing-dafny, `descriptions.mjs`, and `README.md` describe the new line:
  `dafny` now carries what the replay still drops, which is the tool results.

## [3.3.0] — 2026-11-24

### Changed — `scope_return.dafny` is required (breaking for callers)

A return must now carry `dafny`; a caller that relied on omitting it reads `MISSING_DAFNY` and must return again with text.

- The `scope_return` schema lists `dafny` in `required`, so a return without it is refused instead of submitting a record whose tool arguments and results never reach the caller. `resources/prompts/tools/fork-join.md` §return.dafny says so and tells a child with nothing to add to say that in one line.
- The station enforces the same rule: `handleReturnCall` refuses an absent or whitespace-only `dafny` with `MISSING_DAFNY` before any bracket moves, so the child can fill the field in and return again. A caller that is not a child still reads `NOT_A_CHILD`, because the relationship error is the more fundamental one.
- `README.md` documents `scope_return({ dafny })`; the `dafny` prose no longer calls the field optional.

## [3.2.3] — 2026-11-24

### Changed — a wall clock is a receipt, not a fence

- A scope that runs past its deadline no longer loses anything. The station stops handing the deadline to the host as a call limit, so no `AbortController` aborts an in-flight tool and no result is dropped; the host gate runs admission and accounting in one dispatch instead.
- An over-deadline call records one debt in the same tally as a spent point, deduplicated by call id, and the caller reads it on the budget line as `panhandled Nx` with `time OVERTIME`. `scope_join` and `scope_return` still never carry the clock.
- The `overtime-killed` error is gone with its prompt entry; `resources/prompts/tools/fork-join.md`, `README.md`, and the orchestration record now describe the deadline as a measured receipt.

## [3.2.2] — 2026-11-24

### Changed — `n` is in the schema, and a receipt is no longer a user turn

- `scope_fork` now requires `n` on every item and takes its description from `resources/prompts/tools/fork-join.md`. The sizing rule stays in `resources/prompts/system.md` §Run scopes; the fork fsm, the budget text, `README.md`, and the orchestration record point at that owner instead of repeating `sqrt(10n)`.
- The station receipt is a `user`-role message carrying `herdSkill`. The relay prompt never archives it, and the UI renders it as a text step, so the reminder the host appends each turn is not mistaken for a fresh user message.
- The receipt's language reminder is its own `<skill>` element inside the same `<additional-system-instructions>` wrapper and opens with the host-reminder parenthetical. Turning it off removes that whole element and leaves the rest of the receipt byte-identical.
- `host-omp/package.json` is back in sync with the core at 3.2.2.

## [3.2.1] — 2026-11-24

### Changed — `scope_return.dafny` says what the record cannot carry

- `scope_return`'s `dafny` guidance now asks for what a successor cannot get from the replay, not for a report that the work exists. It also states that the caller receives the assistant text and this field together, so the field must not restate what the text already says; the search that produced the record is not part of it.

## [3.2.0] — 2026-11-24

### Restored — the language reminder rides in the receipt again

- Every skill receipt now ends with the Simplified-Chinese reminder that `resources/prompts/system.md` carries in its persistent rules. The receipt is appended to the session tail, one per turn and never written over an older message, so the newest request holds the reminder even when the prompt prefix is folded away; nothing before the new message changes, which is what keeps the provider cache warm. The line was lost in 3.0.0, when the receipt rewrite dropped it and only the system-prompt copy survived.
- `chineseReminder` now gates both copies: `HERD_DISABLE_CHINESE_REMINDER=1` removes the line from the persistent rules and from every receipt, and the rest of the receipt stays byte-identical.

### Fixed — a missing fork record no longer hides the budget line

- A forked scope whose ledger holds no fork record produced a receipt with no `Scope budget:` line, which reads as "nothing to watch"; the model learned its balance only by overrunning a tool and reading `tool-budget-exhausted`. `skillReceiptText` now states `Scope budget: unavailable; the ledger holds no record for this scope.` in that case, while a receipt with a record keeps its bytes unchanged. `resources/prompts/receipts/scope.md` gains `receipt.branch-missing`; root receipts do not gain the line.

### Tests — the receipt append survives a lost write

- `tests/context-commit.node.test.mjs` pins the durable append in three shapes: a journal write that throws leaves neither side of the pair written and a retry appends exactly one receipt; a receipt missing from both the journal and the live history after a reload is replaced once, so the journal holds one `herdSkill` receipt and a repeat of the same request reuses it; and a receipt persisted before the reminder existed is reused byte-for-byte under the same turn key, while the next grown prefix appends a receipt that carries the line and leaves the older one at its original index. A real process kill between the append and the host's flush stays host-owned; the repository has no write there to test.

### Fixed — a link install without its core link is not in sync

- `host-omp` imports the core by name, so a linked working tree needs `bun install` in `host-omp/` to materialize `node_modules/herdchestra-lite2`. `sync-plugin` reported that shape as "in sync" and exited 0 even when the link was missing, while the host failed at extension load with `Cannot find package 'herdchestra-lite2'`. The link branch now checks that the core resolves to this repository and exits 1 with the remedy when it does not.

### Changed — `scope_return`'s closing text is `dafny`

- `scope_return`'s `markdown` argument is now `dafny`. The record already reaches the parent as narration, so the string carries what the replay drops and the content chooses its form — prose, pseudocode, a table, a code block — with density, not length, as the criterion. The fork keeps its own name: `scope_fork` still takes `fsm`.

### Changed — a scope is sized by the work, not by a table

- Every numeric sizing rule is gone: the 18/27 point scope size, the four/six items per call, the two/three tree-depth default and recommendation, the `SCOPE_OVER_BUDGET_CAP` and `FANOUT_OVER_CAP` warnings, and the constants behind them. `scope_fork` now says to fork as much as the work allows, to fork again inside a child, and to size a scope at about `sqrt(10n)` points where `n` is the ideal turns of work in hand — ten, because a worker's real work runs back and forth, about ten turns for every ideal one. A larger job is a deeper tree, not a fatter scope.
- Every fork item now declares `n`, its parent's estimate of the ideal turns of work in hand. The schema requires it and the station ignores it: it is there for a later audit of how the model sized itself, and no budget, clock, or admission reads it.

### Changed — a spent budget is recorded, not refused

- `scope_panhandle` is removed: the tool, its schema, its prompt page, its station controls and domain decision, its ticket, the host wiring, and the sync needle. A non-root call whose balance for a tool is gone now runs, clamps its charge at zero, and is recorded as panhandled; the scope's tally returns with its record. The root keeps its refusal, because the root is outside every scope and holds no allowance to overrun.
- `resources/prompts/errors.md` and `tools/fork-join.md` state what a panhandled receipt is for: not a rescue, but a public admission that the scope sized itself wrong.

### Changed — the control surface names what it does

- `host-omp/src/host/host-tickets.mjs` loses the four forwarders that named `forkControlTicket`, `joinControlTicket`, `returnControlTicket`, and `scopeContextTicket`, together with the `ticketHost` and `ticketDeps` helpers behind them. None of the six had a definition or an import, so any call was a `ReferenceError`; a pure forwarder belongs to the core barrel, as the file's own boundary comment already said.
- `grantBudget` failures report `GRANT_INVALID_TOOLS`, `GRANT_FREE_TOOL`, `GRANT_INVALID_SECONDS`, `GRANT_EMPTY`, and `GRANT_CLOCK_OFF`. The function raises the allowance of a reused scope; it does not record a scope admitting that it sized itself wrong, and `panhandle` keeps that second meaning alone.
- `scope_fork` takes no signal, because it has no wait to cancel: a fork finishes in one synchronous beat, so the sixth argument it never declared is gone rather than threaded into a parameter that goes nowhere. The host bag the ticket did receive was unused, and a fork that dies inside the station now records a diagnostic as a join does.

## [3.1.0] — 2026-11-24

### Changed — a natural stop is a small handoff

- A natural stop now transfers the holder without counting as an empty evaluation. Only `todo` writes advance the two-empty-ledger protocol; a stop that leaves no ledger on record no longer lets one empty write end the chain. `applyNaturalStop` uses the retirement shape, `decideNaturalStop` always returns the small-handoff plan, the successor views an inherited ledger only when it holds open work, and the relay receipt, scope receipt, autopilot rules, README, and tests follow the new contract.

### Changed — zero-semantic cleanup

- Station: extract `amendmentLine`, delete the dead `commitJoin`, remove the
  `ledgerFor`/`adoptLedger` import aliases, and hoist the repeated pricing
  pick.
- Scope: hash the usage header once for both the key and the byte count, and
  drop the unreachable `Array.isArray(amends)` guard.
- Bridge: drop the redundant `snapshot(limit = 80)` default and extract
  `streamingFrom`/`lastStepIndexIn` in the transcript model.
- Web: extract `statusFromRaw`, reuse `earlyType` and `selectModelKey`, bind
  repeated predicates in the header, conversation view, composer, and dialogs,
  and merge the identical tool `todo`/`ask` cases.
- Kept deliberately: the duplicate `displayGroups` computation in
  `ui-bridge-station.mjs`. `fitSnapshot` measures `sizeOf(doc)` before it
  overwrites the field, so removing it would change snapshot trimming.
- Tests: 467 pass / 0 fail / 1772 expect / 50 files; `build:web` exits 0.

### Changed — a fork item carries a state machine per branch

- The `scope_fork` item contract field is now `fsm`: describe the work as a set of state machines, one per branch — each machine's states, the transition that advances it, and which branches run at once — and say how to build the result fastest, not only what the finished thing is. Error codes (`INVALID_FSM`, `MISSING_FSM`), receipts, and documentation follow the model-facing name.

### Changed — one word for the state machine text

- The state machine text is `fsm` everywhere: the ledger record, the identity table, the spawn spec, the field the `requirements` queue appends from, and the receipt placeholders (`{{fsm}}`). The internal name `intent` is gone, with no alias left behind.

### Changed — receipts are priced by the text that is actually sent

- The context admission estimate now measures the receipt each path sends: `childReceiptText` for a fresh fork, the blocked target's own text for a revive, and `generationReceiptText` — including the previous generation's whole record — for a continuation. The guessed constants `FORK_RECEIPT_PREFIX_CHARS` and `JOIN_RECEIPT_OVERHEAD_CHARS` are deleted; the join side measures the receipt it renders.

### Changed — every receipt path is admitted

- A revive and a new generation now pass the same admission check as a fresh fork, so a continuation whose prior record does not fit is refused with `FORK_CONTEXT_EXCEEDED` at the fork call instead of colliding with the window inside the child.

### Breaking — ledger snapshots bump to version 2

- A snapshot that still carries `intent` is invalid and rebuilds from an empty ledger; there is no compatibility alias. In-flight fork trees written by 3.0.0 do not restore.

### Changed — a fork item carries the child's profession

- `scope_fork` now requires `profession` on every fork item: the child's identity statement, injected under the receipt marker.

### Fixed — standalone omp web bridge

- Repair the UI fence imports for the compiled omp host, browser asset bundling,
  dialog routing, session switching, model selection and bidirectional draft
  synchronization. Reuse DeerFlow's UI components without its backend.
- Add Web session creation and switching, composer attachments (including
  steer and follow-up), and keyboard access to the TUI surface. The bridge
  remains a loopback service protected by an access token; terminal-specific
  presentation may differ in the browser.
- Fix the composer collapsing into a single row (32px textarea beside a
  1011px action bar): Tailwind scanned only `host-omp-ui/web`, so arbitrary
  variants used solely by reused DeerFlow components were never generated.
  `app.css` now declares the DeerFlow `components/ui` and `ai-elements`
  sources.
- Remove the "进入/退出 Plan 模式" and "进入/退出 Vibe 模式" tooltips; the
  mode buttons stand on their own.
- Center the empty-conversation state in the viewport instead of anchoring it
  near the top.
- Fix the conversation view throwing `ReferenceError: ChevronDownIcon is not
  defined` when a compaction or branch boundary summary rendered:
  `content-blocks.tsx` used the icon without importing it.

### Changed — scope size is a constant, enforced by rebuke

- A working scope is sized at about 18 total tool-budget points and never more
  than 27, amendments included; one `scope_fork` call starts about 4 children
  and never more than 6; one `scope_panhandle` asks for about 6 total points
  and never more than 9 across every tool. The former `sqrt(n)` guidance and
  the hardcoded `8` per-tool allowance are gone.
- The caps are soft: an oversized call still runs and its receipt carries a
  `WARNING` that names the excess and forbids a repeat. `scope_panhandle`
  measures one total across all tools instead of a per-tool maximum, so its
  schema no longer carries a per-tool `maximum`.
- `PANHANDLE_MAX_PER_TOOL` is replaced by `PANHANDLE_DEFAULT_POINTS` (6) and
  `PANHANDLE_MAX_POINTS` (9); `scope_fork` amendments no longer borrow the
  panhandle cap and are judged against `SCOPE_MAX_BUDGET_POINTS` (27).
- Fixed: `panhandle.tools` and `panhandle.seconds` reached the tool schema with
  their `{{maxPoints}}` and `{{maxSeconds}}` placeholders unrendered.

### Changed — tree depth is a default and a recommendation, not a ceiling

- A tree is sized from independent closures, not tool calls: one closure is a
  18–27 point leaf. Up to about six closures stay one layer deep, seven to
  twenty-four default to two, and a larger job is recommended through three.
  `FORK_DEFAULT_DEPTH` (2) and `FORK_RECOMMENDED_DEPTH` (3) state this for the
  prompts; neither is a limit, and a deeper tree with a real reason runs.
- A child's birth receipt now places it: `depth X (default tree depth 2,
  recommended through depth 3)`. A fourth layer still starts and carries a
  calm `Note —` explaining the cost of one more layer — the record compresses
  to prose again and the ancestor prefix grows — with no refusal and no
  demand for a written justification. Amending a live deep scope repeats no
  note.
- The guidance refuses two fakes: a single-child relay layer, and serializing
  ten independent closures into repeated root waves instead of adding one
  subtree layer.

### Added — `scope_return` takes an optional closing markdown

- `scope_return({ markdown })` appends the string verbatim to the end of the
  record the parent receives. The field is optional; a blank value changes
  nothing. The replay still carries only assistant text and tool names, so the
  field exists for what that replay drops: tables, code blocks, and deliberate
  closing notes.

### Added — every outbound request shares one first turn

- The `context` hook prepends a fixed user message built from
  `/tmp/omp-llm-request-15d7e7f698200d35.json`. The snapshot is read once at
  activation; the message timestamp is constant, so every request sends a
  byte-identical prefix and the provider prompt cache survives.
- Read-only sessions, which bypass the station projection, get the same first
  turn. A missing snapshot is recorded as an activation diagnostic and the
  request proceeds without it.

### Changed — skills are inlined, not fetched

- The six skills moved from `host-omp/skills/` to the core's
  `resources/skills/`. `src/prompts/skills.mjs` loads them once, strips the
  YAML frontmatter, and `src/prompts/inject.mjs` embeds every body in the
  managed system-prompt block. Marker replacement keeps a second injection
  byte-identical.
- The persistent rules name the skills as inlined and no longer tell the model
  to read `skill://constitution`, `skill://prompt-craft`,
  `skill://skill-authoring`, `skill://polish`, or `skill://tdd-crowdsource`.
- `herdchestra-host-omp` ships no `skills/` directory. `sync:plugin` drops the
  host unit's `skills` copy and removes a stale plugin-root `skills/` left by
  an older vendor install.

### Fixed — a forked scope is a child again

- The split's production host bag handed the core `session.agentId` (a string)
  where the contract reads `session.agent(ctx)` (the identity object), and it
  reimplemented `fork.identityForAgent` over a registry method the core never
  exposed. Every child station therefore resolved no identity, treated itself
  as root, and charged tools against a root that owns no budget.
- `createEngine` now reuses the host's process-wide fork wiring instead of
  creating one per engine. The host binds the extension again for every child
  session; a per-engine registry hid the parent's fork records, ledger, and
  waiter set from the child.
- Identity lookup belongs to the core registry again. The host bag no longer
  supplies a second `identityForAgent`, and `session.agent` returns the host's
  `{ kind, id, depth }` object.
- A fork identity now classifies its station as a writable subagent even when
  the host's spawned session has no `session_init` and reports `kind: "main"`.
- `conversationKeyOf` falls back to the manager object when a session has no
  id, so unrelated id-less sessions cannot share one ledger.
- The production host bag now supplies `model.query` (`ctx.models`); fork model
  selection had no host facade to resolve against.
- `tests/architecture/activation-bag.test.mjs` pins the production bag to the
  contract, including a two-engine share of one wiring. The split's ratchet
  compared only `shapeHost`, which is why the broken bag stayed green.

### Changed — dependencies track the latest host

- `eslint` is pinned to `10.15.0`, the latest release.
- CI checks out the host's default branch instead of the pinned commit, and
  keys the native cache by the resolved HEAD.
- Both smoke scripts read the local addon's stamped build version before the
  host import; when it differs from the host's package version, the shared
  `scripts/host-native.mjs` borrows the installed matching addon. A 19.0.0
  binary can import under a 19.1.0 source and fail later, which the
  import-only fallback could not catch.

### Fixed — a returned child always lands on a receiver that can join

- `scope_return` resolves its receiver through the current adoption chain, so a
  branch that already returned, joined, failed, or was never started hands the
  result to the nearest live branch. Previously the record could be queued for
  a branch that would never call `scope_join`, and the child stayed parked in
  `scope_return` for the rest of the session.
- `reparentOrphans` walks to the live receiver too, and a restore re-homes
  every ready result whose stored owner disappeared. Reloading no longer
  resurrects a return into an undrained queue.
- A reused scope that supersedes a ready record wakes the parked child and
  closes its return with an accepted superseded receipt instead of leaving it
  waiting for a take that reuse cancelled.
- The join nudge outranks every other nudge: a turn that ends with unreceived
  children earns `scope_join`, at the root as well, even when the relay is off.
  A natural stop with unreceived children arms no handoff and counts no empty
  ledger; only a fully joined tree may submit either empty form. A pending
  handoff no longer blocks `scope_join`, so a restored ready record can always
  be received.
- `appendAt` in `host-omp/src/host/branch-manager.mjs` is the synchronous leaf
  scope again, not an array insert. Every flow append, read, and model-usage
  write had failed with `entries.slice is not a function`, which also made
  child creation fail.

### Changed — one function across the package boundary

- The core barrel shrinks from 94 named exports to one: `src/index.mjs` is
  `export { createEngine }`. `host-omp` imports that symbol and nothing else;
  `src/engine.mjs` owns port resolution, the fork wiring, the station
  registry, the tool catalog, the scope read model, and the text renderer.
- The host no longer hands the core a flat 24-key bag, a second `ticketHost`
  bag, or a `capabilities(ctx)` probe. It hands five frozen fact groups
  (`session`, `model`, `accounting`, `fork`, `report`; 27 keys) and eight
  async verbs (`steer`, `prompt`, `activateTools`, `restoreScopedModel`,
  `applyPendingModelSwitch`, `invokeTool`, `canSteer`, `canPrompt`).
  `applyPendingModelSwitch` and the duplicated `record` leave the ticket
  parameter path; `record` now exists once.
- `fork-registry`, `fork-identity`, and `child-display-holder` move into the
  core, together with the eight pure functions behind the child display
  (`scopeActivity`, `stripToolCalls`, `assistantParts`, `partsText`,
  `partsSignature`, `textBlocks`, `toolSummaryText`, `formatFallbackLine`).
  The host keeps the session objects, the UI tray, the arbiter, and the
  subscriptions. The scope ledger no longer crosses the boundary: the host
  reads a frozen DTO from `engine.scopes` and never calls `forkOf`,
  `markReady`, or `selectForkLedger`.
- `HOST_CONTRACT`, `TICKET_CONTRACT`, and `ENGINE_ONLY_HOST_KEYS` are
  executable declarations in `src/engine.mjs`. `core-host-free.test.mjs`
  fails when a core file reads a key outside them, when the core gains a
  second export, when the host imports anything but `createEngine`, when a
  core line dereferences `ctx`, or when `shapeHost` and the contract drift
  apart.

### Fixed — the sync respects a linked install

- `omp plugins link host-omp` is the development install: the plugin path is a
  symlink at the working tree, so the tree *is* the plugin. `sync:plugin`
  classifies the target first — a link into the repository prints `link
  install` and writes nothing, a link outside it is an error, and only a real
  directory is copied. This removes `materializeTarget`/`materializeCore`,
  which deleted the user's link and, worse, let a "sanitized" core
  `package.json` travel back through `link:..` and strip `scripts` and
  `devDependencies` from the repository's own manifest.
- `omp plugins install <git-url>` is the host's own install: the plugin path is
  a real directory the host resolved, so the sync prints `installed copy` and
  writes nothing. Filling a real directory from this tree is now an explicit
  act — `--vendor` or `HERDCHESTRA_SYNC=vendor` — so an ordinary `bun run
  sync:plugin` can never overwrite an install the host owns.
- `host-omp/skills/` becomes the single source for the six shipped skills. The
  host resolves a plugin's `skills/` directory and requires its realpath to stay
  inside the plugin root, so `host-omp/skills -> ../skills` was skipped rather
  than followed. The skills move into the host package; the core no longer
  carries a `skills/` directory and the sync no longer mirrors one.

### Changed — the omp host layer is a package of its own

- The host wiring and every omp-facing file move to `host-omp/`
  (`herdchestra-host-omp`), now the only plugin entry: it declares
  `omp.extensions` and depends on the core through
  `"herdchestra-lite2": "file:.."`. The root package no longer declares an
  extension and exports its API through `src/index.mjs`.
- The core takes an injected `HostBridge` bag instead of the host namespace:
  `pi`, `ctx.sessionManager`, and every `../host/*` import leave `src/`. A host
  context is an opaque token inside the core; only the bridge dereferences it.
  `eslint.config.mjs` drops the `station/registry.mjs` exemption, and
  `tests/architecture/core-host-free.test.mjs` pins the boundary.
- Pure tickets return to `src/tools/tickets.mjs`; the host-bound tickets
  (steer, prompt, active tools, scoped model) live in
  `host-omp/src/host/host-tickets.mjs`, and `fork-spawn-ticket.mjs` moves to
  `host-omp/src/host/`.
- `scripts/sync-plugin.mjs` installs two roots: the core under
  `TARGET/node_modules/herdchestra-lite2`, the host package at `TARGET`. The
  host package owns `skills/`, so the copy carries the six skills without a
  mirror step. It removes the retired `herdchestra-lite2` plugin directory so
  the host cannot load two entries.

### Added — a repeated `scopeId` amends the existing scope

- `scope_fork` now treats an existing `scopeId` (case-insensitive, finished
  scopes included) as an amendment instead of a duplicate. `running` and
  `blocked` scopes take the budget as an increment, the `intent` as one more
  requirement, and merged `targets`; `ready` supersedes the old record and
  starts the next generation; `joined` and `failed` start a new generation
  with the old record as prior history. Only the owner may amend; another
  caller gets `FOREIGN_SCOPE_ID`.
- A requirement enters at the child's next turn boundary; it never interrupts
  a tool already running. `scope_fork` no longer reports
  `DUPLICATE_SCOPE_ID`: a new scope with no intent is refused with
  `MISSING_INTENT`, `blocked: true` on a running scope with
  `SCOPE_RUNNING_BLOCKED`, and an amendment that changes nothing with
  `SCOPE_REUSE_EMPTY`.
- `intent` is optional in the fork item schema; the station still requires it
  for a new scope and refuses with `MISSING_INTENT`.

### Changed — a child record is a digest, and `scope_join` takes no argument

- The record a child hands its parent no longer carries the full working
  transcript. It holds the child assistant's text in order, with every tool
  call reduced to a bare `[name]` placeholder — `[read]`, `[edit]`, `[bash]`,
  `[scope_fork]` — and the lines joined by newlines. Tool results, thinking
  blocks, tool arguments, and user broadcasts are absent.
- `scope_join` lost `elder_report` and takes no parameter. With the record
  this small, the receipt chain no longer needs a summary step, so the
  `elder_report` validation, the stored receipt summaries, the transcript
  collapse pass, and the folding feature are removed together; no path can
  fold an older receipt any more. A join refused for context size still
  leaves the child record untouched.
- `resources/prompts/tools/fork-join.md` and `resources/prompts/errors.md`
  drop every `elder_report` section; `tests/prompts.test.mjs` pins that
  `joinParameters` has no `required` field and no `elder_report` property.

### Changed — one `scope_context` tool replaces `pin` and `amend`

- `pin` and `amend` are now two optional objects of one tool:
  `scope_context({ pin, amend })`. Either may be omitted; a call that names
  neither is refused with `scope_context-empty` and changes nothing. When both
  arrive, amend runs first so the refund is in the ledger before the note is
  saved; a failed half does not cancel the other, and the combined result says
  which half failed.
- The old tool prose moved to the parameter descriptions: the model reads the
  pin judgment where it chooses the fields, and the amend judgment where it
  writes the reflection. The tool description itself is one sentence. This
  keeps the tool family under one `scope_` prefix.
- The retired names are no longer registered, but old transcripts still
  render (`[pin]`, `[amend]`) and the scan path still processes an `amend`
  call that predates the merge. `scope_context` is free at every level.
- `tests/scope-context.test.mjs` pins the schema, the order, the derived cache
  keys, the partial-failure result, and the empty refusal; the existing pin,
  amend, transcript, and charging tests were retargeted to the new name.

### Added — a built-in protocol read or write costs no tool point

- `isFreeCall` treats any `read` or `write` whose path carries a built-in
  protocol scheme (`xd://`, `omp://`, `local://`, `skill://`, `agent://`,
  `history://`, `proc://`, `cfg://`, `issue://`, `pr://`, `mcp://`, `ssh://`,
  `help://`) as free: no tool point, and no fork record needed. The rule
  replaces the `skill://`-only read and the `xd://resolve`/`xd://reject` write
  special cases, so a scope minted with zero budget for `read` or `write` still
  runs them, and the root keeps resolving staged ast_edit previews.
- `http(s)://` and `file:` stay charged: they fetch a live page or name a local
  file outside the protocol layer, which is work wherever it lands. A plain
  filesystem path is charged as before.
- `src/scope/budget.mjs` owns the scheme table (`internalScheme`,
  `isInternalUriCall`). `tests/free-uri.test.mjs` pins the free and charged
  paths; `tests/prompts.test.mjs` pins the root refusal text and the system
  prompt line.

### Changed — the prompt tells every level about the free fork

- `system.md#persistent-rules` no longer says only the root holds the control
  tools. Every level, root included, may fork; the text states the economics
  as a tip: `scope_fork` costs nothing, the child's budget and clock are born
  with the item that starts it, and the caller's balance never moves. A scope
  plans the split the moment the task arrives: it decides then which parts go
  to fresh children — they can fork again in turn — and joins their records
  before returning; waiting until a clean handoff is still affordable is
  already cramming. The fork still pays less than any handout.
- `tools/fork-join.md#fork.budget` drops the claim that a nested scope draws
  from the enclosing flow's balance. Each item funds its own child at any
  depth; the caller is never charged.
- `tools/panhandle.md` and `errors.md#tool-budget-exhausted` name the fork
  before the handout at the point of refusal. `tests/prompts.test.mjs` pins
  the persistent tip, the corrected budget line, and the refusal order.

### Added — `scope_panhandle` buys a branch more budget at once

- A running branch that runs out can call `scope_panhandle` to add tool points
  and wall-clock seconds to its own fork record. The grant is synchronous and
  needs no approval; it is free, so it still runs when every paid tool is
  refused and the clock is in overtime. Besides `scope_join` and
  `scope_return`, it is the only call exempt from the one-second overtime limit.
- One call grants at most 8 points per tool and 300 seconds. There is no
  lifetime cap: every grant is appended to `record.panhandles` with its
  timestamp, points, seconds and the caller's `because`, and the branch budget
  line shows `panhandled Nx`. The parent sees the tally when the child returns.
- A blocked scope is refused (`PANHANDLE_BLOCKED`): its record is rebuilt on
  resubmit, so a grant would be lost. A scope without a clock can buy tools but
  not seconds (`PANHANDLE_CLOCK_OFF`). The root has no record to top up.
- `src/scope/panhandle.mjs` owns the arithmetic;
  `src/station/domain/panhandle.mjs` owns the decision;
  `src/station/panhandle-controls.mjs` lands it.
  `tests/fork-panhandle-arithmetic.test.mjs`, `tests/fork-panhandle.test.mjs`.

### Changed — fork wall clock is derived, not declared

- `scope_fork` no longer accepts `time`. One turn is one LLM request. The
  session stores two sufficient statistics on the shared bracket ledger,
  `totals.turnMs` and `totals.turns`. A fork's wall clock is that mean times
  the sum of the item's tool-budget points, at least one second. With no
  measured requests the mean is one minute. Concurrent scopes add into the
  same totals, so k concurrent requests count as k durations and k turns.
- An in-flight request clock is not persisted. A double delivery of the same
  assistant message cannot count twice. `registerFork` still accepts an
  explicit `time` for internal callers and tests.

### Changed — a saved pin points at the todo ledger

- The successful `pin` receipt is no longer a bare `OK`: it tells the caller to
  update the `todo` ledger now with the next step, completed item, or blocker
  the note changes. The prose lives in `pin.saved` under
  `resources/prompts/receipts/scope.md`; `src/station/texts.mjs` owns it and
  `src/station/controls.mjs` returns it. `tests/pin-tool.test.mjs`.

### Changed — `scope_fork` requires targets, not a read/write permission

- Every fork item now requires `targets`: a non-empty array of natural-language
  descriptions of what the scope expects to create, read, update, or delete.
  Each item may be a file path, a source region, a behavior, or a goal; any
  human language is valid, and a path is only one kind. For example,
  `["fix any defect you find", "the parts of the source that involve caching"]`
  is valid. A missing,
  empty, blank, or non-string entry rejects the whole batch with
  `INVALID_TARGETS`. Blocked checkpoints declare their targets too, because an
  empty output cannot be a separate scope.
- `permission: "ro" | "rw"` is gone. So is the `rw`-before-ledger refusal and
  its `rw-before-ledger` error: with no read/write split there is no field for
  that gate to key on, and targets is a declaration, not an audit boundary.
- Child receipts and replayed fork lines show `Targets: ...`; old persisted
  snapshots without targets replay without that segment. No compatibility
  alias is accepted: `additionalProperties: false` refuses `permission`.
  `tests/forkjoin.test.mjs`, `tests/forkjoin-transcript.test.mjs`,
  `tests/prompts.test.mjs`, `tests/child-record-scope.test.mjs`.

### Changed — `scope_join` tolerates an unneeded report and yields to user input

- A join that runs while no receipt awaits a summary no longer fails when
  `elder_report` is present: the report is accepted and ignored, and the
  receipt says it was not needed. `ELDER_REPORT_UNEXPECTED` is gone.
- `scope_join` now declares `interruptible` and `handlesToolInterrupt`. A
  queued user message ends the wait the way the host's `wait` tool does. The
  join takes no child, files the supplied `elder_report` against the receipt
  the model read, and says the next join may pass `elder_report: null`. An
  ordinary cancellation still leaves the pending report untouched.
- The previous receipt has two legal states: it needs a summary, or it does
  not. A user-input interruption moves the first to the second.
  `tests/scope-join-interruptible.test.mjs`, `tests/join-obligation.test.mjs`,
  `tests/fork-join-completion.test.mjs`, `tests/fork-report-quality.test.mjs`.

### Changed — common rules moved into the required `constitution` skill

- The always-on `common-rules` block moved out of the managed system prompt into
  `skills/constitution/SKILL.md`, a required-reading skill. The persistent rules
  now point to `skill://constitution`; the constitution is no longer repeated on
  every request. The `commonRules` port and `HERD_DISABLE_COMMON_RULES` are gone.
- `prompt-craft`, `skill-authoring`, and `polish` ship as on-demand skills. The
  persistent rules name all six shipped skills and the trigger for each.
- `tests/common-rules-switch.test.mjs` is retired; `tests/prompts.test.mjs`
  checks the constitution skill and the persistent pointer instead.

### Changed — `/herd` becomes `/herd-autopilot`, off by default

- The command is now `/herd-autopilot` and the session flag is `autopilot`,
  default `false`. Off is manual duty: the relay's two-empty-ledger and
  handoff rules do not run, `ask` is available, and the relay rules are not
  injected into the system prompt. On restores the previous full-automatic
  behavior, including the blocked `ask`. The optional text after the command
  is still sent as one user message.
- `herdMode` is no longer persisted. An older snapshot without `autopilot`
  restores as manual duty.

### Fixed — fork branches start on omp 19.1

- `deriveBranchConfig` reads the mounted tool view through
  `getMountedToolCommandNames()` and falls back to the retired
  `getMountedXdevToolNames()`. omp 19.1 replaced xd:// devices with bash tool
  commands and renamed the getter; the old-only read refused every fork with
  `NO_TOOL_VIEW` before any child session existed. `compareBranchFrames` reads
  the same view. A factory refusal now carries its `detail` into the child
  outcome, so a join receipt names the cause instead of a bare code.
  `tests/branch-session.test.mjs`, `tests/fork-wiring.test.mjs`,
  `tests/fork-spawn-chain.test.mjs`.

### Fixed — every registered tool keeps its schema top-level

- `scope_fork`, `scope_join`, `scope_return`, `amend`, and `pin` now declare
  `loadMode: "essential"` alongside `todo`. With `tools.xdev` active the host
  advertises their schemas directly in every request instead of mounting them
  under `xd://`, so a model that never reads the device list can still call
  them. `tests/tool-schema-visibility.test.mjs` pins the top-level
  presentation for every registered tool, including future additions.

### Known issues — standalone web bridge

- **History paging can report more than it returned.** The station builds a
  snapshot with `limit = 80` but computes `history.hasMore` against a
  64-message threshold. With 65–80 messages and the first page requested, the
  snapshot contains every message while `hasMore` is `true`, so the web client
  offers a page that does not exist.
- **The backend never sets `activeArtifactId`.** The station initializes it to
  `null` and no command writes it. The web snapshot reducer treats `undefined`
  as "keep the local selection" but a non-string value as "clear", so each
  snapshot drops the artifact the user opened locally. `fenceStatus` takes the
  opposite fallback.
- **`stableMeta` compares seven keys.** Only `busy`, `title`, `fence`, `model`,
  `thinkingLevel`, `thinkingLevels`, and `modes` decide whether a meta update
  is new. A patch that changes only another meta field returns the previous
  state.
- **Delta merging schedules on the global timer.** `createDeltaMerger`
  defaults to `setTimeout(..., 16)` and caches one merger per `dispatch` in a
  module-level `WeakMap`. The schedule is injectable, but no caller injects
  one and there is no shutdown flush.
- **Streamed text can bypass the 1 MB cap.** The in-place append caps the
  joined text, but the "same kind at the tail" branch does `last.text += delta`
  without the cap when the block index jumps past the end.
  `host-omp-ui/web/src/protocol/reducers/transcript.ts:60`.
- **Read ranges treat `limit` as the end line.** `describeToolCall` builds
  `${offset}-${limit}`, but `limit` is a count, so the card shows a range that
  ends too early. `host-omp-ui/src/station/domain/tool-artistry.mjs:99`.

## [3.0.0] — 2026-11-21

### Added — the spawn chain is pinned end to end

- `tests/fork-spawn-chain.test.mjs` drives `scope_fork` through the station's
  spawner into the real `createBranchSession` with a fake host factory, then
  asserts that the child's first request is the receipt and that the child
  record reaches the join. A `NO_FORK_FRAME` refusal is proven to fail the
  bracket and wake the join instead of leaving the parent waiting; two further
  cases pin a rejected first prompt and a throwing session factory, the latter
  keeping the factory's message in the refusal reason. The neighbouring suites
  stop on one side of this seam: `fork-wiring` uses a fake session factory, and
  `branch-session` never starts from a station.

### Added — the relay keeps the user's own words

- A handoff writes every user prompt, verbatim and oldest first, into the
  successor's opening under `## User Prompts (verbatim)`. The relay keeps the
  archive in session state (`relay.userPrompts`, validated and serialized), so
  a prompt that compaction removed still reaches every later generation and
  survives a reload. `collectUserPrompts` skips the host's compaction summary,
  the relay's own handoff demand and blocked-tool reason, and the child return
  nudge; `mergeUserPrompts` matches the still-visible suffix so nothing is
  duplicated or reordered. The handoff demand and `scope_join`'s
  `elder_report` guidance now say the report does not restate the requirements.
  `tests/relay-prompts.test.mjs`; README and prompt docs updated.

### Added — a fork item's model resolves before anything starts

- `scope_fork` resolves each `model` selector through the host's own model
  facade (`ctx.models`) before the first bracket is registered, then passes
  the host `Model` object and its thinking level into the child session
  config. A selector that names nothing refuses the whole batch as
  `MODEL_UNKNOWN` with the available ids, so one bad item starts nothing; a
  blocked item resolves nothing until it is resubmitted as ready. A literal
  id with a colon-shaped tail wins over any suffix split, and the parent's
  model and level are never written. `src/scope/model-selector.mjs`,
  `tests/fork-model-selector.test.mjs`; the `fork.model` description now
  lists `:max` with the other thinking suffixes.

### Fixed — a child that stops without returning is asked again

- `spawnChildTicket` reads the bracket after the prompt: a natural stop leaves
  it `running`, so the ticket delivers the child return nudge and hands the
  loop back, at most twice. After that the child is failed and its record
  stays unpublished. A record frozen by `scope_return` is no longer turned
  into a failure by the spawner's empty slice. `pulse` wakes waiters even when
  `markReady` reports `ALREADY_READY`, so a parent is not parked while a
  frozen record waits. `tests/fork-wiring.test.mjs`,
  `tests/join-obligation.test.mjs`.

### Fixed — a fork is labelled with its scope title, not an internal id

- The branch config carries the public scope id's title as `agentDisplayName`
  (`oh-my-pie` → "Oh My Pie") and keeps the generated `fork-<uuid>` only as
  the host identity. The activation path already passed that title, but
  `deriveBranchConfig` only read `label` and fell back to the flow id, so the
  host's AgentRef and tool-approval dialog (`labelledUIContext`) showed
  `fork-<uuid>`. The display name now falls back to the title; an explicit
  `label` still wins, a blank one still falls through, and a branch with
  neither keeps its flow id. The child display row derives the same title from
  `publicScopeId`, so a record without a `scopeId` still shows `scope-N`.
  `tests/branch-session.test.mjs`, `tests/child-display.test.mjs`.

### Fixed — a pin that did not land is never reported OK

- `pin` refuses a call whose fields are all absent or blank with
  `INVALID_ARGUMENT` instead of answering OK and storing nothing; the schema
  now requires at least one non-blank field. A write that returns `false`,
  throws, or whose port throws rolls the in-memory note back and reports
  `PIN_UNAVAILABLE` or `PIN_INTERNAL_ERROR`. `tests/pin-tool.test.mjs`.

### Fixed — a stop the host aborted is not a user stop

- The `session_stop` hook no longer filters aborted or errored turns itself;
  it forwards the evidence and the station's `onSessionStop` owns the rule
  beside the relay state it protects.
  `tests/station-session-stop.test.mjs`, `tests/hooks.test.mjs`.

### Fixed — a failed amend stays retryable

- `processAssistantMessage` marks an `amend` call and its message only after
  the work succeeds, so one throw leaves both unmarked for the scan path to
  retry, while completed calls stay deduplicated.
  `tests/station-amend-order.test.mjs`.

### Fixed — a long session's idempotence caches stay bounded

- The amend call and message caches are bounded rings that refresh an id on
  every sighting, so an hours-long session cannot grow them without limit.
  `tests/processed-ledger.test.mjs`.

### Changed — running tools render above the editor

- Child activity no longer appends an open tool card to the transcript while
  the call is unsettled. Each running tool owns one row in the `herd-tools`
  widget above the editor, so a slow `scope_join`, `scope_return` or tool call
  never pins the transcript retirement frontier. `tool_execution_end` renders
  the native card once, at full size, through the host component registered by
  `registerToolCardComponent`; child thinking streams in the host's italic
  `thinkingText` style. `tests/child-display.test.mjs`.
- The root's approval-preview waiter is installed once per display binding,
  identity-detached when that lease ends, and reinstalled for the next one; a
  root tool event inside the lease no longer replaces it on every call.
  `src/host/child-display.mjs`.

### Changed — the composition result owns the registry

- Activation no longer routes stations through a process-wide module
  singleton: `wireExtension` returns the registry it built, `activate` returns
  the composition result, and tests plus `smoke-relay` reach a station through
  that result. `setActiveRegistry`, `stationFor` and `stateFor` are gone from
  the station index. `tests/integration.test.mjs`,
  `tests/todo-any-level.test.mjs`, `scripts/smoke-relay.mjs`.

### Changed — the root cannot spend a budget it does not have

- The root has no fork record and therefore no tool budget. It used to pass
  every ordinary call as `unbudgeted`, so the root could run `read`, `bash`,
  `write` and every other budgeted tool without a limit. Those calls are now
  refused with `ROOT_HAS_NO_BUDGET`, and the work must be delegated with
  `scope_fork`. Free control tools (`scope_fork`, `scope_join`, `scope_return`,
  `amend`, `pin`, `todo`, `ask`, `wait`), a `read` of a `skill://` path and the
  staged-preview resolution write remain available at the root. A non-root
  branch whose fork record is missing is refused with `NO_BRANCH_BUDGET`
  instead of silently running free. `tests/branch-charge.test.mjs`,
  `tests/todo-any-level.test.mjs`; prompt and README text updated.

### Added — the bracket tree survives a reload, and fork and join both have admission gates

- The bracket ledger now lives in the persisted scope state (`state.brackets`)
  instead of a process-local registry map. `serializeState` writes it,
  `deserializeState` validates and restores it, and a child flow shares the
  session's one tree by reference. A fork that was still running when the
  process stopped comes back as a failed **ready** result whose reason names
  the restart; it is never left `running` and never silently disappears. A
  ready result keeps its frozen record and its receive order, so the parent
  can still join it. A root branch writes the tree on every change, and a
  child's return persists the root branch through an injected capability, so
  the ready result reaches the branch a reload actually restores.
  `tests/forkjoin-recovery.test.mjs` (14 cases).
- Join admission is now an explicit estimate: the live outbound watermark plus
  the candidate record's characters at the model's measured density, compared
  strictly against the model window minus output reserve and safety margin.
  A record that cannot fit is refused as `JOIN_CONTEXT_EXCEEDED` **before** the
  take; the child stays ready, the receipt chain is untouched, and the
  `elder_report` is not archived. A smaller ready sibling may still be taken,
  and a waiting join answers instead of parking for capacity that cannot
  change. An unknown window or an unmeasured request is reported as unproven,
  never treated as zero or infinity. `src/scope/admission.mjs`,
  `tests/fork-join-admission.test.mjs` (10 cases).
- Fork-start admission closes the other half. A child session seeds from the
  parent's context and then reads its receipt, so its first request is the
  parent's watermark plus that receipt priced at the model's measured density,
  the fixed marker lines included. A known window refuses the whole batch as
  `FORK_CONTEXT_EXCEEDED` before any bracket is registered and before the
  spawner runs; the error names the failing index and the same numbers a join
  refusal carries, a blocked checkpoint needs no admission and spawns nothing,
  and an unknown window or unmeasured watermark passes as unproven. The
  resolved model's own `contextWindow` outweighs the parent's catalog entry
  when it is known, because the child runs on the selected model.
  `src/station/fork-controls.mjs` (`admitForkStart`, `handleForkCall`),
  `tests/fork-start-admission.test.mjs` (6 cases: refusal before ledger and
  spawner, failing index in a batch, room to start, unknown window,
  unmeasured watermark, blocked checkpoint).
- A join receipt that cannot reach the shared tree is no longer silent.
  `confirmJoinPersistence` reads `station.persist()` after `handleJoinCall`
  commits an immediate join and inside `finalizeJoin`, and `renderJoinResult`
  reports `details.persisted` (the field is omitted when the station has no
  persist port, so fixtures keep their old shape). A false verdict appends
  "Persistence warning: this join receipt exists in memory, but the shared
  tree was not written."; the receipt still stands in memory for this run.
  `src/station/fork-controls.mjs` (`confirmJoinPersistence`, `handleJoinCall`),
  `src/station/station.mjs` (`finalizeJoin`),
  `tests/join-persist-confirmation.test.mjs` (6 cases). The host's own
  transcript confirmation remains open; see Not verified.
- `elder_report` now has a quality floor and a ceiling: 24 to 4000 characters
  measured on the same string the tool schema accepts. A one-word value or an
  overlong report is refused with
  `INVALID_ELDER_REPORT`, the ready child is not consumed, and a pending
  receipt keeps its unreported state. Semantic completeness cannot be proven
  automatically; the tool text states what the summary must carry.
  `tests/fork-report-quality.test.mjs` (12 cases).

### Changed — a folded receipt must earn its replacement

- `applyReceiptFolds` now HOLDs when the report is empty, when the input is
  already a folded projection, when the whole projection is not strictly
  shorter than the record it would replace, or when the record carries
  `isError: true`. The comparison prices the header, the blank lines, the
  `[pin]` lines and the nested fork lines, so a report one character shorter
  than the record is not treated as a net gain. A failed record keeps its own
  words and its error flag: a summary never turns a failure into a
  successful-looking receipt. The short projection also keeps the child's
  `[pin]` lines alongside its nested fork lines, so a conclusion the parent
  still needs is not lost with the prose. `tests/fork-fold-economy.test.mjs`
  (10 cases), including the pin extractor and the projection boundary.

### Fixed — a frozen record and a pending report survive their own edge cases

- A spawn ticket's catch-all now writes through the same freeze check as the
  ticket itself: a child that already returned its record is not replaced by an
  empty failure when the spawn's tail throws. `src/host/fork-wiring.mjs`,
  `tests/fork-wiring.test.mjs`.
- A receipt that still owes its report is found across a level-key change: the
  relay generation and epoch name the level, and a handoff must not silently
  drop the previous generation's unreported join. `pendingReportOf` falls back
  to the last unreported receipt in the chain.
  `tests/fork-report-quality.test.mjs`.
- `restoreLedger` now refuses an inconsistent tree instead of half-restoring
  it: the restored snapshot must pass `assertPairing`, or the session starts
  from a clean ledger. `deserializeState` uses the checked form, so the receipt
  chain is dropped with an unpaired tree instead of leaving a pending report
  that points at a fork the tree no longer holds.
  `tests/forkjoin-recovery.test.mjs`.
- A child's `scope_return` that cannot write the shared tree is no longer
  silent: `station.persist()` returns the anchor's verdict, `handleReturnCall`
  appends a persistence warning to the pending receipt and records a
  diagnostic, and the ready result still stands in memory for this run.
  `tests/forkjoin-recovery.test.mjs`.

### Changed — child tools publish as one atomic block

- The root display has one tool slot. A child tool that stayed open held that
  slot and made the screen look frozen. Child `tool_execution_start` events are
  now buffered, `tool_execution_update` events are dropped, and the matching
  `tool_execution_end` publishes the start and the end together in one
  synchronous step. Root tools keep their real-time start and update. A child
  that detaches mid-tool publishes nothing. `tests/child-display.test.mjs`.
- The three scope tools (`scope_fork`, `scope_join`, `scope_return`) no longer
  create a transcript block, in the root or in a child; while they run, each
  holds one row in the active-tools tray. Dropping their
  `tool_execution_*` events was not enough: the host builds one transcript
  block per `toolCall` in a streaming assistant message before any tool event
  arrives, and only a terminal result finalizes that block. A zero-row block
  with no result stayed active and pinned the transcript's retirement frontier
  for the whole call — a `scope_join` waits for an entire child turn — so every
  later block was squeezed into one-row fragments and the output after the
  first scope call read as scrambled. The display bridge now removes scope
  `toolCall` blocks from the copy of the assistant message the screen sees, so
  no block is created at all and the text before and after the call reads as
  one continuous reply; the session's own message is untouched. The renderers
  still return `undefined` so a transcript rebuild draws the replayed call as
  zero rows. The model still receives the tool result; only the screen omits
  the call. `tests/child-display.test.mjs` (8 cases).
- Root tools other than the scope tools stream their real-time start and update
  in the "herd-tools" widget above the editor, and the display copy of a root
  assistant message drops every toolCall block, so no unfinalized ticket card
  is created. Child tools keep one live row in the same widget and append their
  transcript card when they end.
  A tool-shaped event with an unknown type is dropped instead of passed
  through. The working-line notices for scope tools are gone
  (`src/tools/wait-notice.mjs` and its suite).
- Ordering inside the display stream is now preserved on three edges: the
  updates a live root tool held back are published before their own
  `message_end` instead of after it; a root control event (`agent_start`,
  `agent_end`, `turn_*`) waits for a foreign open stream and for anything
  already queued instead of cutting into another source's message; and the dead
  `deferred` queue branch is gone. `tests/child-display.test.mjs`.
- A block that lost the display lease is no longer lost when its source
  detaches: a queued message keeps its accumulated updates and gains a
  synthetic aborted end, an already-paired child tool block stays queued and
  publishes whole, and a repeated `message_start` closes the previous record
  (as aborted) before streaming the retry. Only an unpaired tool start is
  dropped, because a start with no result would become the zero-row block that
  pins retirement. `tests/child-display.test.mjs`.
- A fork child's record now starts at its own receipt instead of the whole
  inherited context. A child session is seeded with the parent's prefix, so
  `handleReturnCall` used to replay the parent's conversation back into every
  join receipt — a live join produced a 253KB record. `childRecordStart` picks
  the first user message that opens with the receipt marker, falls back to the
  bracket's `startedAt`, and keeps the whole context when neither proves
  ownership. `tests/child-record-scope.test.mjs`.
- A skill receipt that cannot be placed no longer kills the turn. The prefix
  check refuses when the branch journal and the live request end at different
  messages — exactly a fork child, whose journal starts at the fork while its
  request carries the inherited prefix. The receipt only de-duplicates the
  skill injection, so the hook now records the refusal and lets the host's
  context stand; before, the host surfaced "Context skill commit failed during
  prefix check." and the child sat on "Working…" with no way out.
  `tests/context-preparation.node.test.mjs`.
- A child's accepted `scope_return` now returns `terminate: true`, so the host
  stops that branch's agent loop after the tool batch. Without it the child
  kept generating after "This scope is closed" and the root looked hung on a
  branch that would not end. `tests/fork-blocking.test.mjs`.

### Fixed — a finished child counted as finished work

- The stop guard, the nudge, the skill receipt and both bracket receipts
  counted only `running` children. A child that had called `scope_return` but
  whose record no join had taken was invisible to all of them: the parent was
  told "No children are still running", was not nudged, and could stop
  naturally with a finished result unread. `unreceivedChildren` in
  `src/scope/forkjoin.mjs` is now the one definition of the receive
  obligation: running **or** returned-but-unjoined. The fork receipt, the join
  receipt (`Unreceived:` replaces `Still running:`), the session-stop guard,
  the no-tool-call nudge and the per-request skill receipt all use it.
  `tests/join-obligation.test.mjs` covers the set, the stop, the nudge and the
  receipt.
- A join's `elder_report` could be whitespace. The gate accepted it because it
  was a string, while the receipt writer refuses to store an empty report: the
  join looked successful, the obligation survived, and the next refusal asked
  for a summary the model believed it had already given. A trimmed-empty
  string is now `INVALID_ARGUMENT` before any take.
- A join that waited committed against whatever receipt was newest at the
  moment of the take, not the one the model named. Two joins carrying the same
  summary could file it against the wrong receipt and leave the newest one
  permanently unreportable. The admitted binding now travels with the ticket
  (`details.pending`), `waitForReady` re-checks it with `canTake` before every
  take, and a mismatch returns `STALE_ELDER_REPORT` with the child and the
  receipt chain untouched. `finalizeJoin` commits with that binding.
- The join receipt promised "Pending report for your next successful join"
  even when no child remained, so the last receipt invited a call that could
  only fail. With nothing left to receive the receipt now says it stays
  complete and that a later join will ask for its summary first. `pendingReportOf`
  also treats an already-reported youngest receipt as discharged instead of
  demanding the same summary forever, and a join with no running or ready
  child answers `NO_UNRECEIVED_WORK` (stating that any carried report was not
  committed) before the report gate can demand one.

### Added — the root shows child work while it happens

- `src/host/child-display.mjs` installs one presentation bridge on the root
  session. Each child attaches before its first prompt, so its assistant text
  and tool progress reach the root display stream instead of staying invisible
  until `scope_join`. Ordering is first-come, first-served: the first
  `message_start` holds an atomic streaming block until its `message_end`;
  later sources queue in FIFO order. Streaming is exclusive: while a stream is
  open, another stream or block waits as a whole, and a tool event waits as one
  item, so nothing cuts into the middle of the open message. With no stream
  open, tool events from different sources are published as they arrive and may
  interleave. A detached child closes its own stream with an `aborted`
  end and cannot freeze the others. Child control events never
  impersonate the root; display never advances a join or a receipt. `tests/child-display.test.mjs` plus the spawner's
  attach/detach case in `tests/fork-wiring.test.mjs`.
- The root's UI context is now registered in `onStation`
  (`registerOwnerUI(owner, ctx.ui)`) and passed into `createBranchSession`, so
  a child's tool approval is shown in the root interface with the child's
  label. Without one, `OWNER_UI_ABSENT` / `TOOL_UI_UNSUPPORTED` is reported.
- The child receipt now states the UI contract: user messages go to the stable
  root and are not broadcast; output may appear before receipt; only
  `scope_return` submits; `scope_return` waits without spending the clock.

### Fixed — a fork child can spend the budget it declared

- `scope_fork` registered each child with `registerFork` but never passed the
  declared `budget`, then assigned `fork.budget` afterward. `registerFork` had
  already copied an empty object into `remaining`, so the child owned a budget
  that its own balance could not see: its first normal tool call resolved to
  `remaining: 0` and was refused as `BUDGET_EXHAUSTED`. The refusal carried no
  `reason`, and the host rendered its generic "Tool execution was blocked by an
  extension" sentence. Control tools bypass the charge path, which is why
  `scope_return`, `scope_join`, `pin` and `todo` kept working while `read`,
  `bash` and `write` were all blocked in a child.
- `registerFork` now receives the normalized budget, so `budget`, `remaining`
  and `spent` are born from the same input; the late assignment is gone.
  `applyCharge`'s `BUDGET_EXHAUSTED` refusal states the tool and the balance,
  and `gates.mjs` refuses to emit `{ block: true }` without a non-empty reason,
  so no accounting path can reach the model as an unattributed extension block.
  `tests/fork-budget-birth.test.mjs` (5 cases) covers the charge itself, the
  normalized birth state, a blocked plan, the stated refusal, and the gate's
  reason contract. Verified in the live host after a restart: a forked child
  ran `read` (package.json) and `bash` (`echo child-tools-ok`), spending its own
  declared budget (read 2→1, bash 1→0) with no refusal.

### Fixed — a child uses the parent's bracket ledger

- A real `scope_fork` run reached the child (it ran `echo child-ok`) but
  `scope_return` answered `UNKNOWN_FORK`. The child's tool context resolved a
  different conversation key, so its station built a second, empty ledger.
  `setIdentity` now carries the fork's ledger, and `attachForkPorts` uses it
  for a child station instead of deriving a new one from the child context.
  `tests/fork-wiring.test.mjs` "a child station uses the ledger carried by its
  identity". A restart is required to observe the fix in the live host.

### Fixed — an empty child record is a named failure

- `spawnChildTicket` reads the child turn list from `agent.state.messages`,
  `session.messages` or `agent.messages`. Reading only the first shape turned a
  valid host into a silent empty record. If no message was recorded after the
  prompt, the outcome is now `failed: true` with a reason that says the child
  produced no messages; a blank page is no longer reported as success.
- A display attach failure is recorded and does not fail the child; the record
  still returns through `scope_join`.
- A child session now installs its own context preparation before the first
  prompt (`branch-context.mjs`). This is the old scheduler's `prepareFlow`
  duty: it builds the child context, resolves the child station (binding the
  fork identity), and installs the request hook. Without it the host's skill
  receipt can fail the prefix check before the child produces any turn.
  `tests/branch-context.test.mjs`, plus the spawner ordering case.

### Changed — todo is never withheld, and an empty ledger is held

- The root branch may submit a todo ledger while it still owns an unreceived
  child. `TODO_WHILE_CHILDREN_OPEN` and its gate in `onToolCall` are gone. The
  receive obligation now withholds the relay, not the tool: an empty ledger
  submitted with a running or ready child returns `action: "held"` from
  `recordLedgerEvaluation`, leaves the relay untouched, arms no handoff, and
  reports `next.held-children`. A non-empty ledger still evaluates normally.
  `tests/fork-todo-gate.test.mjs`, `tests/todo-any-level.test.mjs`.

### Changed — waiting on a bracket does not spend the wall clock

- `scope_join` and `scope_return` are never capped by the branch's wall clock.
  While either waits, `station.pauseBranchClock()` freezes the remaining time;
  `resumeBranchClock()` shifts `deadlineAt` by the paused span. A manager's
  personal time budget does not include the people it hired; tool budget and
  time budget remain independent. `deadlineInfo` reads the pause edge, so a
  paused branch cannot enter overtime until it resumes.
  `tests/fork-tool-deadline.test.mjs`, `tests/forkjoin-budget.test.mjs`.

### Removed — the unused tool execution mode

- `executionMode: "sequential"` is gone from every registered tool. The host
  did not use it, and the runtime owns ordering through the bracket semantics.

### Changed — the three tools no longer seize the message

- `scope_join` and `scope_return` are no longer rejected when the assistant
  message carries another call, and `scope_fork` may share a message with any
  tool. The `MUST_BE_EXCLUSIVE_CALL` and `FORK_MESSAGE_MIXED` refusals, their
  two contract tests and the host `concurrency: "exclusive"` marker on all
  three tools are gone. A multi-call message is ordered by the model: place the
  two right brackets last. A child still sees the parent prefix as it stood
  when the fork started, so work that must be visible to a child belongs in an
  earlier message. The system prompt, README, blueprint and acceptance matrix
  say exactly that.

### Fixed — a fork's wall clock actually caps its tools

- `registerFork` now receives the item's `time` and a `startedAt`, so
  `deadlineAt` is real. `station.prepareToolDispatch` asks the branch whether
  it has a clock, and `installToolDispatch` installs the admission gate on that
  branch's tools. Before this, the old `afterScope` dispatch semantics always
  returned false, so the gate was never installed and a child's `time` was
  prose only. The root branch still has no clock. Tests:
  `tests/fork-tool-deadline.test.mjs` (11 cases).
- `src/host/scope-dispatch.mjs` became `src/host/tool-dispatch.mjs`; the
  dispatch tracker keeps positions and group keys but no longer computes
  `afterScope`, `hasScope`, `carriesScope` or `deferPreflight`.

### Removed — the remaining unowned shells

- `src/features/scope/` and `tests/contract/scope.test.mjs`: no runtime
  consumer remained. The port table keeps `bare`/`batch` only to refuse
  `HERD_SCOPE=single` at parse time.
- `src/host/event-mux.mjs`, `src/host/queue-retraction.mjs` and
  `tests/event-mux.test.mjs`: no producer or consumer remained after the
  scheduler retired.
- `trailingCalls` in `fork-controls.mjs`, and the three uncited sections of
  `resources/prompts/errors.md` (`not-in-scope`, `todo-inside-scope`,
  `flow-open`).
- The old comments now name the branch manager and the branch handoff.

### Fixed — the host smoke runs the current surface again

- `scripts/smoke-omp.mjs` required `scope` and `defer`, and imported
  `deriveFissionConfig`/`compareFissionFrames`, which no longer exist. It now
  requires the six registered tools and imports `deriveBranchConfig` /
  `compareBranchFrames`. On this machine it passes 11/11, with two SKIPs
  caused by the checkout's 18.12.6 native addon against its 19.0.0 source.
- `scripts/smoke-relay.mjs` lost the `pendingFission` line and the old `S5`
  constant; the retired container's shape is still probed and still refused.

### Docs

- `.agent/skills/fork-join/SKILL.md` records the failure-location table, the
  cross-module boundaries (including the retired exclusive-message assumption
  and the branch wall clock), the recovery and retirement rules, and the
  acceptance checks.
- `.agent/skills/fork-join-completion/SKILL.md` records the deletion evidence
  and the known gaps: the real host's first projection, join receipts not being
  a two-phase commit, and persistence that can leave a result only in memory.
- `tests/refactor-guards.test.mjs` now asserts the retired dispatch names,
  files, error sections, host-smoke exports and exclusive marker stay gone.

### Completed — fork/join receipts that actually project

- `station.transformContext` called `applyReceiptFolds` without importing it.
  Every request with a foldable receipt threw a `ReferenceError`, the catch
  returned the original list, and receipt folding never ran. The symbol is
  imported from the transcript index now, and the projection replaces only the
  right bracket's text: every left bracket, pin and the youngest receipt keep
  their bytes.
- `handleReturnCall` reparented orphans before marking the returning branch
  ready, so a grandparent read a ready child before the parent that introduced
  it. The parent's bracket is queued first, then its unreceived children move;
  a failed `markReady` changes no relationship. Already-ready children were
  never reparented at all; they are now collected from `readyChildren`.
- A reparented child closed at its birth level, so it never entered the
  receiver's sibling chain. `takeReady` now receives the receiver's `levelKey`.
- A child's record was written only after `spawnChildTicket` returned, while the
  parent could take the ready bracket in the same tick. `scope_return` freezes
  the record through `setChildOutcome` before `markReady`; the spawner never
  overwrites a frozen record.
- `elder_report` is exact: a non-null report with no pending receipt is refused
  with `ELDER_REPORT_UNEXPECTED` before any take, and a pending receipt still
  demands a non-empty report.
- `execute.directAmend` called `station.lastStructuralCallId`, a method the
  station never had, so the amend boundary was always empty. It calls the
  imported `lastStructuralCallId` now. `station.directScope` and
  `station.directDefer` were self-referencing dead methods and are gone.

### Removed — the interval folder and its economics

- `src/station/fold.mjs` (724 lines), `src/scope/degradation.mjs`, the
  `foldBatch`/`foldElder`/`pruneAmends`/`rebaseBaselines`/`accrueRentAndFlood`
  station methods, and the no-op `accrue` are deleted. `sliceChars` moved to
  `src/transcript/measure.mjs`; `noteSentContext`, `resetWatermark` and the
  density sample remain.
- `applyCollapses`, `applyForkJoinCollapse`, `collectPinnedMessages`,
  `isCollapsed`, `finishedReport`, `isForkJoinCollapsed` and
  `extractFoldedReports` are deleted with their tests. `collapse.mjs` keeps
  `applyReceiptFolds`, `extractForkLines` and `foldedScopeText`.
- `canFoldContent`, `canFoldInterval`, `elderOf` and `hasYoungerSibling` are
  deleted; `levelOrder` stays as the one read of `ledger.levels`.
- `branch-writes.mjs` keeps only `appendAt`. The unreferenced handoff copy
  helpers (`copyHandoff`, `mapId`, `handoffSegment`, `handoffWindow`,
  `handoffMessages`, `planHandoffRecovery`, …) are gone.
- `persistence.mjs` no longer carries `copyCollapse`, `measuredFields`,
  `validScope` or `validCollapses`. A snapshot's `charges` now store `ownerId`
  instead of the retired `scopeId`; an old charge's `scopeId` is read as its
  owner, so a charge written by the current code no longer resets the state on
  reload.

### Changed — branch naming

- `FissionManagerError`, `FISSION_UNSUPPORTED`, `FISSION_LEASE_CLOSED`,
  `FISSION_RELEASED`, `FISSION_SESSION_REASONS`/`LIMITS`,
  `deriveFissionConfig` and `compareFissionFrames` are renamed to
  `BranchManagerError`, `BRANCH_*`, `BRANCH_SESSION_*`, `deriveBranchConfig`
  and `compareBranchFrames`. The manager/session comments describe branches,
  not the retired scheduler. `fission.broadcast` and `fissionBroadcast` stay:
  they are persisted/transport identifiers for history, not an execution path.

### Verification — 2026-11-21

- `bun test tests`: 626 pass, 0 fail (50 files).
- `bun run lint`: clean.
- `bun run smoke:relay`: 12/12 checks.


### Added — todo and skill reads at every level

- `todo` is callable inside a scope at any level and stays free: it never
  touches a tool budget. A deep call writes the ledger and stops there — it
  does not evaluate the ledger, does not change `canStop`, does not clear the
  inherited-ledger debt, and cannot arm a handoff, even with an empty list.
  Only the outermost call advances the relay, exactly as before.
- `read` with a `skill://` path is free at every level, including outside all
  scopes, where it joins `todo` and the control tools as the only allowed
  calls. Other read paths keep their old gate. The decision lives once in
  `isFreeCall`; the event gate only implements the outermost exception.
- The prompt contract now says so everywhere: the todo and scope tool
  descriptions, the relay and scope receipts, `errors.md#not-in-scope`, and
  `system.md#persistent-rules`.

### Changed — `tdd-design` became `tdd-crowdsource`

- The stage skill is renamed, and its protocol is now red, clock in, green. Red
  is written by hand: each unit's complete mocked suite, stated as its consumer,
  is the contract a crowd builds against, and it is not run to prove failure.
  The `pin` records the dispatch plan instead of how the red would have failed:
  slices with their write and read sets, real edges and why, the critical path
  and its lower bound, the first wave, each slice's `time` and tool budget, the
  integrator, and the owner of every shared file. Green fans out at the widest
  ready frontier, releases each successor the moment a slice returns, and is
  judged by physical wall clock from clock-in to all-green, never by headcount.
  A worker whose slice is still splittable becomes a lead and repeats the same
  protocol — contracts by hand, its own clock-in, its own crowd — inside the
  wall-clock cap its parent gave it, so the dispatch plan is a tree rather than
  a single fan-out.
- `skills/tdd-design` is gone. `README.md`, `resources/prompts/system.md` and
  `.agent/skills/fork-join/SKILL.md` name `tdd-crowdsource`, and
  `scripts/sync-plugin.mjs` prunes installed files the package no longer ships,
  so a rename retires the old name in the installed plugin instead of leaving
  both skills discoverable.
- The mandatory line and the shipped-skill list in `system.md#persistent-rules`
  now name only the two skills the package carries (`decision-framing`,
  `tdd-crowdsource`) and point at `skill://tdd-crowdsource`. The gate states
  the current protocol — contracts by hand, dispatch plan pinned, then the
  crowd forks — and the independent-budget rule. `tests/prompts.test.mjs`
  refuses any named skill that is not a directory under `skills/` and any
  `skill://` reference that does not resolve, so a deleted skill cannot linger
  in the prompt.

### Changed — design records are skills

- Every stage artifact is written as a standard skill at
  `.agent/skills/<name>/SKILL.md` with YAML `name` and `description`, never
  under `docs/`. Long content keeps the skill form: `SKILL.md` is the entry
  and names the sibling documents that carry the detail. `tdd-crowdsource`,
  `decision-framing`, `system.md` and the README state the same rule.
- This change's own design record lives at
  `.agent/skills/todo-any-level/SKILL.md`.

### Verification

- `tests/todo-any-level.test.mjs` covers both behaviours (ten cases). It ran
  on a clean HEAD worktree at 9 pass / 1 fail; the one failure is the
  inherited-ledger case, which needs the workspace's `viewRequired` field that
  HEAD does not have. The workspace tree is mid-refactor and cannot link, so
  its regression run is pending that refactor.

### Removed — the `scope` tool and the begin/end protocol

- The `scope` tool is no longer registered. Its `begin`/`end` schema, its
  `scopeTicket`, its `handleScopeCall`/`handleBeginScope` handlers and its
  direct dispatch entry are gone. The only scope operations are `scope_fork`,
  `scope_join` and `scope_return`; no configuration, alias, or fallback can
  reach the retired tool.
- The working-level stack is gone from the domain: `state.scopes`,
  `currentScope`, `effectiveDeadline`, `scopeOrder`, `beginScope` and
  `closeScope` no longer exist. A branch's tool budget and wall clock now live
  on its fork record (`budget`, `remaining`, `spent`, `charges`,
  `timeBudgetMs`, `deadlineAt`) and are charged through `applyCharge` /
  `applyRefund`. The root branch has no tool budget and no wall clock.
- `amend` no longer requires an open scope. Its boundary is the branch's most
  recent structural call (`scope_fork`, `scope_join`, `scope_return`), and a
  beat that contains a structural call is never retractable.
- The execution barrier (`afterScope`, `barrierToolLimit`, trailing-call
  sharing) is removed with the tool that defined it. Fork items never inherit
  shared work from the parent's message.
- Persisted `scopes` and `collapses` fields are read-only history: a reload
  ignores them instead of rebuilding a second account or a second folding path.

### Changed — one folding path

- Only receipts fold. A later `scope_join` archives the previous receipt's
  `elder_report`; the projection replaces that receipt's work text and keeps
  every fork line, pin, adoption note and the newest receipt verbatim.

### Test surface — retired protocol removed, gaps recorded

- Deleted with the protocol they pinned: `tests/engine.test.mjs`,
  `tests/folding-economics.test.mjs`, `tests/fold-recovery.node.test.mjs`,
  `tests/relay-integration.test.mjs`, `tests/degradation.test.mjs`,
  `tests/persistence-delta.test.mjs`, `tests/persistence-rebase.test.mjs`,
  `tests/persistence-volume.test.mjs`, `tests/provider-observer.node.test.mjs`.
  The remaining suite is green (645 pass). Not yet re-covered: interval-fold
  economics, the persistence delta/rebase replay chain, long-session write
  volume, and the provider observer's fold-revision hash. `tests/transcript.test.mjs`
  now pins the structural amend boundary; `tests/prompts.test.mjs` pins the
  three-tool schema; `tests/refactor-guards.test.mjs` pins the receipt level key;
  `tests/fork-wiring.test.mjs` pins "identity creates no second account".
- `src/station/fold.mjs` and `src/transcript/collapse.mjs` still carry the
  interval-fold functions. They have no caller on the request path
  (`station.transformContext` runs receipts only), but deleting them is the
  next batch; `src/scope/usage-ledger.mjs` keeps a no-op `accrue()` for the same
  reason.

### Removed — the single scope implementation

- `single` is retired from the scope port. `PORTS.scope.implementations` is now
  `["bare", "batch"]`, so `HERD_SCOPE=single` fails at startup with
  `PORT_UNAVAILABLE port=scope wanted=single available=[bare, batch]` instead of
  landing on `batch`. `src/features/scope/single.mjs` and `batch.mjs` are
  deleted; `bare.mjs` keeps the method set and refuses every call, and `batch`
  is a name for "fork/join is available", not a container.
- The fission batch prose is gone from the scope reference, now
  `resources/prompts/tools/fork-join.md` (`fission.permission`, `fission.model`),
  and the file's cross-references point at the fork/join reference.
  `resources/prompts/tools/scope.md` was retired in the same change. `amend` and
  `pin` descriptions moved to `resources/prompts/tools/notes.md` so they outlived
  that edit.

### Changed — the workflow stages left the runtime

- The workflow stages are now three skills: `skills/decision-framing`,
  `skills/tdd-design` and `skills/orchestration-plan`. `tdd-design` merges the
  former acceptance-cases and architecture-design stages, because testability
  is a design constraint rather than a separate sitting. Direct execution
  ships no skill: it is ordinary work done against the plan. The runtime
  enforces no order and holds no flags; `resources/prompts/system.md`,
  `resources/prompts/tools/fork-join.md` (then named `scope.md`) and `README.md`
  all state that boundary. `tdd-design` was later renamed `tdd-crowdsource`;
  `orchestration-plan` was retired, and its design record remains at
  `.agent/skills/plan/SKILL.md`.
- `src/relay/texts.mjs` defined `firstEvaluationNudge`, `handoffPendingNudge`,
  `handoffEmptyReportNudge` and `openLedgerNudge`, and `src/relay/index.mjs`
  exported them, but no module consumed them after the stop rule changed:
  `handoffDemand()` and `insideScopeNudge()` are the two remaining definitions,
  and neither path reaches these texts. All four functions and their exports are
  removed.
- `injectSystemPrompt` decided whether to include the repo-aware rules by
  reading the whole string, including the managed block it was about to
  replace. The second call therefore dropped them. It now decides from the text
  outside the block, so a repeat call returns the same string.
- `DOCUMENTS` no longer lists `stages`; the stage prose is not a prompt
  document any more. `tools/notes` carries the `amend` and `pin` references
  that used to sit inside `tools/scope`.

### Verification — 2026-11-21

- `bun test tests`: 646 pass, 0 fail (49 files).
- `bun run lint`: clean, no output.
- `bun run smoke:relay`: 12/12 checks, including the retired `scope` tool
  being absent and `HERD_SCOPE=single` refused with `PORT_UNAVAILABLE`.
- `bun scripts/sync-plugin.mjs`: in sync, fingerprints ok. Restart the session
  before relying on this build.

### Fixed — a shortened receipt kept no fork identity

- `src/transcript/replay.mjs` rendered a nested fork as
  `(forked child: "intent")`, which dropped the fork id a grandparent joins
  by, the budget, the time, the permission and the model. The renderer now
  emits one structural line per item —
  `[fork f9] intent: "…" | budget: read 2, bash 1 | time: 120s | permission: ro` —
  numbering a batch the way the ledger does (`f9:0`, `f9:1`).
- Content folding replaced a receipt's whole text with the summary, so any
  fork line inside it vanished. `src/transcript/collapse.mjs` now extracts
  those lines (`extractForkLines`) and carries them under `Nested forks:` in
  both the interval fold and the projection fold. A shortened receipt still
  names every grandchild it started.
- `tests/forkjoin-transcript.test.mjs` had pinned the compressed line as the
  expected shape. It now asserts the structural line, the batch numbering, and
  that both fold paths keep it. `tests/forkjoin-contract.test.mjs` adds the
  parent-invariance assertion: one join leaves the parent's scopes, model
  caches and remaining budget byte-identical.

### Fixed — a reload forgot which receipt owed a summary

- `handleJoinCall` kept the "previous receipt must be reported" obligation in
  a per-station `Map`. The station is rebuilt on every reload, so the first
  join after a restart accepted an unreported receipt and the fold gate lost
  its summary. The obligation is now derived from the persisted
  `state.receipts` chain first (`latestReceiptOf` at the branch's level key)
  and falls back to the map only for fixtures without persistence.
  `tests/forkjoin-contract.test.mjs` "a persisted receipt still demands its
  summary" builds a station with receipts but no map, asserts
  `INVALID_ELDER_REPORT` without consuming the ready child, then accepts the
  join with the summary and checks the report landed on the old receipt.

### Corrected — the receive obligation holds the relay, not the todo tool

- The receive obligation never withholds `todo`; the tool stays free at every
  level. A root that still owns an unreceived child can submit an empty ledger,
  but the relay transition holds it instead of arming a handoff that would
  abandon the child. A non-empty ledger still evaluates, and a child's write
  never touches the relay. `tests/fork-todo-gate.test.mjs` covers both
  directions; `tests/refactor-guards.test.mjs` asserts the retired
  `TODO_WHILE_CHILDREN_OPEN` gate stays gone.

### Verification

- `bun run lint` — no output.
- `bun test tests` — 806 pass, 0 fail, 55 files. The count fell from 847
  earlier in the migration because deleting the fission scheduler took its
  dedicated test files with it; the blueprint asks for that removal. It rose
  again by eight this round: three renderer/fold assertions, the parent
  invariance test, three handling/idempotence assertions, and the reloaded
  report obligation.
- `bun run smoke:relay` — 12/12 checks, including "the registry exposes three
  fork/join tools" and "the retired one-container backend is refused" (the
  latter asserts `HERD_SCOPE=single` returns `PORT_UNAVAILABLE` with
  `available=[bare, batch]`).

### Not verified

- Durable commit confirmation for a receipt (G4). No port acknowledges that a
  specific receipt reached durable storage. `commitSkillReceipt` writes through
  `appendToJournal`, whose immediate readback proves only that the current
  branch retains the message (`src/host/hack-context.mjs:46-59`). The only
  related settlement is `await session.settleInFlightMessagePersistence?.()`
  (`src/host/branch-session.mjs:626`, `src/host/context-preparation.mjs:252`),
  which drains whatever the host has already queued before a read; it returns
  no per-message acknowledgment and its absence is tolerated. A join receipt
  is a tool result whose persistence the host owns after the tool returns, so
  the station cannot observe it at all. A verifiable contract would need a host
  port that accepts one message and returns a commit acknowledgment or an
  error; the port table has none, so no code calls one and no test can pin the
  behavior. Window admission is no longer on this list: the fork-start and join
  halves are implemented and tested (see the Added block above). The station's
  own scope state is the narrower, verifiable case: `confirmJoinPersistence`
  reads `station.persist()` after `handleJoinCall` commits a receipt and in
  `finalizeJoin`, and `renderJoinResult` reports `details.persisted` (omitted
  when the station has no persist port) and appends a warning when the shared
  tree was not written; the receipt still stands in memory for the run
  (`tests/join-persist-confirmation.test.mjs`, 6 cases). What remains open is
  the host's durable write of the receipt transcript, not the station's own
  state.
- The real host's first child request was observed (the probe under
  "Verification — final"), but the first-request projection and the
  parent-prefix alignment against that request remain unverified; the docs
  bullet above records the first projection as a known gap.
- No spawn timeout. `spawnChildTicket` awaits `createSession(spec)` and then
  `session.prompt()` with no timer; a host call that never settles leaves the
  bracket running and the parent's join waiting forever, and no outcome is
  frozen. This is an accepted risk, not a shipped watchdog: no `AbortSignal`
  contract is verified for the prompt (it is duck-typed; `agent.abort` is only
  checked for `stopAfterScopeReturn`), so a `Promise.race` would wake the parent
  without cancelling the host turn or its cost. The branch clock only caps
  ordinary tool calls, and a join pauses that clock, so a join timeout cannot
  substitute.

### Changed — breaking

- The stop rule no longer has a simple-mode exemption. Ending a session always
  takes two empty ledger evaluations: one that arms the handoff, and the
  successor's first evaluation. A natural stop outside every scope is now
  recorded as that first empty evaluation instead of earning a steer:
  `onSessionStop` calls `applyNaturalStop`, which runs the same transition as
  `todo({ list: [] })`. When the stop arms a handoff, the demand goes out as a
  plain user prompt and the context receipt carries the same text; when it is a
  successor's first evaluation, the stop is lawful and the chain ends. The only
  natural stop still corrected is one that would abandon a non-empty ledger.
- The handoff demand has one definition, `handoffDemand()`. It renders in the
  todo result, in the tool-block reason, and in the context receipt;
  `firstEvaluationNudge`, `handoffEmptyReportNudge`, and `handoffPendingNudge`
  are gone, because a stop now needs no nudge.
- A stop with open work in the ledger is a retirement, not a fault. The holder
  is exhausted; `applyRetirement` keeps the ledger intact and arms the handoff,
  so the next generation continues what is left instead of the runtime
  demanding more work. Promotion now reads the incoming ledger: a first empty
  evaluation ends the chain only when that ledger was empty or absent, so a
  retirement still costs two empty evaluations before anyone may stop.
- A retired ledger is read before it is rewritten. `relay.viewRequired` makes
  the successor's first `todo` write fail with `INHERITED_LEDGER_UNVIEWED`
  until it runs one free `todo({ op: "view" })`; the receipt and the handoff
  text say so, and a successful view clears the requirement.
- Workflow guidance is now omp skills instead of runtime state. The package
  ships `skills/decision-framing` and `skills/tdd-crowdsource`; at this point in
  the migration the second was still named `tdd-design`, and a third,
  `orchestration-plan`, was planned but later retired. Its design record remains
  at `.agent/skills/plan/SKILL.md`. omp discovers the shipped skills through its
  `omp-plugins` provider, so installing the plugin makes `/skill:<name>` and
  `skill://<name>` work with no configuration. Direct execution ships no skill:
  it is ordinary work done against the plan.
- `acceptance-cases` and `architecture-design` are merged into `tdd-design`.
  That skill makes testability a design constraint: every unit's tests are
  written before its code, with every collaborator mocked at the contract
  boundary. A red suite is recorded with `pin` instead of being run, because a
  red run spends resources and proves nothing the written test does not state.
  Implementation may start only after that red pin exists.
- `scope({ begin })` no longer takes `stage`, and `scope_fork` items no longer
  take `stage`. A begin is `{ intent, budget, time }`. The stage flag table,
  the execution gate, the `stages` port, and the injected Stage Prompts block
  are gone; the runtime no longer enforces an order between stages.
- `ask` now depends on herd mode alone, not on a `decision-framing` scope.
  `permission: "rw"` keeps one refusal: the full flow before its first
  submitted ledger.

### Removed

- `src/scope/stages.mjs`, `src/scope/stage-flags.mjs`,
  `src/features/stages/index.mjs`, `src/host/stage-prompts.mjs`, and
  `resources/prompts/stages.md`. Their text moved into the four skills.

### Added

- Fork/join scope control: `scope_fork` opens one or more child branches
  without blocking the parent, `scope_return` submits a child's record and
  waits for acceptance, and `scope_join` parks until a child returns and
  delivers its replay as the parent's tool result. The parent keeps its model,
  depth, and prefix; a child's unreceived work is reparented when the child
  returns. Each child opens its own real working scope from the fork's stage,
  budget, time, and permission, and binds its host agent id so the branch can
  identify itself. A successful join arms the previous receipt's
  `elder_report`; a later join without that report is refused before any
  bracket is consumed. The old fission batch scheduler remains callable but is
  not part of the new path; `.agent/skills/fork-join-completion/SKILL.md`
  records the retirement checklist and the host evidence still required before
  deletion.

- Folding economics now prices context-bloat degradation. Effective work per turn
  falls linearly from 1 to 1/2 across the context window, so a fold is credited
  not only with the bytes it stops re-reading but with the extra turns it removes:
  the full context re-read, the model's output, and the cache write of each new
  turn. `src/scope/degradation.mjs` holds the pure arithmetic; the usage ledger
  accrues the same amount as sunk rent per actual turn, and the Bellman identity
  `N_keep * rent === N_fold * pHit * B + degradationValue` keeps history and the
  forward decision on one ruler. Unknown windows reduce byte-for-byte to the old
  model.
- Pricing policies carry `pOut`, and the usage ledger smooths measured output and
  per-turn context growth, so reasoning models no longer look cheap per turn.
  `pricingHint()` now forwards the token counts alongside the charge, which lets
  usage-derived prices work at all.

### Changed

- `HERD_RELAY=none|ledger|handoff` now selects real behavior. `none` ignores a
  ledger write and keeps the nudge off; `ledger` records the ledger but refuses
  to arm or advance a handoff; `handoff` keeps the transfer path. A station
  built without a registry keeps the default `handoff`, so unit doubles do not
  change meaning.
- `HERD_DISABLE_FOLDING=1` and `HERD_DISABLE_MODEL_SWITCH=1` now change
  behavior. Folding is refused at the station's single branch-write entry, so
  no flood or economics path can fold; model switching neither queues nor takes
  a pending choice while the port is off.
- `HERD_DISABLE_STATUS=1` and `HERD_DISABLE_OBSERVER=1` now suppress the
  widget and the provider hooks. Both switches already resolved to `off`, but
  the two installers bound their host events unconditionally, so a disabled
  feature kept running.
- `HERD_DISABLE_PIN`, `HERD_DISABLE_AMEND` and `HERD_DISABLE_HERD` now change
  behavior. The three ports had implementations and contract tests but no
  runtime consumer; the station now builds each implementation from the resolved
  table on every call and writes through its own persisted state, so `off`
  refuses instead of silently succeeding.
- `HERD_DISABLE_STAGES=1` now really disables the stage feature. The scope gate skips
  `STAGE_FLAGS_UNMET` for `direct-execution`, and the managed system prompt omits the
  stage block instead of leaving rules whose enforcement is gone. The switch had been
  parsed into `off` since the port work, but nothing read it at runtime.
- `activate()` accepts the environment it resolves ports from, and the relay integration
  harness passes an explicit one. Running the test suite from a shell that sets a herd
  switch no longer flips default-behavior assertions.
- With `clock=off`, begin/end/amend/skill receipts no longer print the wall-clock
  segment. `budgetText()` takes the port's `bounded` answer; the scope record still
  carries the numbers, so persistence is unchanged.

### Fixed

- `HERD_DISABLE_COMMON_RULES=1`, `HERD_DISABLE_CHINESE_REMINDER=1` and
  `HERD_DISABLE_VIBE_COMPAT=1` now remove their prompt fragments. The switches
  were dropped when features became ports, so the managed prompt assembled every
  fragment unconditionally. Boolean disable names also keep their word
  boundaries now, so camelCase ports such as `modelSwitch` accept
  `HERD_DISABLE_MODEL_SWITCH`.
- A live loop whose assistant frame is committed before its tool result no longer
  aborts the next model call. `splitRequestHistory()` isolates dead assistant frames
  anywhere in the pending tail and reports a committed frame's trailing result as
  `frameInFlight`; the hook defers that one preparation without rewriting context or
  writing a receipt. Orphan results, unknown roles, and a lost or ambiguous committed
  tail still fail with `CONTEXT_PREPARATION_HISTORY_MISMATCH`.

- An open flow that stops normally receives a steer to continue instead of crashing the batch. Recoverable external failures wait for user input; permanent per-flow failures no longer discard a completed sibling's work.
- Request preparation can verify interrupted tails and match live assistant frames without rewriting them. Spawning no longer duplicates the SDK-restored history, and takeover keeps the heir's warmed message prefix.
- A child-session factory that threw surfaced only as `CREATE_FAILED`; the
  original error never reached the parent. The create-failure branch now keeps
  the refusal code and appends the factory message
  (`CREATE_FAILED: <message>`), and records the structured error in the
  diagnostics ring with `{ forkId, phase: "create" }`.
  `tests/fork-spawn-chain.test.mjs` adds "a throwing factory fails the fork and
  preserves the cause".

### Verification — final (2026-11-22)

This block supersedes every earlier checkpoint in this section: the
9-pass/1-fail mid-refactor run, the 626/50, 646/49, and 806/55 suites, the
804/2754 pre-admission suite, and the 802/2738 generation-5 run.

- `bun test tests`: 816 pass, 0 fail, 2801 `expect()` calls, 68 files, after
  fork-start window admission and its six cases plus join receipt persistence
  confirmation and its six cases, on top of the scope-title display fallback
  and four spawn-chain cases: the success chain, the
  `NO_FORK_FRAME` refusal, a rejected first prompt, and a throwing session
  factory whose original message survives as `CREATE_FAILED: <message>`.
- `bun run lint`: clean, no diagnostics.
- `bun run smoke:relay`: 12/12 checks.
- `bun scripts/sync-plugin.mjs --check`: in sync, fingerprints ok.
- `OMP_HOST=/path/to/oh-my-pi OMP_SMOKE_STRICT=1 bun scripts/smoke-omp.mjs`:
  13/13 checks, recorded in generation 5 and not re-run for this block. The
  model readback was explicit `google-antigravity/claude-opus-5-5 @ low` and
  inherited `kw92/mistral/deepseek-v4-1-flash-1017`.

The live host turn is observed in a one-shot probe: `/tmp/g5-host-turn2.log`
(1062 JSONL lines, session cwd `/tmp/g5-probe`) records a real `scope_fork`
call whose joined child record carries the child's first user message
`You are the child of fork g5-probe2, depth 1.` The probe is evidence, not a
regression test; `tests/fork-spawn-chain.test.mjs` pins the same spawn seam
offline, now including both failure branches. The `Not verified` block above
now names durable commit confirmation, the unverified first-request projection
and parent-prefix alignment, and the absent spawn timeout; window admission is
delivered on both sides and pinned offline by
`tests/fork-start-admission.test.mjs` and `tests/fork-join-admission.test.mjs`.
The host smoke sends no completion request.

## [2.3.0] — 2026-11-19

This release numbers the workflow work accumulated since 2.1.0 as a minor
release rather than a patch: the diagnostics ring, delta state persistence, the
host seam self-check, the silent-failure fixes, and the cross-stage discipline
in the Stage Prompts block arrive together. The 2.1.1–2.1.6 entries below record
the individual steps that led here and stay as history; this section records
what this release itself changes.

### Added

- `bun run smoke:relay` drives the `todo` and `scope` tools that `activate()`
  registers, against the real station in a fresh process, and asserts what a
  session actually reads: both `Flow:` lines, the empty ledger's relay handoff,
  the promoted successor's return to simple mode, and both directions of the
  `direct-execution` gate. A build that emits no `Flow:` line exits non-zero.
  This closes the gap the sync script left open: the installed copy can match
  the working tree file for file while a running session still serves the
  modules it loaded at process start, and writing a probe with a reused
  tool-call id reads the cached refusal instead of the live gate.
- `bun run sync:plugin` copies `src/` and `resources/` into the installed
  plugin, reports every drifting file, and exits non-zero while the copy lacks
  the current build fingerprints (`status.flow`, the `reopened` branch, the two
  `fullFlow` gates). omp loads the installed copy rather than this working
  tree, so live checks made before this change ran an older build: no `Flow:`
  line, and `direct-execution` refused before the `RW_BEFORE_LEDGER` check.
  The README now states the copy-then-restart requirement, and a `todo` result
  without a `Flow:` line marks the session as stale.
- The full flow is now optional. A session starts simple: a clear, small task
  opens `direct-execution` with `"rw"` and no stage flags. The first submitted
  `todo` ledger, empty or not, turns the full flow on: the stage flags, the
  five-stage protocol, and the relay apply, and stay on across handoffs until
  the promoted second empty evaluation ends it. A later task is simple again
  until another ledger is submitted; a later submission, empty included, turns
  the flow back on without arming another handoff. `todo` views never turn the
  flow on.

### Fixed

- Fission owner retirement now gives the host an explicit abort reason. This
  prevents the host from retrying a deliberately retired owner as a dropped
  model stream while its flows are running.
- An owner prompt that starts a fission batch now waits for its flows and heir
  before returning, so print mode selects the adopted answer instead of the
  retired owner's abort.

### Changed

- `scope` beginnings now have one shape:
  `{ stage, elder_report, fission: [{ intent, budget, permission, model? }] }`.
  `fission` is a non-empty array, `elder_report` is required (a string or
  `null`), and every item must declare `permission: "ro" | "rw"`; an omitted
  or null permission rejects the whole batch instead of defaulting to `"rw"`.
  There is no single-flow begin shape, so one flow is a one-item array, and the
  batch is validated atomically before any flow starts. `"ro"` is a declaration
  the system trusts: no tool is blocked because a flow called itself read-only.
  A fission begin
  cannot also close a scope: `end: true` with `begin` is refused before any
  state change, so a caller closes the current scope with a plain `end: true`
  call and opens the batch in a following call. The scope tool reference, the
  persistent rules, the not-in-a-scope error, and `README.md` now describe this
  shape and the limitation.
- A refactor now states its class explicitly: it changes structure without
  changing behavior, and it still submits a ledger. The three prompts carry
  the sentence verbatim, and a prompt contract test pins it.
- `SessionStation` no longer owns the dispatch positions, the processed-id
  caches, or the persistence anchor. `DispatchTracker`, `ProcessedLedger`, and
  `PersistenceAnchor` own them, and the station delegates. The `usage`
  forwarding properties (`lastTotalInput`, `lastOutputTokens`, `lastUsageCost`,
  `lastCtxModel`, `lastUsageModelKey`, `sentContext`) are gone: controls,
  models, and handoff-state read the ledger's public fields through
  `station.usage`. A fold now prunes amend keys whose beat left the branch, so
  a dead key no longer rides every checkpoint for the rest of the session.
  `activate()` preloads every prompt document, so a missing resource fails at
  startup instead of mid-session.
- The fold-pool key is now `JSON.stringify([parentId, boundary, epoch])`. The
  old template string carried two literal NUL bytes as separators; they are
  gone, and `scope-1`/23/4 can no longer collide with `scope-12`/3/4.
- `deserializeState` no longer reads the pre-rename `regrets` field. A missing
  `amends` field still migrates as an empty list; a snapshot that carries only
  `regrets` loses its amend keys.
- `bun run smoke:relay` passes a required `time` when it opens a scope. The
  script predated the wall-clock requirement, so its begin was refused with
  `INVALID_TIME` and the following end reported `NOT_IN_SCOPE`.
- Task nature now selects the flow by default. The persistent rules, the stage
  prompt header, and the `todo` tool description say the same thing: a
  development task (a feature, a refactor, a design change) in principle
  submits a ledger, so the five stages and the relay apply; an operational task
  (ops, maintenance, diagnostics, delivery) in principle finishes in one simple
  `direct-execution` scope. Judgment about what the work actually needs
  overrides the default, so the rule guides the choice instead of forcing it.
  A prompt contract test pins the sentence in all three documents.
- The no-ledger nudge names both lawful ledger shapes. A model that had nothing
  to do saw only `todo({op:"init", list:[{phase,items}]})` and "The ledger must
  state what the user still needs", and invented work to satisfy it. The
  `first-evaluation` receipt now also names `todo({op:"init", list: []})`, says
  that an empty ledger is the lawful answer when nothing remains, and forbids
  inventing work; the `rw` refusal and the status next-line name the same two
  shapes. A regression test pins the symmetry. Judgment is untouched: the
  successor's first evaluation is still empty-only for a promotion, and
  `stop-verdict` keeps its order.
  Verified live against `mistral/deepseek-v4-1-flash-1017`: one `你好` reached
  generation 1 with an empty first evaluation and stopped in 22.9 s; no work
  was invented.
- `regret` is now `amend`. The mechanics are unchanged — remove the last
  completed beat, refund its budget, require a reflection — but the name and
  the prose no longer frame an ordinary correction as a confession.
  `reflection` is documented as the replacement text that stands where the beat
  was, the tool result echoes it, and the description states that side effects
  already performed stay in place. The state field `regrets` became `amends`;
  saved state that still carries `regrets` is read once and carried forward.
- Every model-facing string now lives in `resources/prompts/` as Markdown
  documents with `## section` blocks: tool contracts, parameter descriptions,
  stage prompts, system rules, scope and relay receipts, and error text. Code
  loads them through `src/prompts/index.mjs`; source modules only map and
  compose. `package.json` ships `resources/`.
- Stage flags replace the free jump into `direct-execution`:
  `acceptance-cases`, `architecture-design`, and `orchestration-plan` start
  false and turn true when their scope opens; `direct-execution` requires all
  three and does not clear them; opening `decision-framing` clears them. A relay
  handoff also clears all three in the same transaction as the generation
  advance: a successor must run the stages itself, because the predecessor's
  runs prove nothing about its intent. Flags persist across snapshots and
  compaction, but never across a generation. Subagent sessions are exempt from
  the ordering gate — a read-only or read-write subagent may open any stage in
  any order and never writes the flags, which describe the main holder's work
  line only.
- Prompt tests now assert that each export equals its document section and that
  templates render strictly, instead of pinning prose by substring.
- The model name fallback in the context-window error moved into
  `resources/prompts/labels.md`, so no model-facing sentence stays hardcoded in
  source. The duplicated stage prompt copy in `docs/design/stages.md` is gone:
  `resources/prompts/stages.md` is the only copy.

- The Stage Prompts block now carries the cross-stage discipline: the four
  working stages may open in any order and none gates another, but in principle
  the work runs `acceptance-cases`, then `architecture-design`, then
  `orchestration-plan`, and only then `direct-execution`. Each stage leaves its
  artifact on disk and pins its path, and execution follows the plan instead of
  deciding the design a second time. Jumping stays legal for exploration,
  rework, and repair; it is not a license to skip.
- The `orchestration-plan` section adds a "Maximize parallelism" paragraph:
  open every slice that shares no mutable state with another in one batch, drop
  waves that exist only for ceremony, wait only on a true dependency, and treat
  a slice that could have started earlier as a defect in the plan.
- `README.md` and `docs/design/stages.md` mirror both changes. The stage enum,
  the gates, and every runtime behaviour are unchanged: this release changes
  prompt text and documentation only.
- `tests/prompts.test.mjs` pins both paragraphs by exact substring and pins the
  discipline to a position before the stage sections it governs, so a later
  edit that drops the order rule or the parallelism mandate turns the suite
  red.
- `docs/design/stages.md` §9.1 regained the sentence about a free
  `ast_edit` preview write, which the source has carried since before 2.1.0.

## [2.1.6] — 2026-11-19

### Fixed

- `sendSteerTicket()` and `sendUserMessageTicket()` swallowed every delivery
  failure. A refused steer meant the relay's nudge never reached the model; a
  refused prompt meant `/herd <text>` lost the user's message. Both looked like
  an idle system, because nothing recorded them. Both stay best-effort and never
  reject, but each now records a `tickets` diagnostic with its kind and message
  length.
- `commitSelfHandoff()` kept the pre-handoff agent messages when rebuilding the
  context threw, and said nothing. The branch already held the compacted
  transcript, so the successor could read the wrong one. The failure is now a
  `handoff` diagnostic; the fallback behaviour is unchanged.
- `createStatusRuntime().readBranchUsage()` started the status line at zero
  usage when the branch could not be read, silently, so every later number was
  measured from zero with nothing on screen saying why. It now records a
  `status` diagnostic with `{ stage: "branch-usage" }`.
- `wireHooks()` reported a refused `assistant_message`/`message_end` pair but
  treated a refused `message_end` usage listener as "optional" in a comment. A
  provider that attaches usage only at message end then lost it invisibly. The
  refusal is now a `hooks` diagnostic with `{ missing: ["message_end"],
  optional: true }`.
- `activateToolsTicket()` swallowed a refused `setActiveTools()`. The relay
  already turns off when `todo` is absent, but the reason was invisible; it is
  now a `tools` diagnostic.

### Changed

- `herd-diag` prints each record's stored `detail` as compact JSON on the same
  line. The ring has kept evidence such as `missing` since 2.1.0, and the one
  command that shows it dropped that field.

### Added

- `tests/silent-sites.test.mjs`: one case per site above, each asserting the
  diagnostic the previous implementation never wrote.

## [2.1.5] — 2026-11-19

### Fixed

- `wireHooks()` treated a registration that never happened as success. When
  the host refused `assistant_message`, the fallback was `message_end`, and
  when that was refused too the extension still loaded with every tool in
  place while no message ever reached a station: scopes stopped advancing,
  pins stopped landing, and the status line looked healthy. The function now
  reports `{ ok, missing, error }`, records a `hooks` diagnostic, and the
  session-start notice names the dead event next to the existing seam notice.
- `src/host/status.mjs` wrapped every handler in a `catch` that returned
  `undefined`, so one rendering bug erased itself on every event. The failure
  is now recorded as `status`; the other displays still keep running.
- `restoreFromBranch()` kept a null usage baseline in silence when the branch
  could not be read, which then made every scope baseline start from the
  wrong number. The loss is recorded as `usage`.

### Changed

- The diagnostics ring coalesces an immediately repeated
  `(domain, message)` pair into one record with a `count`, so one failure
  repeating on every render can no longer push the earlier, rarer failures
  out of the 64 slots. `herd-diag` renders the repeat as `×N`.
- Removed the station's `tokensPerChar()` delegate, which had no caller. The
  watermark accessors next to it stay: `controls.mjs`, `models.mjs`, and
  `handoff-state.mjs` read the ledger through the station on purpose, and the
  comment there now says so.

### Added

- `tests/hooks.test.mjs`: both message events refused, the remaining hooks
  still bind, a `hooks` diagnostic lands, and the session-start notice names
  the dead event once per session.
- `tests/silent-failure.test.mjs`: a throwing status handler and an
  unreadable usage branch each leave a diagnostic instead of vanishing.

## [2.1.4] — 2026-11-19

### Fixed

- `anchorOnBranch()` answered "the base is fine" when it could not check:
  a host that returns no id from `appendCustomEntry()`, a manager without
  `getBranch()`, or a branch that is not an array all returned `true`. Since
  `persist()` only asks when it holds a base, such a session kept appending
  deltas with nothing to anchor them; the first branch rewrite would leave
  them on a truncated chain and a restart would silently come back empty.
  Every unverifiable case now forces a checkpoint, which matches what the
  method's own contract already promised.

### Added

- `tests/persistence-rebase.test.mjs`: a host that hides entry ids still
  restores every pin after a rewrite, because no delta is written without a
  named anchor.

## [2.1.3] — 2026-11-19

### Fixed

- `persist()` trusted the snapshot it had last written as a delta base without
  checking that the entry carrying it was still on `getBranch()`. The fold
  paths invalidate that base explicitly, so the guarantee held only for as long
  as every future branch rewrite remembered to do the same. The station now
  records the id `appendCustomEntry()` returns and re-checks it against the
  live branch before writing a delta; an unreachable or unknowable anchor
  forces a checkpoint.

### Added

- `tests/persistence-rebase.test.mjs`: an unannounced rewrite — `branch()`
  called directly, with no fold and no `rebased` flag — must not downgrade the
  next write to a delta, and the reopened station must keep every pin.

## [2.1.2] — 2026-11-19

### Fixed

- A fold rewrites the session branch from an earlier entry, so every
  `scope.state` entry appended after that point leaves `getBranch()`.
  `SessionStation` kept its previous snapshot as the delta base and appended a
  delta onto the rebased branch, which carried no checkpoint: a restart within
  the next 64 writes restored an empty state, silently losing pins, scopes,
  herd mode, and the relay. `foldElder()` and `foldBatch()` now invalidate the
  persisted base when a fold reports `rebased`, and write a checkpoint
  immediately on the new branch.

### Added

- `tests/persistence-rebase.test.mjs`: drives the real station through
  `foldBatch` against an omp-shaped session tree, then restores a second
  station from the same manager and demands the same state. It fails without
  the checkpoint.

## [2.1.1] — 2026-11-19

### Fixed

- `installRunnerCapture()` returned the internal capture record, which has no
  `ok` field, so a caller that checked `diagnosis.ok` saw a failure with an
  empty reason. It now returns the same `{ ok, missing, error }` shape as
  `captureDiagnosis()`. The host smoke only reached this path once the seam
  could load, which is how the defect surfaced.

### Changed

- `scripts/smoke-omp.mjs` verifies the two prototype seams against the real
  `AgentSession` even when the checkout's native addon predates its source: it
  borrows a matching prebuilt addon from `~/.omp/natives/<version>` (or
  `PI_NATIVES_DIR`), re-running itself with `PI_COMPILED` and `PI_NATIVES_DIR`
  set. `OMP_SMOKE_BORROW=0` restores the previous honest skip. On a machine
  with the 19.0.0 addon, all ten checks pass; the stale addon had blocked the
  seam check, not the seam itself.

## [2.1.0] — 2026-11-19

### Added

- CI workflow: `bun install --frozen-lockfile`, `bun run lint`, `bun test`.
- ESLint flat config that forbids `async`, `await`, and `for await` inside
  `src/station/`, `src/scope/`, and `src/relay/`. The station rule is now
  mechanical instead of a convention.
- `src/host/diagnostics.mjs`: a 64-entry ring buffer. Failures that used to be
  swallowed into a single overwritten `lastError` string are now recorded with
  a domain and a timestamp, and the status line shows `⚠ N` while any exist.
- A read-only `herd-diag` command that prints the buffer.
- Host seam self-check: `host/capture.mjs` reports which prototype seams it
  failed to install, and the first `session_start` of a session raises a
  visible error naming them. Folding and relay no longer degrade silently when
  the host renames an internal.
- `src/scope/usage-ledger.mjs`: token and cache accounting moved out of
  `SessionStation` into a plain synchronous domain module (344 lines).
- `src/scope/persistence.mjs`: `diffState`, `applyDelta`, `planStateEntry`,
  `foldStateChain`. State is now appended as deltas against the previous
  snapshot, with a checkpoint every 64 writes, on more than 32 operations, or
  above 16 KiB.
- `tests/persistence-delta.test.mjs`, `tests/diagnostics.test.mjs`,
  `tests/diagnosis.test.mjs`, `tests/capture.test.mjs` (40 cases).
- `tests/persistence-volume.test.mjs`: 400 turns of real `persist()` append
  442,905 bytes where per-turn full snapshots would append 9,794,174 bytes
  (4.5%), and the folded chain restores the exact final state. The test fails
  if the delta policy degrades toward one snapshot per turn.
- `LICENSE`, `.gitignore`, `CHANGELOG.md`, `docs/adr/`, `scripts/smoke-omp.mjs`.

### Changed

- `persist()` no longer writes the whole serialized state on every turn. It
  diffs against the last snapshot and appends whichever entry the policy picks,
  and it writes nothing when nothing changed.
- `restoreState()` replays the `parentId` chain back to the nearest checkpoint,
  then sanitizes once. Legacy full-snapshot entries still restore.
- `SessionStation` shrank from 858 to 773 lines; its accounting methods are
  thin delegates now.
- `STAGE.md` moved to `docs/design/stages.md`. The S1–S5 table moved to
  `docs/adr/0001-stage-names.md`.
- `package.json`: description covers the workflow, relay, pricing, and herd
  mode; version 2.1.0; `repository`, `keywords`, `scripts.test`,
  `scripts.lint`, and an `eslint` dev dependency.

### Fixed

- `applyDelta` resolved a `trunc` operation against the array's parent instead
  of the array itself, so a shrinking array was never truncated during replay.

### Migration

- Existing sessions keep working: their last `scope.state` entry has no
  envelope and is treated as a checkpoint. The first write after upgrade
  appends a delta against it.

## [2.0.0] — earlier

The five-stage workflow, relay handoff, herd mode, folding economics, and
budgeted scopes.
