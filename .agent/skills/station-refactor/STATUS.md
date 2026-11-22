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

## Enforcement pass (2026-11-22)

Closed the defects the two audits found; every fix has a behavioral test or a
ratchet.

- **Station dispatch order and failure routing.** `deliverSteer` /
  `deliverUserMessage` go through `dispatchFireAndForget("tickets", …)`, so a
  rejected or synchronously thrown ticket is recorded, never an unhandled
  rejection. Ticket-side model failures report through
  `station.noteScopedModelFailure`; no ticket writes `lastError`. `gates.mjs`
  commits model/switch/receipt state before it tail-dispatches `ensureTools`
  and `restoreScopedModel`. `fork-controls.mjs` registers the whole batch
  before it starts any spawner, so a throwing spawner cannot swallow a later
  fork.
- **One station composition root.** `buildPorts` freezes names and a complete
  implementation bundle; `createStationRegistry` requires it and throws
  `MISSING_PORTS` (missing keys named) and still refuses the legacy flat table.
  `SessionStation` stores `this.ports` once; it imports no feature factory,
  reads no implementation name, and has no per-call fallback. All test
  construction goes through `tests/helpers/station-ports.mjs`.
- **One port table.** `createStationRegistry` freezes the resolved name table
  once and `ports()` returns that reference. `SessionStation` validates every
  port name in its constructor and captures `this.portTable`; gates, model
  switching, and context projection read it, so no event re-reads the table or
  falls back to `{}`. A station without a complete table throws
  `MISSING_PORTS`. The registry still accepts a partial table for name-only
  doubles; a station cannot start on one. The ratchet scans only the event
  modules (`gates`, `models`) and matches `registry.ports(`,
  `registry?.ports(`, and `registry?.ports?.(`; it self-tests the detector and
  asserts the constructor's one legitimate read stays in `station.mjs`.
  `fork-wiring` keeps a lazy `states` WeakMap for a plain wiring object that
  never came from `createForkWiring` — a documented compatibility path for test
  doubles, not station state.
- **Mechanical wiring.** Ledger precedence is the pure
  `src/station/domain/fork-ledger.mjs`; the owner/display choice is the pure
  `src/host/domain/binding.mjs`. `createForkWiring()` owns the per-station
  lifecycle on `wiring.states`; both module-level WeakMaps and the plain-double
  monkey patch are gone, and the station no longer carries `forkPortsPhase`.
- **Activation.** A refused port throws `PORT_UNAVAILABLE` instead of running on
  an empty table; a failing `wiring.onStation` is recorded like the base attach;
  activation ticket calls detach with a catch-all; `implementations()` returns
  one frozen reference. `registry.setPorts` (no caller, stale-port footgun) is
  deleted.
- **Relay single truth.** `handoff-state` reads `station.relayPort()` only; the
  registry name table is no longer a second source.
- **Ratchets.** No bare `this.tickets.*(` statement; no `void`/discarded
  `*Ticket(` call in `src/activation` or `src/host`; no ticket writes
  `lastError`; no station imports host except the registry bridge.
- **Tool-call double entry is intentional.** The host `tool_call` hook and the
  dispatch admission are two seams for one call; `onToolCall` caches its verdict
  by tool-call id, so the second seam is a cache read, never a second charge
  (`station.mjs`, `admitToolDispatch` comment).

## Verification (this pass, 2026-11-22)

- `bun test tests`: **1081 pass / 0 fail**, 96 files, 3930 expect calls.
- `bunx eslint .`: **0**.
- `bun run smoke:relay`: **11/11**.
- Station construction sites: 24, all through the production `buildPorts`
  helper. No `forkPortsPhase`, `baseStates`, or `hostStates` remains.

## Open items

- `resources/prompts/errors.md`, `resources/prompts/system.md`,
  `resources/prompts/tools/fork-join.md`, `resources/prompts/tools/panhandle.md`,
  `tests/prompts.test.mjs`, and the matching `CHANGELOG.md` hunk are a coherent
  free-fork prompt-copy change that no enforcement slice authored. They stay
  uncommitted and unowned until their author claims them; the code above does
  not depend on them.

## Historical verification (2026-11-22, Phases 1–7 landing)

- `bun test tests`: **988 pass / 0 fail**, 87 files, 3628 expect calls.
- `bunx eslint .`: **0**.
- `bun run smoke:relay`: **11/11**.
- `git diff --check`: **0**; `git status --porcelain`: empty.
- Verified in a pristine `git archive` copy of committed HEAD, so the numbers
  do not depend on the dirty worktree.
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
- `35bfc39` Land the station refactor with feature ablation and the station
  method. Contains all Phase 1–7 code plus the in-flight fork-targets and
  interruptible `scope_join` work. The two streams import each other
  (`src/scope/targets.mjs` is used by `fork-controls`, `domain/fork-join`,
  `fork-registry`, and transcript replay), so they land together; committing
  only the refactor lines produced a syntax-broken `fork-controls.mjs` and a red
  HEAD.
- `6b19821` Enforce the ticket station method end to end (dispatch tails,
  single composition root, mechanical wiring, relay single truth).
- `130a5af` Read the station port table once: frozen registry reference,
  constructor fail-fast, gates/models/context consume `station.portTable`.

## Final state

- No structural Phase 4–7 items remain.
- `src/station/registry.mjs` is the one intentional station→host bridge.
- The combined `attachForkPorts` exists only in `tests/helpers/fork-attach.mjs`.
- Ablation tests cover folding, clock, and relay; the dead `scope` port and the
  test-only feature modules are gone.
- The port-table fix is `130a5af`: the registry returns one frozen name table,
  `SessionStation` validates and captures `this.portTable`, and gates/model
  switching consume it; a missing table throws `MISSING_PORTS`. The guard-test
  correction lands with this status file: the ratchet scans only event modules,
  matches `registry.ports(`, `registry?.ports(`, and `registry?.ports?.(`, and
  self-tests the detector; the constructor's one legitimate read is asserted
  present in `station.mjs`.
- Working-tree verification at that state: **1081 pass / 0 fail**, 96 files,
  3930 expect calls; `bunx eslint .` 0; `bun run smoke:relay` 11/11.
- The working tree carries six uncommitted free-fork prompt files owned by the
  user (`CHANGELOG.md`, `resources/prompts/errors.md`,
  `resources/prompts/system.md`, `resources/prompts/tools/fork-join.md`,
  `resources/prompts/tools/panhandle.md`, `tests/prompts.test.mjs`); no
  enforcement code depends on them.
