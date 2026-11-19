# Changelog

All notable changes to this extension. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
