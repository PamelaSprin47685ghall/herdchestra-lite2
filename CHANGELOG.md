# Changelog

All notable changes to this extension. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.3.0] — 2026-11-19

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
