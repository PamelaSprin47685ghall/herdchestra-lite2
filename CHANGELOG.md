# Changelog

All notable changes to this extension. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
