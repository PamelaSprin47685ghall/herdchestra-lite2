# Changelog

All notable changes to this extension. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.3.0] — 2026-11-19

## [Unreleased]

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
  batch is validated atomically before any flow starts. `"ro"` now blocks
  `edit`, `write`, `bash`, and `ast_edit` inside that flow. A fission begin
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

This release numbers the workflow work accumulated since 2.1.0 as a minor
release rather than a patch: the diagnostics ring, delta state persistence, the
host seam self-check, the silent-failure fixes, and now the cross-stage
discipline in the Stage Prompts block arrive together. The 2.1.1–2.1.6 entries
below record the individual steps that led here and stay as history; this
section records what this release itself changes.

### Changed

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
