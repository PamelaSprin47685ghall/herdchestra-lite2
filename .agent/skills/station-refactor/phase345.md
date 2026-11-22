# Phase 3/4/5 — decision-ready plan

Read-only design. Source of truth is the current worktree. Line numbers are anchors,
not contracts; re-read before editing. The goal is target A: every remaining port
is either a production path that can be ablated, or deleted; Station is rich, Ticket
thin, Wiring mechanical.

## 1. Remaining ports — disposition

| Port | Production consumer today | User-facing status | Decision | Files / tests |
|---|---|---|---|---|
| `scope` (`bare`/`batch`) | none | README line 17: “The three tools exist in every supported configuration… a configuration that cannot support fork/join refuses the call.” `bare` says fork/join does not exist; contradiction | **Delete the port and the `HERD_SCOPE` switch.** Keep the three tools always. If `bare` is a real product requirement, implement it as “tools not registered + calls refuse `PORT_UNAVAILABLE`” and change the README; do not leave a dead switch. Recommended: delete. | `src/core/ports/registry.mjs` (PORTS/NAMED_SWITCHES), `src/core/ports/resolve.mjs`, `README.md`, `tests/ports-resolve.test.mjs`, `tests/refactor-guards.test.mjs` |
| `relay` (`none`/`ledger`/`handoff`) | string checks in `src/station/handoff-state.mjs:30,46,78,118,136` and `src/station/station.mjs:350` | real behavior: ledger/handoff protocol | **Wire as a policy object**, not a string. `none` no-ops and never arms; `ledger` evaluates/retires but never arms; `handoff` does all. Replace all string checks with `this.relayPort().evaluate/retire/arm/advance/status`. | new `src/relay/policy.mjs` (or extend `src/relay/index.mjs`), `src/station/handoff-state.mjs`, `src/activation/ports.mjs`, station call site (single writer), `tests/relay.test.mjs`, `tests/relay-port.test.mjs`, `tests/forkjoin-contract.test.mjs` |
| `status` (`on`/`off`) | `src/host/status.mjs:401` installs the real runtime | name gate is load-bearing | **Keep the name gate; delete the test-only `src/features/status` module.** The production formatter is the host runtime; the feature module is a parallel model. If the line formatter is worth keeping, extract it to `src/host/status-format.mjs` and call it from the runtime; otherwise delete. Recommended: delete feature module. | `src/features/status/**`, `tests/contract/status-observer.test.mjs` (split), `src/host/status.mjs` read-only |
| `observer` (`on`/`off`) | `src/host/provider-observer.mjs:296` writes the station | name gate is load-bearing | **Keep the name gate; delete the test-only `src/features/observer` module**, or wire its record store into `wireProviderObservation` if the store is the intended runtime. Recommended: delete feature module. | `src/features/observer/**`, `tests/contract/status-observer.test.mjs` (split), `src/host/provider-observer.mjs` read-only |
| `modelSwitch` (`on`/`off`) | `src/station/models.mjs:69,85` queues/takes a pending switch | name gate is load-bearing | **Keep the name gate; delete the test-only `src/features/model-switch` module**, or redesign it as the pending-switch policy and use it from `models.mjs`. Recommended: delete feature module. | `src/features/model-switch/**`, `tests/contract/folding-model-switch.test.mjs` (modelSwitch half), `src/station/models.mjs` read-only |
| `pin`/`amend`/`herd` | `station.pinPort/amendPort/herdPort` construct per call | load-bearing | **Keep, but move construction into `buildPorts`** once per station, state-bound. `station.*Port()` returns `registry.implementations().pin/amend/herd`; remove per-call `createPinOn/Off`. | `src/activation/ports.mjs`, `src/station/station.mjs`, `src/activation/index.mjs`, `tests/port-wiring.test.mjs` |
| `chineseReminder`/`vibeCompat` | option gates in host/prompts and transcript | load-bearing | **Keep as names**; no feature module. No change. | none |
| `folding`/`clock` | Phase 2 objects | load-bearing | **Closeout only**: one `buildPorts` per station; pass the resolved clock to `skillReceiptText`/`amendText`/`child-display`; add one composition-root ablation per port. | `src/activation/ports.mjs`, `src/activation/index.mjs`, `src/station/station.mjs`, `src/station/controls.mjs`, `src/host/child-display.mjs`, `tests/helpers/composition.mjs` |

Rule for every port: either the production path calls the implementation object, or
the switch is deleted. A test-only parallel model behind a live switch is the defect
this phase removes.

## 2. `nullTickets` — fail fast

Current:

- `src/station/registry.mjs:27` defines `nullTickets` (`steer`/`prompt` no-op,
  `activateTools` returns `undefined`).
- `src/station/registry.mjs:64` `createStationRegistry(pi, tickets = nullTickets, …)`.
- `src/activation/index.mjs:134` is the only production registry call and already
  passes `buildTickets(pi)`.

Decision: **remove the default and the silent no-op.**

1. `createStationRegistry(pi, tickets, pricingCatalog, ports = {})` requires
   `tickets`; if it is missing or lacks `activateTools`/`steer`/`prompt`, throw
   `MISSING_TICKETS` with the registry construction site in the message.
2. Delete `nullTickets`. No throwing proxy is needed at the call site because the
   registry refuses before a station exists.
3. Update every direct `new SessionStation(...)` test to pass a recording double
   (`tests/helpers/tickets.mjs`) instead of `undefined`/`nullTickets`. The double
   should expose `activateTools`, `steer`, `prompt`, `join`, `return` as spies.
4. Audit `this.tickets.*` in `src/station/station.mjs`, `src/station/fork-controls.mjs`,
   and `src/tools/tickets.mjs`; every call has a real capability or a test double.
5. Acceptance: `createStationRegistry(pi, undefined, catalog, {})` throws
   `MISSING_TICKETS`; a station with a rejecting ticket records the error
   (`tests/station-purity.test.mjs` already covers the rejection).

## 3. Phase 4 — Station enrichment

Target shape: Station is a rich aggregate. Domain modules are pure decision functions
over plain snapshots; the Station method does `Compute → Commit → Dispatch` and is the
only writer. No domain module takes `station` or mutates `this.state`.

### 3.1 Slices

| Slice | New domain module | Station method / gatekeeper | Tests | Ratchet |
|---|---|---|---|---|
| 4a context (first) | `src/station/domain/context.mjs`: `projectContext({ messages, receipts, amends, folding })` → `{ messages, collapsed, rebase, usage }` | `transformContext`: compute projection, then commit `settleReceiptFolds`, `maybeRebase`, `usage.noteSentContext`; no dispatch | `tests/station-context-domain.test.mjs`, existing receipt/fold/transcript tests | forwarder count −1; no `this.state` write in domain |
| 4b tool_call | `src/station/domain/tool-call.mjs`: `decideToolCall({ state, processed, dispatch, call, policy, relay })` → `{ verdict, controls, todo, charge, persist, block }` | `onToolCall` translates the host event, calls decide, commits `processed`/`dispatch`/charges, returns the block verdict; `admitToolDispatch` becomes the only entry or dedupes by `toolCallId` | `tests/tool-gate.test.mjs`, `tests/control-tools.test.mjs`, `tests/fork-tool-deadline.test.mjs` | one free function removed from `gates.mjs`; no dispatch inside a query |
| 4c fork/join | `src/station/domain/fork-join.mjs`: `decideRegister`, `decideJoin`, `decideReturn`, `decideReady`, `decideAbandon`; input `{ ledger, receipts, identity }`, output `{ next, effects }` | `fork-controls` methods call the decision, then commit the ledger/receipts; start with register/join/return, then ready/reparent | `tests/forkjoin-contract.test.mjs`, `tests/join-obligation.test.mjs`, `tests/forkjoin-recovery.test.mjs`, `tests/fork-blocking.test.mjs` | one free function removed from `fork-controls.mjs`; no `Object.create(station)` |
| 4d relay/handoff | `src/station/domain/relay.mjs` shared with the Phase 3 relay policy; `decideRelay(state, phases, op, options)` → `{ relay, action, stats }` | `handoff-state` calls the policy, commits `state.relay`; station `relayOn` reads the policy | `tests/relay.test.mjs`, `tests/handoff-state.test.mjs`, `tests/forkjoin-contract.test.mjs` | one string check removed; no state write in policy |

### 3.2 Snapshot and commit rules

- Snapshot: plain data only — `{ brackets, order, queues, levels, receipts, usage,
  relay }`. No `station`, no closures, no `Object.create`.
- Decision: pure, synchronous, deterministic; returns a patch or a discriminated
  union (`{ kind: "block" | "allow" | "join" | "return" | "stale", … }`).
- Commit: the Station applies the patch in one Run-to-Completion block, then, at the
  tail only, dispatches a ticket. A query method never dispatches.
- Cross-async: the ticket carries an `epoch`; the Station’s commit method returns
  `{ kind: "stale" }` if the epoch moved. This is the existing epoch pattern; do not
  invent a second one.

### 3.3 Ratchet

`tests/architecture/station-ratchet.test.mjs` counts and snapshots:

- `src/station/station.mjs` methods whose body is one `return freeFunction(this, …)`.
- free functions in `src/station/{execute,gates,fork-controls,handoff-state}.mjs`
  whose first parameter is `station` or that assign `station.*`.
- `src/station/station.mjs` imports from `src/host/**` (currently 6).
- bare `void this.tickets.` (currently 0 after Phase 1).

Store the baseline as an explicit allowlist `{ file, function }`. The test fails on
any new entry and on any count increase. Each Phase 4 slice removes one entry or
keeps the count flat; the final target is zero host imports and zero station-mutating
free functions outside `station/domain`.

### 3.4 Ownership

One **station integrator** owns `src/station/station.mjs` for all of Phase 4. Workers
own their domain module and tests:

- 4a: `domain/context.mjs`, `tests/station-context-domain.test.mjs`.
- 4b: `domain/tool-call.mjs`, `gates.mjs` (after interface), tool tests.
- 4c: `domain/fork-join.mjs`, `fork-controls.mjs` (after interface), fork tests.
- 4d: `domain/relay.mjs`, `handoff-state.mjs`, relay tests.

`gates.mjs`, `execute.mjs`, `fork-controls.mjs`, `handoff-state.mjs` are separate
files; only the owning slice edits each. `station.mjs` is submitted as exact snippets
to the integrator, never edited by two workers.

## 4. Phase 5 — wiring thinning

### 4a move the spawn ticket

- Move `MAX_RETURN_NUDGES`, `writeFrozenOutcome`, and `spawnChildTicket` (111–287)
  verbatim from `src/host/fork-wiring.mjs` to new `src/tools/fork-spawn-ticket.mjs`.
- Move imports: `randomUUID`, `bindAgent`, `forkOf`, `outcomeOf`, `pulse`,
  `setOutcome`, `renderChildRecord`, `record`, `publicScopeId`, `scopeTitle`,
  `childReturnNudge`, `stopAfterScopeReturn`.
- `fork-wiring.mjs` imports it; keep the outer `.catch` at the spawn call site.
- Update `tests/fork-wiring.test.mjs:4-6`; no re-export shim. `fork-spawn-chain`
  goes through the branch session and should not need a path change.
- Why not `tickets.mjs`: it is already 521 lines; a sibling under `src/tools/`
  preserves “ticket owns awaits” and keeps the move reviewable.

### 4b split attach + display holder

- `attachForkPorts` is called twice: `registry.attachStationPorts` then
  `activation.attachStation` via `onStation`. Make it explicit two-phase:
  - `attachBaseForkPorts(station, wiring, options)`: ledger selection, wait,
    identity, `forkOwnerId`/`forkDepthPort`, base capabilities.
  - `bindHostForkPorts(station, wiring, options)`: display, spawn, `prepareChild`,
    `createSession`.
- `registry.attachStationPorts` calls only base; `activation.attachStation` calls
  only host. Add a `forkPortsPhase` marker or an idempotent guard; never re-run
  ledger selection.
- Move the display holder (`createDisplayHolder`, `resolveDisplay`,
  `attachPendingDisplay`, `flushPendingDisplay`, subscription) to
  `src/host/child-display-holder.mjs` (or extend `child-display.mjs`). Wiring passes
  the holder; it does not own the pending map.
- Tests: `tests/fork-wiring.test.mjs`, `tests/ui-init.test.mjs`,
  `tests/forkjoin-recovery.test.mjs`, `tests/port-wiring.test.mjs`.

### 4c station binding + identity helper

- New `src/host/fork-identity.mjs`: `buildChildIdentity(spec, { agentId, ledger,
  persistRoot, display })` pure; `resolveForkLedger({ identity, indexed, restored })`
  pure precedence function.
- Station computes `ownerId`/`forkDepthPort` once in `bindForkPorts(ports)`; wiring
  supplies only `identity` and `ledger`. Remove `station.ownerId` writes.
- Persist becomes a capability `persistRoot` on the identity; the Station calls it;
  wiring does not branch on `identity.persistRoot` vs `station.persist`.
- Tests: `fork-wiring`, `forkjoin-recovery`, `join-obligation`.

### 4d handoff router (optional, after 5c)

- Move `pendingStation`/`sameManager` routing from `station/registry.mjs` to
  `src/host/handoff-router.mjs`; tests `forkjoin-contract`.
- Do this only if 5c lands cleanly; it is session policy, not fork wiring.

### 4e ownership and sequence

Serialize the shared surfaces. One writer per row:

| Slice | Owner files | Depends |
|---|---|---|
| 5a | new `src/tools/fork-spawn-ticket.mjs`, `src/host/fork-wiring.mjs`, `tests/fork-wiring.test.mjs` | Phase 1/2 green |
| 5b | `src/host/fork-wiring.mjs`, new `src/host/child-display-holder.mjs`, `src/activation/index.mjs`, `tests/ui-init.test.mjs` | 5a |
| 5c | `src/station/station.mjs`, `src/station/registry.mjs`, new `src/host/fork-identity.mjs`, `src/host/fork-wiring.mjs` | 5b |
| 5d | `src/station/registry.mjs`, new `src/host/handoff-router.mjs` | 5c |

`fork-wiring.mjs`, `activation/index.mjs`, `station/registry.mjs`, and
`station/station.mjs` are single-writer surfaces. Do not run two rows in parallel.

## 5. Revised DAG

### Wave A — Phase 2 closeout

1. `buildPorts` once per station; remove the second call in `resolveWiringPorts` or
   make it return the same objects.
2. Pass the resolved clock into `skillReceiptText`/`amendText`/`child-display` so
   `HERD_CLOCK=off` removes the time segment everywhere.
3. `tests/helpers/composition.mjs`: start through `activate`, one end-to-end
   ablation per port (folding, clock).
4. Full `bun test tests`, `bunx eslint .`.

Owner: station integrator. Blocks Phase 3/4.

### Wave B — Phase 3 (parallel by disjoint files)

- B1 scope delete: `core/ports/registry.mjs`, `core/ports/resolve.mjs`, README,
  port/refactor tests.
- B2 relay policy: new `relay/policy.mjs`, `station/handoff-state.mjs`,
  `activation/ports.mjs`; station call site via integrator.
- B3 nullTickets: `station/registry.mjs`, test helper, registry test.
- B4 feature-module deletion: `features/status`, `features/observer`,
  `features/model-switch`, their contract tests.
- B5 pin/amend/herd construction: `activation/ports.mjs`, station port methods.
- B6 forkForFlow delete: `station/station.mjs` (verify git log first).

Edges: B1/B3/B4 independent; B2/B5 both touch `activation/ports.mjs` → one ports
owner; B2/B5/B6 touch `station.mjs` → one station integrator. B2 depends on the
relay policy interface; B5 depends on `buildPorts` from Wave A.

### Wave C — Phase 4 (sequential station slices)

`4a context → 4b tool_call → 4c fork/join → 4d relay/handoff`. Each slice:
domain module + tests first, then station snippet + ratchet update. The station
integrator owns `station.mjs`; workers own their domain module and the one
gatekeeper file. Do not parallelize two slices that edit `station.mjs`.

### Wave D — Phase 5 (sequential 5a → 5b → 5c → 5d)

Single writer on `fork-wiring.mjs`, `activation/index.mjs`, `registry.mjs`,
`station.mjs`. 5a can start after Wave A (it is independent of Phase 3); 5b depends
on 5a; 5c on 5b; 5d on 5c.

### Wave E — Phase 6

Full test/lint/smoke, manual fork/join/relay/todo/abort, README/CHANGELOG, and the
ablation matrix table.

## 6. Acceptance checks

### Per-port slice

- The disposition row is implemented: production calls the object, or the switch is
  deleted; no test-only feature module remains behind a live switch.
- README matches the actual `HERD_*` vocabulary.
- Focused tests pass; full suite passes at the Wave boundary.
- A composition-root test (not a direct implementation import) proves the port is
  reached.

### nullTickets

- `createStationRegistry` without tickets throws `MISSING_TICKETS`.
- Every `this.tickets.*` call has a real capability or a recording double.
- The rejecting-ticket case records on the diagnostics domain and leaves no
  unhandled rejection.

### Station slice

- Gatekeeper is `Compute → Commit → Dispatch`; no query dispatches.
- Domain module is pure: no `station`, no `this`, no `await`, no state mutation.
- Ratchet count decreases or stays flat; no new allowlist entry.
- Event behavior tests (fork/join, tool call, context, relay) stay green.

### Wiring slice

- `spawnChildTicket` lives in `src/tools/fork-spawn-ticket.mjs`; no shim.
- `attachForkPorts` is two-phase; the double attach is gone; station fields are not
  written by wiring except through the binding API.
- Wiring has no business branch beyond host DI; `fork-wiring` tests, `ui-init`,
  `forkjoin-recovery`, `port-wiring` pass.

### Phase 6

- `bun test tests`, `bunx eslint .`, `bun run smoke:relay`.
- Manual: fork → join, return, handoff, todo grant, abort; with `HERD_FOLDING=off`,
  `HERD_CLOCK=off`, `HERD_RELAY=none/ledger/handoff`.
- The ablation matrix has one row per surviving port and no dead switch.

## 7. Open decisions and recommended defaults

1. **scope**: delete (recommended). README says the three tools always exist; `bare`
   is a product change, not a cleanup.
2. **relay**: policy object (recommended). Keep the three names; move the real
   transitions into the policy.
3. **status/observer/modelSwitch**: keep the name gate, delete the test-only feature
   module (recommended). If a module is the intended runtime, wire it and delete the
   parallel implementation instead.
4. **forkForFlow**: delete (recommended). No caller; `Object.create(this)` hides
   shared state. Confirm with `git log` before deleting.
5. **nullTickets**: required constructor argument (recommended), not a throwing
   proxy; fail before a station exists.
6. **First Phase 4 slice**: `context` (recommended), then `tool_call`, then
   `fork/join`, then `relay/handoff`.

## 8. Residuals carried into implementation

- `buildPorts` currently may run twice (`resolveWiringPorts` and `wireExtension`);
  Wave A fixes it.
- `station.skillReceipt` (`station.mjs:871`) and `controls.amendText` (`controls.mjs:36`)
  do not pass the resolved clock yet; Wave A fixes it.
- `child-display.scopeActivity` has an optional clock but its own call site passes
  none; Wave A or 5b fixes it.
- The worktree has user uncommitted permission→targets and scope_join changes;
  every slice must read the working tree and use `commit.draft` for its own lines.
- `tests/refactor-guards.test.mjs` currently asserts the absence of `src/features/scope`;
  B1 must update that assertion when the port is deleted.
