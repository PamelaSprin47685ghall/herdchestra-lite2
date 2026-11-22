---
name: station-refactor-status
description: Status of the HerdchestraLite2 station refactor: every feature port is the only production path and the station method is enforced; code through ffaf49a is committed, while the worktree also carries user-owned prompt and free-URI changes.
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
  go through a catch-all; `policy()` is a memoized query (it caches `this.agentPolicy`) that never
  dispatches a ticket. Context projection,
  tool-call routing, fork/join admission, fork register/return/ready/abandon,
  and handoff/retirement decisions live in pure `src/station/domain/*` modules
  with ratchets. The processed/dispatch/tool-gate tables moved into
  `src/station/domain/tool-call-ledger.mjs`. The Station class receives host
  capabilities through `registry.host()`; ESLint forbids station→host imports
  except the registry composition bridge. `fork-controls` handlers stay
  synchronous station code: `handleForkCall` admits, registers, renders, and
  starts spawners in one atomic Run-to-Completion block, never awaiting; the
  ratchet baseline is 20 and `admitForkStart` is gone.
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
  reads no implementation name, and has no per-call fallback. Twenty-five
  test call sites go through `tests/helpers/station-ports.mjs`; two tests
  construct `SessionStation` directly for refusal paths
  (`tests/port-wiring.test.mjs:107`, `tests/station-purity.test.mjs:212`).
- **One port table.** `createStationRegistry` freezes the resolved name table
  once and `ports()` returns that reference. `SessionStation` validates every
  port name in its constructor and captures `this.portTable`; gates, model
  switching, and context projection read it, so no event re-reads the table or
  falls back to `{}`. A station without a complete table throws
  `MISSING_PORTS`. The registry still accepts a partial table for name-only
  doubles; a station cannot start on one. The ratchet walks every `.mjs`
  under `src/station`, `src/host`, and `src/activation` with a
  receiver-agnostic detector (`\.\s*ports\s*(?:\?\.)?\s*\(`), so
  `registry.ports(`, `registry?.ports?.(`, `station["registry"].ports()`, and
  `wired.ports()` all match. Exactly two composition-time reads are allowed:
  the constructor's anchored `const portTable = registry?.ports?.();` in
  `station.mjs` and the wire-time `registry?.ports?.().observer` check in
  `provider-observer.mjs`. Its detector self-test pins the pre-ratchet regex
  as blind to `registry?.ports?.(` and the identifier-anchored regex as blind
  to the bracket spelling, so the guard cannot return to fake-green.
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
- **Relay single truth.** `handoff-state` reads `station.relayPort()` only and
  never `station.registry`; relay pending bookkeeping goes through
  `SessionStation.markPending()`/`clearPending()`. The registry name table is
  no longer a second source.
- **Ratchets.** No bare `this.tickets.*(` statement; no `void`/discarded
  `*Ticket(` call in `src/activation` or `src/host`; no ticket writes
  `lastError`; no station imports host except the registry bridge.
- **Tool-call double entry is intentional and closed.** The host `tool_call`
  hook and the dispatch admission are two seams for one call; `onToolCall`
  caches its verdict by tool-call id, so the second seam is a cache read, never
  a second charge. Independently of that cache, `chargeBranch` refuses an id
  already present in `state.charges`, so a re-admission cannot double-charge
  even after the 512-entry gate cache evicts it. The post-execution receipt
  seam checks the same gate cache and re-admits when the id is absent instead
  of returning a free result; with no prior admission and no budget, that
  fresh admission refuses the result. The regression is
  `tests/fork-tool-deadline.test.mjs` "a receipt without an admission is
  refused, not free".
- **Receipt re-admission is idempotent for an executed call.** A receipt that
  follows a guarded execution cannot be refused by the re-admission it falls
  back to when the bounded 512-entry gate cache evicted the id: `chargeBranch`
  short-circuits on `state.charges[toolCallId]`, so the call is neither
  billed twice nor refused for a budget it already passed; control and amend
  replay is gated by the processed ledger (`processAssistantMessage` marks the
  message key, `directAmend` returns `handledFor`); and a free call's
  arguments are rebuilt from the carrying message via the dispatch tracker, so
  a skill read stays free. `tests/fork-tool-deadline.test.mjs` now pins both
  cases — evicted verdict (no block, one charge, three remaining) and free
  skill read after eviction (no block, no charge) — and runs 14 cases.
  Pin commit: `6cb59213`.

## Compliance pass (generation 5, 2026-11-22)

- **Port-table reads are guarded across the extension.** The ratchet scans
  `src/station`, `src/host`, and `src/activation` with the receiver-agnostic
  detector `\.\s*ports\s*(?:\?\.)?\s*\(`; exactly two composition-time reads
  are allowed: the constructor in `src/station/station.mjs` and the wire-time
  observer in `src/host/provider-observer.mjs`. The extension entry no longer
  substitutes `{}` for a missing table (`wired.ports` is passed through);
  `wireExtension` already throws when a port set is missing.
- **Relay bookkeeping stays behind the station.** `handoff-state` no longer
  reads `station.registry`; `armHandoff`/`commitSelfHandoff` call
  `station.markPending()`/`clearPending()`. Those synchronous methods own the
  registry bridge; the production registry implements both
  (`src/station/registry.mjs:213-218`), and station doubles may omit them.
- **One policy gate for `todo`.** `onBeforeAgentStart` no longer repeats the
  `READ_WRITE_SUBAGENT` check before `station.ensureTools(ctx)`;
  `ensureTools`/`syncTodo` owns that rule.
- **Doubles carry the contract.** `tests/child-relay-isolation.test.mjs`,
  `tests/ablation/relay-strategy.test.mjs`, `tests/relay-prompts.test.mjs`, and
  `tests/silent-sites.test.mjs` gained `markPending`/`clearPending` so the
  handoff paths exercise the new station methods.
- Code commit: `ffaf49a`.

## Verification (2026-11-22, generation 5)

- `bun test tests` on the worktree: **1094 pass / 0 fail**, 97 files, 4044
  expect calls. The worktree also carries 12 user/concurrent uncommitted files
  (listed under Open items), so this is not a clean-tree number.
- The previous committed HEAD `ec4951b` measured **1093 pass / 0 fail**, 97
  files, 4036 expect calls.
- Clean committed-tree replay at `6cb59213` (`git archive`): **1081 pass / 0
  fail**, 96 files, 3937 expect calls. It excludes the user's uncommitted
  prompt files.
- `bunx eslint .`: **0** with no output.
- `bun run smoke:relay`: **11/11**.
- `git diff --check` on the generation-5 files: clean.
- Station construction: 25 `createTestStation(` call sites; `new
  SessionStation` has 4 sites — production `src/station/registry.mjs:180,190`,
  test `tests/port-wiring.test.mjs:107`, and test
  `tests/station-purity.test.mjs:212`. The two test sites construct directly;
  the other test call sites use the helper.
- Earlier verification, kept for history: 1083 worktree and 1077 replay at
  `29c583e`; 1078 at `e61bb71`; 1079 at `4f7b1af`; 1081 at `6cb59213`. The
  differences are the guard and receipt pins, plus the user's
  `tests/prompts.test.mjs`.
- No `forkPortsPhase`, `baseStates`, or `hostStates` remains.

## Open items

- `readWiring` still turns a missing `ports` object into `{}`; a station then
  throws `MISSING_PORTS` in `SessionStation`'s constructor before any event
  runs. This is error latency at station start, not an end-to-end silent
  fallback; tightening the registry would only move the same throw earlier.
- `fork-wiring` keeps a lazy `states` WeakMap for a plain wiring object that
  never came from `createForkWiring`; it is lifecycle memoization for test
  doubles, not station state.
- `noteScopedModelFailure` keeps the message but drops the
  `expectedKey`/`actualKey` diagnostic fields.
- The port-table ratchet is a raw-source scan: it matches call syntax, not a
  method extracted and called later (`const read = registry.ports; read()`),
  and a comment or string containing `.ports(` would trip it. A new
  composition-time read must be added to the exact whitelist with a reason.
- `SessionStation.markPending`/`clearPending` keep an optional chain for
  station doubles whose registry omits the methods; the production registry
  implements both (`src/station/registry.mjs:213-218`).
- Stale-comment cleanup (W11) has not been swept across every file; the
  ratchet's scan boundary is `src/station`, `src/host`, and `src/activation`.
- User-owned uncommitted prompt copy: `CHANGELOG.md`, `README.md`,
  `resources/prompts/errors.md`, `resources/prompts/system.md`,
  `resources/prompts/tools/fork-join.md`,
  `resources/prompts/tools/panhandle.md`, `tests/prompts.test.mjs`.
- Concurrent uncommitted free-URI behavior work, not authored by this line:
  `src/scope/accounting.mjs`, `src/scope/budget.mjs`, `src/scope/index.mjs`,
  `tests/branch-charge.test.mjs`, and untracked `tests/free-uri.test.mjs`.
  This is behavior, not copy; the full-suite number above includes it.

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
- `e61bb71` Re-admit a receipt that has no gate verdict; record the clean-tree
  receipt.
- `4f7b1af` Scan all of `src/station` for port-table reads; pin the pre-ratchet
  regex's blind spot so the guard cannot silently regress.
- `6cb59213` Pin receipt idempotence across a gate-cache miss: an executed call
  is re-admitted, charged once, and never refused by the fallback admission.
- `5997b64` docs: record the station-wide port-table ratchet
- `ec4951b` docs: record the receipt re-admission invariant
- `ffaf49a` Close the last port-table and registry escapes: drop the
  unreachable `wired.ports ?? {}` fallback, route relay pending bookkeeping
  through `SessionStation.markPending`/`clearPending`, let `ensureTools` own
  the read-write gate, and widen the port-table ratchet to host and
  activation.
- This STATUS commit (HEAD): record generation-5 station compliance.

## Final state

- No structural Phase 4–7 items remain.
- `src/station/registry.mjs` is the one intentional station→host bridge.
- The combined `attachForkPorts` exists only in `tests/helpers/fork-attach.mjs`.
- Ablation tests cover folding, clock, and relay; the dead `scope` port and the
  test-only feature modules are gone.
- The port-table fix is `130a5af`: the registry returns one frozen name table,
  `SessionStation` validates and captures `this.portTable`, and gates/model
  switching consume it; a missing table throws `MISSING_PORTS`. The guard is
  generation-5 `ffaf49a`: the ratchet scans `src/station`, `src/host`, and
  `src/activation` with a receiver-agnostic call detector and allows exactly
  two composition-time reads — the constructor capture in `station.mjs` and
  the wire-time observer check in `provider-observer.mjs`. Its self-test pins
  both the old regex's optional-call blind spot and the identifier-anchored
  regex's bracket blind spot.
- The receipt-admission fix is `e61bb71`: a post-execution receipt with no
  gate verdict re-enters admission instead of returning a free result, and
  `chargeBranch` keeps re-admission idempotent through `state.charges`.
- Clean committed-tree replay at `e61bb71`: **1078 pass / 0 fail**, 96 files,
  3922 expect calls. `bunx eslint .` 0; `bun run smoke:relay` 11/11 on the
  worktree carrying the fix. The replay excludes the uncommitted user files,
  so committed HEAD is green on its own.
- The generation-5 compliance commit is `ffaf49a`: no `wired.ports ?? {}`
  fallback, `handoff-state` never reads `station.registry` (relay bookkeeping
  goes through `SessionStation.markPending`/`clearPending`), and
  `onBeforeAgentStart` has no second read-write gate.
- The working tree carries 12 uncommitted user/concurrent items: seven
  prompt-copy files (`CHANGELOG.md`, `README.md`,
  `resources/prompts/errors.md`, `resources/prompts/system.md`,
  `resources/prompts/tools/fork-join.md`,
  `resources/prompts/tools/panhandle.md`, `tests/prompts.test.mjs`) and five
  free-URI behavior files (`src/scope/accounting.mjs`, `src/scope/budget.mjs`,
  `src/scope/index.mjs`, `tests/branch-charge.test.mjs`, and untracked
  `tests/free-uri.test.mjs`). No enforcement code depends on them.
