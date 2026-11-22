---
name: station-refactor-status
description: Final status of the HerdchestraLite2 station refactor: every feature port is the only production path, the station method is enforced, and the whole worktree landed as one verified commit.
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
  tool-call routing, fork/join admission, fork register/return/ready/abandon,
  and handoff/retirement decisions live in pure `src/station/domain/*` modules
  with ratchets. The processed/dispatch/tool-gate tables moved into
  `src/station/domain/tool-call-ledger.mjs`. The Station class receives host
  capabilities through `registry.host()`; ESLint forbids station→host imports
  except the registry composition bridge. `fork-controls` handlers only
  take/commit/persist; the ratchet baseline is 20 and `admitForkStart` is gone.
- **Wiring.** `spawnChildTicket` lives in
  `src/tools/fork-spawn-ticket.mjs`; `fork-wiring.mjs` composes it. Fork attach
  is split into `attachBaseForkPorts` (ledger/wait/identity/owner/depth/
  persistence) and `bindHostForkPorts` (display/spawn/prepareChild/session),
  with a two-phase idempotence guard. The display holder lives in
  `src/host/child-display-holder.mjs`. Child identity and fork-ledger resolution
  are pure functions (`src/host/fork-identity.mjs`); `station.bindForkPorts`
  derives owner, depth, and persistence from plain inputs. `activation.attachStation`
  is mechanical through `src/host/activation-binding.mjs`, and the combined
  `attachForkPorts` exists only in `tests/helpers/fork-attach.mjs`.

## Verification (2026-11-22, worktree and pre-commit candidate)

- `bun test tests`: **988 pass / 0 fail**, 87 files, 3628 expect calls.
- `bunx eslint .`: **0**.
- `bun run smoke:relay`: **11/11**.
- `git diff --check`: **0**.
- The exact commit patch was applied first to a pristine `git archive HEAD`
  tree; the full suite and smoke test passed there too, proving the commit is
  green in isolation rather than only on top of the dirty worktree.
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
- `3f8c4bb` Pure policy/prompt rules moved to core; host capability bag
  documented; status recorded.
- `366d8a0` Phase 7 status record: fork handlers pure, activation attach
  mechanical, combined `attachForkPorts` test-only.
- Phase 8 (this commit): all Phase 1–7 code plus the in-flight fork-targets and
  interruptible `scope_join` work. The two streams import each other
  (`src/scope/targets.mjs` is used by `fork-controls`, `domain/fork-join`,
  `fork-registry`, and transcript replay), so they land together; committing
  only the refactor lines produced a syntax-broken `fork-controls.mjs` and a red
  HEAD.

## Final state

- No structural Phase 4–7 items remain.
- `src/station/registry.mjs` is the one intentional station→host bridge.
- The combined `attachForkPorts` exists only in `tests/helpers/fork-attach.mjs`.
- Ablation tests cover folding, clock, and relay; the dead `scope` port and the
  test-only feature modules are gone.
- The working tree is clean and HEAD is the verified full refactor.
