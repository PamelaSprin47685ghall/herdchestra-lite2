---
name: station-refactor-status
description: Status of the HerdchestraLite2 station refactor: what is committed, what is verified in the worktree, and what remains uncommitted because it is mixed with user-owned work.
---

# Station Refactor — Status

## Goal

Make every feature port the only production path: each port is either consumed by
production and can be switched off with a defined behavior, or it is deleted. At
the same time enforce the Ticket Station Method: the Station is a rich
synchronous aggregate, Tickets own the awaits, and Wiring only composes.

## What is now true

- **Feature ablation.** `folding`, `clock`, and `relay` are resolved through
  `buildPorts(env)` and injected as implementation objects. The dead `scope`
  port and `HERD_SCOPE` are deleted. `nullTickets` is gone:
  `createStationRegistry` requires a ticket capability and throws
  `MISSING_TICKETS`. `pin`/`amend`/`herd` are built once and bound per station.
  Folding, clock, and relay have ablation tests; scope and the test-only feature
  modules are deleted.
- **Station.** The duplicate `directAmend` is gone; fire-and-forget dispatches
  go through a catch-all; `policy()` is a pure query. Context projection,
  tool-call routing, fork/join admission, and handoff/retirement decisions live
  in pure `src/station/domain/*` modules with ratchets. The processed/dispatch/
  tool-gate tables moved into `src/station/domain/tool-call-ledger.mjs`. The
  Station class receives host capabilities through `registry.host()`; ESLint
  forbids station→host imports except the registry composition bridge.
- **Wiring.** `spawnChildTicket` lives in
  `src/tools/fork-spawn-ticket.mjs`; `fork-wiring.mjs` composes it. Fork attach
  is split into `attachBaseForkPorts` (ledger/wait/identity/owner/depth/
  persistence) and `bindHostForkPorts` (display/spawn/prepareChild/session),
  with a two-phase idempotence guard. The display holder lives in
  `src/host/child-display-holder.mjs`. Child identity and fork-ledger resolution
  are pure functions (`src/host/fork-identity.mjs`); `station.bindForkPorts`
  derives owner, depth, and persistence from plain inputs.

## Verification (worktree, 2026-11-22)

- `bun test tests`: **973 pass / 0 fail**, 86 files, 3582 expect calls.
- `bunx eslint .`: **0**.
- `bun run smoke:relay`: **11/11**.
- `git diff --check`: **0**.
- Station host imports: only `src/station/registry.mjs` (the allowed composition
  bridge). ESLint allowlist: only that file.

## Commits

- `4908b33` Make folding and clock real ports; harden station hygiene
- `c28e630` Retire the dead scope switch; make relay and session ports real
- `35d2042` Extract context projection and spawn ticket into pure modules
- `179b5b3` Make tool-call routing a pure decision; split fork attachment
- `b03b21a` Make fork/join admission and join obligations pure decisions
- `0f2a3a7` Make handoff and retirement decisions pure
- `418250f` Make child identity and fork-ledger resolution pure
- This status commit: pure policy/prompt rules moved to core; host capability
  bag documented; status recorded.

## Residuals (uncommitted, worktree green)

The following files are implemented and verified but cannot be committed alone
because they are mixed with the user's uncommitted targets/join work. Do not
revert or commit the user's lines.

- `src/station/station.mjs` — our host/ledger/`bindForkPorts` lines are mixed with
  the user's `recordElderReport` / `settleInterruptedJoin` / `elderUnneeded`
  block.
- `src/host/fork-wiring.mjs` — our builder/resolver/`bindForkPorts` lines are
  mixed with the user's targets/permission edit (hunk `6b`).
- `src/station/fork-controls.mjs` — our `processedOf` line is mixed with the
  user's targets/join hunk; hunk 19 has a review warning because it edits
  pre-existing uncommitted lines.
- `src/host/fork-registry.mjs` — user targets hunk.
- `tests/join-obligation.test.mjs` — user join tests; only two lines are ours.
- The host-free ESLint rule, `tests/architecture/station-host-free.test.mjs`, and
  the station.host-dependent files (`gates`, `handoff-state`, `models`,
  `restore`, `execute`, related tests) depend on the mixed `station.mjs` and
  stay with it.

Remaining structural work:

- `fork` register/return/ready/abandon decisions still live in
  `fork-controls.mjs` handlers.
- The combined `attachForkPorts` remains for tests/direct callers.
- `activation` still has `attachStation` session routing.
- `src/station/registry.mjs` is the one intentionally allowed station→host
  bridge.

## Next steps

1. User commits or approves the targets/join work.
2. Commit `station.mjs` with only our units (drop the user's
   `recordElderReport`/`settleInterruptedJoin`/`elderUnneeded` units), then the
   host-free files and tests, then `fork-wiring.mjs` without the user's targets
   line.
3. Optionally finish the fork handlers and the activation thinning.
4. Re-run full acceptance after each mixed-file commit.
