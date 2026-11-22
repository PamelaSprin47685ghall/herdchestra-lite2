# Wiring recon — shadow front desk inventory

Read-only map for Phase 5. Current worktree is the baseline; no source edits were made.

## 1. File map

| File | Lines | Role |
|---|---:|---|
| `src/host/fork-wiring.mjs` | 514 | Four fork ports + the child spawn ticket + display holder |
| `src/activation/index.mjs` | 180 | Composition root: resolves ports, wires hooks/tools/commands, attaches stations |
| `src/activation/tools.mjs` | 100 | Registers control/todo tools; each execute delegates to a ticket |
| `src/host/fork-registry.mjs` | 363 | Session-wide runtime index: ledgers, outcomes, identities, agent→fork, waiters |
| `src/station/registry.mjs` | 155 | Station cache; attaches fork ports before the composition root hook |
| `src/tools/tickets.mjs` | 521 | Async tickets; already the home of all `await` |

## 2. `fork-wiring.mjs` structure

Helpers:

| Lines | Symbol | What it does |
|---:|---|---|
| 36 | `MAX_RETURN_NUDGES = 2` | Stop-loop bound |
| 38 | `isDisplayHolder` | `value !== null && typeof value === "object" && "current" in value` |
| 42 | `resolveDisplay` | function → call; holder → `.current`; else value |
| 51 | `createDisplayHolder` | `{ current, subscribe, notify }`, listener errors recorded |
| 72 | `messagesOf` | three shapes: `session.agent.state.messages`, `session.messages`, `agent.messages` |
| 84 | `stopReasonOf` | `state.stopReason ?? state.lastStopReason` |
| 97 | `writeFrozenOutcome` | write outcome only when no non-empty frozen `record` exists |

Exports:

| Lines | Symbol | Sync? |
|---:|---|---|
| 111–287 | `spawnChildTicket(spec, ports)` | async |
| 289–510 | `attachForkPorts(station, wiring, options)` | sync |
| 512–514 | `createForkWiring()` | sync |

### 2.1 `spawnChildTicket` body

Flow:

1. `createSession(spec)`; refusal → failed outcome with `created.reason`, plus `created.error`/`created.detail`; records cause; returns `finish()`.
2. `display.attach(label, session)` in try/catch; failure is recorded, never fatal.
3. `bindAgent(registry, forkId, childAgentId)` from `session.agent.id ?? session.agentId ?? created.agentId`.
4. `prepareChild(session)`; refusal recorded, not fatal.
5. Pick `prompt` from `session.prompt` or `session.agent.prompt`; absent → failed outcome.
6. `stopAfterScopeReturn(session.agent)` when `abort` exists.
7. `await prompt(spec.receipt)`.
8. Return-nudge loop while `forkOf(ledger, forkId).status === "running"`:
   - non-clean stop reason → failed;
   - `nudges >= 2` → failed, `unpublished = true`;
   - otherwise `await prompt(childReturnNudge())`.
9. `renderChildRecord(added, { maxResultChars, maxThinkingChars })`.
10. Empty text and not failed/unpublished/frozen → failed (`no messages`).
11. `writeOutcome`; `finish()` detaches display, `pulse()` wakes join, `persistLedger()`, returns `{ ok: true, failed, reason }`.
12. Outer `catch` records and writes a failed outcome; `finally` detaches termination and records limitations.

Dependencies: `createForkRegistry` helpers (`bindAgent`, `forkOf`, `outcomeOf`, `pulse`, `setOutcome`, `writeFrozenOutcome`), `renderChildRecord`, `record`, `publicScopeId`, `scopeTitle`, `childReturnNudge`, `stopAfterScopeReturn`, `randomUUID`.

### 2.2 `attachForkPorts` body and branch inventory

Branch / decision points (20+):

1. `wiring?.registry ?? createForkRegistry()`.
2. `options.identity` object check.
3. `options.conversationKey ?? null`.
4. `indexed = identity ? null : ledgerFor(registry, conversationKey)`.
5. `restored = station.state?.brackets ?? null`.
6. Ledger choice: identity ledger → indexed with `order.length > 0` → restored → indexed.
7. If `station.state && ledger`: write `station.state.brackets`.
8. `if (!identity) adoptLedger(...)`.
9. `isDisplayHolder(options.display)`.
10. `displayRef = displayHolder ?? createDisplayHolder(resolveDisplay(options.display))`.
11. `subscribeDisplay` if not already subscribed.
12. `releaseDisplaySubscriptionIfIdle` when no waiters.
13. `attachPendingDisplay` guards `!active || attached`.
14. `flushPendingDisplay` per-entry `active`/`attached` branches.
15. `setDisplayPort`: child holder branch vs root owner branch; calls `flushPendingDisplay` and `notify`.
16. `noteRootWait` only when no identity.
17. `noteScopeRequest` only when ledger exists.
18. `forkDepthPort`: `identity.childDepth` integer vs owner-derived 0/1.
19. `persistLedger`: `identity.persistRoot` function vs root `station.persist?.()`.
20. `options.createSession` function check; spawn identity assembly with `randomUUID`, `setIdentity`, nested `ports` object; `spawnChildTicket(...).catch(...)`.
21. `resolveDisplay(identityDisplayHolder)` snapshot inside identity plus live holder.

Fields written onto the station:

| Field | Line | Kind |
|---|---:|---|
| `state.brackets` | ~310 | domain state (ledger) |
| `forkLedgerPort` | 312 | capability |
| `forkWaitPort` | 315 | capability |
| `forkIdentityPort` | 316 | capability |
| `forkOwnerId` | ~323 | derived capability |
| `ownerId` | ~327 | duplicated domain field |
| `displayPort` | 409 | capability |
| `setDisplayPort` | 411 | mutator |
| `noteRootWait` | ~421 | capability |
| `noteScopeRequest` | ~424 | capability |
| `forkDepthPort` | ~428 | derived capability |
| `childOutcomePort` | ~433 | capability |
| `setChildOutcome` | ~437 | mutator |
| `persistLedger` | ~441 | capability |
| `childSpawnPort` | 447 | capability factory |

Business decisions currently inside the “wiring” function:

- Which ledger wins (live index vs restored tree vs identity ledger).
- Which identity/display holder a child receives.
- When to adopt a ledger into the registry.
- Child identity assembly (agentId, depth, targets, budget, time, persistRoot, intent).
- Display-holder lifecycle (subscription, pending attach, root vs child ownership).
- Persist policy (root branch vs child identity’s `persistRoot`).
- Child spawn port assembly and its catch-all.

Mechanical parts: assigning the port functions above; returning `{ registry, ledger }`.

## 3. `activation/index.mjs`

- `resolveWiringPorts` (31–40) reads the environment once and returns a resolved table; refusal is recorded and returned, not silently downgraded.
- `wireExtension` (45–149):
  - `refreshStationUI` (59–72): finds owner, skips child agents, remembers session, registers UI, sets display port. UI refresh policy.
  - `attachStation` (73–137): gets global fork wiring, resolves child identity by agent id, registers owner UI, computes display (child holder/display vs root `childDisplayFor`), calls `attachForkPorts` with `identity`, `display`, `conversationKey`, `ownerSession`, `prepareChild`, `createSession`.
  - `createStationRegistry` (139) receives `...table`, `onStation`, `onStationRefresh`.
  - `wireHooks`, `wireTools`, `wireCommands`, `wireHostDiagnosis` are pure registration.
- `attachStation` is the main “shadow front desk”: it decides identity, display, owner UI, and child session assembly. Some of it is host DI (createSession, prepareChild), some is policy (who gets a display, which owner UI is registered).

## 4. `activation/tools.mjs`

Pure registration: `scope_fork`, `scope_join`, `scope_return`, `amend`, `pin`, `todo`; each `execute` delegates to `*Ticket(registry.stationFor(ctx), ...)`. No business branch. `scope_join` adds `interruptible`/`handlesToolInterrupt` flags. No Phase 5 edit expected here.

## 5. `station/registry.mjs`

- `nullTickets` (20–25): silent no-op ticket bundle. A station built without tickets would answer `undefined` and hide the missing capability; Phase 1/3 should make this fail fast or explicit.
- `attachStationPorts` (53–64): calls `attachForkPorts` with `conversationKey` and `ports.forkOptions`, catches failure into `station.noteError`, then calls `ports.onStation` (which calls `attachForkPorts` again with the full options).
- `stationFor` (80–120): creates/caches stations; calls `onStationRefresh` on every hit; `stationForStop` (143–155) routes a pending handoff to the old station if `sameManager`.
- `pendingStation` + `sameManager` is session routing policy in the registry; not fork wiring, but part of the shadow-front-desk surface.

## 6. Spawn ticket move plan

Recommended: new sibling `src/tools/fork-spawn-ticket.mjs`, not an append to the 521-line `src/tools/tickets.mjs`.

- Move `MAX_RETURN_NUDGES`, `writeFrozenOutcome`, and `spawnChildTicket` verbatim.
- Imports move with it: `randomUUID`, `bindAgent`, `forkOf`, `outcomeOf`, `pulse`, `setOutcome`, `renderChildRecord`, `record`, `publicScopeId`, `scopeTitle`, `childReturnNudge`, `stopAfterScopeReturn`.
- Signature stays `spawnChildTicket(spec, ports)`; it is already dependency-injected and has no station reference.
- `src/host/fork-wiring.mjs` imports it and keeps the call site at 496 with the outer catch-all. The catch-all is the station’s obligation; the ticket also catches internally, so the outer catch is the last-resort boundary.
- Update direct-import tests (`tests/fork-wiring.test.mjs:4-6`) to the new path; no re-export shim. `fork-spawn-chain.test.mjs` goes through the branch session, not the direct import.
- Keep `attachForkPorts`’s spawn closure in wiring for now; moving identity assembly is Phase 5b/5c.

Why not `tickets.mjs`: it is already 521 lines and mixes model-switch, join/return, amend/pin. A sibling under `src/tools/` preserves the “ticket owns awaits” rule and keeps the move reviewable.

## 7. `attachForkPorts` thinning plan

Target: wiring only binds capabilities; station owns derivation and state.

1. **Split the call.** `attachForkPorts` is called twice per station: `registry.attachStationPorts` first, then `activation.attachStation` via `onStation`. The second call re-runs ledger selection and display holder creation. Make the first call `attachBaseForkPorts` (ledger + wait + identity + basic capabilities) and the second `bindHostForkPorts` (display + spawn + prepare/createSession). Idempotent or two-phase; do not keep two full attaches.
2. **Move display holder state** into `src/host/child-display.mjs` (or a `DisplayPortHolder` class) with `attach`, `flush`, `setPort`, `subscribe`, `detach`. Wiring passes the holder; it does not own the pending map.
3. **Move child identity assembly** into a `buildChildIdentity(spec, { agentId, ledger, persistRoot, display })` pure function under `src/host/` or `src/scope/`. The spawn closure calls it and `setIdentity`; wiring does not enumerate identity fields.
4. **Station derivation.** `forkOwnerId`, `ownerId`, and `forkDepthPort` are derived from `forkIdentityPort`. Let the station compute them once in `bindForkPorts(ports)`; wiring supplies only `identity` and `ledger`. Remove `station.ownerId` writes from wiring.
5. **Persist policy** becomes a capability `persistRoot` on the identity; station calls it. Wiring does not branch on `identity.persistRoot` vs `station.persist`.
6. **Ledger selection** becomes `resolveForkLedger({ identity, indexed, restored })` pure function with an explicit precedence table and tests. Wiring calls it once.
7. **Activation `attachStation`** keeps only host DI: `createSession`, `prepareChild`, `conversationKey`, `ownerSession`, `display` (a port, not a holder). Move owner-UI registration and display choice into a host service (`src/host/child-display.mjs` / `branch-session.mjs`).
8. **`stationForStop`** routing is session policy; if Phase 5 touches it, move `sameManager`/pending selection into a small `HandoffRouter` station/service. Do not leave it as a registry branch.

## 8. Behavior pinned by tests

Must preserve:

- `tests/fork-wiring.test.mjs`:
  - child station uses identity ledger; all four ports exposed; shared ledger stable.
  - child finish writes record and wakes join; throw is failed and wakes join; frozen record survives spawn failure; create refusal does not throw; non-clean stop is failed; two children separate outcomes.
  - identity carries fork facts, ownership, depth; one session id one ledger; different sessions separate; spawned child binds host agent id; slow child leaves join parked; identity round-trip; spawn records identity before session exists; child station assembled during `createSession` resolves identity.
  - `spawnChildTicket directly`: display attach before first prompt/detach at end; session-shaped messages; empty turn failed; display attach failure not fatal; prepare child before prompt; preparation refusal not fatal; returns `ok` with failed flag; fork stays running until parent takes; frozen record never overwritten; natural stop nudges, two stops scolded, third failed/unpublished.
  - bracket ledger sharing across stations/conversations; station without registry falls back.
- `tests/fork-spawn-chain.test.mjs`: real branch session prompts child receipt and publishes record; factory refusal fails bracket and wakes join; rejected first prompt fails; throwing factory fails and preserves cause.
- `tests/forkjoin-contract.test.mjs`: adoption follows current receiver; lost bracket never parks; idle join answers; batch projects one item per child; repeated right brackets do not double-count; report obligation survives reload; join leaves parent level/model/budget.
- `tests/join-obligation.test.mjs`: ready/running count; stop steers; elder binding exact; concurrent joins cannot both file; user-input interrupt files elder and next join passes null; external cancel leaves elder pending.
- `tests/ui-init.test.mjs`: late display attach; station reuse after cold attach; child/grandchild spawned before UI; later ctx enables display; headless later ctx does not clear.
- `tests/fork-blocking.test.mjs`, `tests/forkjoin-recovery.test.mjs`, `tests/port-wiring.test.mjs`: blocking, recovery, port switches.

## 9. Phase 5 file ownership

Serialize the `fork-wiring.mjs` hotspot:

| Slice | Owner files | Depends on |
|---|---|---|
| 5a move spawn ticket | new `src/tools/fork-spawn-ticket.mjs`, `src/host/fork-wiring.mjs`, `tests/fork-wiring.test.mjs` | Phase 1/2 green |
| 5b split attach + display holder | `src/host/fork-wiring.mjs`, new `src/host/child-display-holder.mjs` (or extend `child-display.mjs`), `src/activation/index.mjs`, `tests/ui-init.test.mjs`, `tests/fork-wiring.test.mjs` | 5a |
| 5c station binding API + identity helper | `src/station/station.mjs`, `src/station/registry.mjs`, new `src/host/fork-identity.mjs`, `src/host/fork-wiring.mjs`, `tests/fork-wiring.test.mjs`, `tests/forkjoin-recovery.test.mjs` | 5b |
| 5d handoff router (optional) | `src/station/registry.mjs`, new `src/host/handoff-router.mjs`, `tests/forkjoin-contract.test.mjs` | 5c |

One owner per row. `fork-wiring.mjs`, `activation/index.mjs`, `station/registry.mjs`, and `station/station.mjs` are shared surfaces; do not run two rows in parallel.

## 10. Risks / open questions

- **Double attach**: `attachForkPorts` is called twice (registry then activation). The second call can replace a display holder and re-run ledger selection. Any thinning must preserve the final state or make the two phases explicit. Tests pass today, but the current shape is fragile.
- **Global wiring**: `globalForkWiring()` uses `Symbol.for("herdchestra-lite2.fork-wiring.v1")`; the registry is process-wide. Moving the spawn ticket must not create a second registry.
- **Identity table is domain state**: `registry.identities`/`agentForks` is a child-identity index, not a request ledger. It is injected, not held by the station; leave it in the registry, but name it as a child-identity table, not a ticket table.
- **Display holder is stateful**: moving it out of `fork-wiring.mjs` is necessary for “wiring mechanical”, but it is a real service with lifecycle (pending attach, late UI, detach). Give it a station/service owner and tests.
- **`nullTickets`**: silent no-op belongs to Phase 1/3, not Phase 5; do not let it survive as a second convention.
- **No re-export shim**: update direct imports in tests; clean cutover.
