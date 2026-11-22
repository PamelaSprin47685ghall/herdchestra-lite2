# Phase 3 contracts — written, not run

Authority: `.agent/skills/station-refactor/phase345.md`. Target A: every remaining
port is either the production path or deleted; Station rich, Ticket thin, Wiring
mechanical. These contracts are red against the current tree. They were not run.
Implementation slices own the source changes; this file owns the API decisions and
the list of existing tests each slice must update.

## 1. New test files

### `tests/architecture/phase3-ports.test.mjs`

| Case | What it proves | Red because |
|---|---|---|
| `the port table no longer has a scope entry` | `PORTS.scope` is gone, `PORT_NAMES` is 11, `NAMED_SWITCHES` has no scope | scope still exists |
| `a stray HERD_SCOPE is ignored, not resolved` | an old environment variable cannot select a port that no longer exists | resolver returns `scope: "bare"` |
| `a ticket that still asks for scope is refused` | a stale `uses.scope` is `PORT_UNAVAILABLE`, not silently ignored | resolver accepts it |
| `readSwitch no longer knows scope` | the resolver's per-port entry is gone | `readSwitch("scope")` succeeds |
| `the smoke check no longer asks ... scope` | `scripts/smoke-relay.mjs` stops pinning the retired backend | it still calls `readSwitch("scope")` |
| `relay resolves to a policy object` | `buildPorts` returns `implementations.relay` with `name/owesLedger/canHandoff` | only folding/clock objects exist |
| `an invalid relay name is refused` | `HERD_RELAY=sometimes` is a named switch refusal | same as above |
| `pin/amend/herd are state-bound implementations built once` | `buildPorts` returns `{ name, bindState(store) }` for all three; off forms refuse | no such objects |
| `the on forms write through the store` | the bound object writes the station store, not a closure copy | no such objects |
| `undefined or null tickets throw MISSING_TICKETS` | the registry refuses before a station exists | `nullTickets` default |
| `a partial capability set is refused` | `activateTools` alone is not a ticket capability set | same |
| `a recording double is accepted and wired` | the station receives the exact tickets object | same |
| `the silent no-op default is gone` | `nullTickets` is removed from `registry.mjs` | it is still defined |

### `tests/ablation/relay-strategy.test.mjs`

| Case | What it proves | Red because |
|---|---|---|
| method set / obligation table | all three policy objects expose `record/status/advance/owesLedger/canHandoff`; only handoff can advance | only the test-only feature object exists; no capability methods |
| `none records nothing ...` | `record` returns `recorded:false`, `status` owes false, `advance` refuses | module not on the production path |
| `ledger records ... never hands off` | stop follows an empty ledger; `advance` refuses | same |
| `handoff adds the transfer ...` | `advance(empty)` returns a successor; open ledger refuses | same |
| `a handoff object arms even when the string says none` | `armHandoff` reads `implementations().relay`, not `ports().relay` | it reads the string |
| `a none object blocks arming even when the string says handoff` | same, opposite direction | same |
| `a none object ignores a ledger write ...` | `recordLedgerEvaluation` reads the object | it reads the string |
| `a ledger object applies a write ...` | same, opposite direction | same |
| `station.relayOn calls the object` (two directions) | `relayOn` reads `station.relayPort()`, not the name | it reads the string and has no `relayPort()` |
| `neither handoff state nor the station compares the relay name` | static ratchet: no `ports?.().relay ===` in `handoff-state.mjs`/`station.mjs` | both compare |

## 2. API decisions

### B1 — delete the scope port

- Remove `scope` from `PORTS` (`src/core/ports/registry.mjs:15-22`) and from
  `NAMED_SWITCHES` (`:57`). Update the header comment: `relay` is the only
  three-name port; two-implementation ports use `on`/`off`.
- A stray `HERD_SCOPE` is ignored by `resolvePorts` because it iterates `PORTS`.
  `uses.scope` is refused as an unknown port with `available: []`.
- Keep the README's line 17 promise: the three tools exist in every supported
  configuration; a configuration that cannot support fork/join refuses the call.
  There is no `HERD_SCOPE` in README today; do not add one.
- Update `src/core/ports/resolve.mjs` comments that still say "scope/relay".
- Update `scripts/smoke-relay.mjs:167-178`: replace the "retired one-container
  backend is refused" check with "the port table has no scope entry" (or remove
  the check; the new architecture test covers it).

### B2 — relay policy object

- New `src/relay/policy.mjs`, moved from `src/features/relay/index.mjs`. Delete the
  feature file; no compatibility re-export. Keep the existing `record/status/
  advance` behavior and add two capability methods:

```js
{
  name: "none" | "ledger" | "handoff",
  owesLedger(): boolean,   // none: false; ledger/handoff: true
  canHandoff(): boolean,   // only handoff: true
  record(input),           // existing shape
  status(ledger),          // existing shape
  advance(ledger),         // existing shape
}
```

- `relayImplementations = { none, ledger, handoff }` exported from the same file.
- `src/activation/ports.mjs` builds `implementations.relay =
  relayImplementations[names.relay]`. It is the only place a relay name is read.
- `src/station/station.mjs` gains one method:

```js
relayPort() {
  return this.registry?.implementations?.().relay
    ?? relayImplementations[this.registry?.ports?.().relay ?? "handoff"];
}
```

  The fallback keeps unit doubles that pass only `ports` working; production
  always passes `implementations`. `relayOn` uses `this.relayPort().owesLedger()`.
- `src/station/handoff-state.mjs` uses capability methods only:
  - `armHandoff` / `advanceRelayForHandoff`: `if (!station.relayPort().canHandoff()) return false;`
  - `recordLedgerEvaluation` / `recordRetirement` / `recordNaturalStop`:
    `if (!station.relayPort().owesLedger()) return ...;`
- Do **not** move the ledger transition state machine into the policy yet. That is
  Phase 4d. This slice removes the string and parallel path with the smallest
  interface; the transitions still call `src/relay/ledger.mjs`.
- Single writers: `src/activation/ports.mjs` (one ports owner), `src/station/
  handoff-state.mjs` (relay slice), `src/station/station.mjs` (station integrator).
  B2 and B5 both touch `activation/ports.mjs`; serialize or give both additions to
  one owner.

### B3 — tickets are required

- `src/station/registry.mjs`: delete `nullTickets` (`:26-31`). Signature becomes
  `createStationRegistry(pi, tickets, pricingCatalog, ports = {})`.
- Validate before creating any station:

```js
if (!tickets
  || typeof tickets.activateTools !== "function"
  || typeof tickets.steer !== "function"
  || typeof tickets.prompt !== "function") {
  const error = new Error(
    "MISSING_TICKETS: createStationRegistry requires activateTools/steer/prompt",
  );
  error.code = "MISSING_TICKETS";
  throw error;
}
```

- The production call site (`src/activation/index.mjs:134`) already passes
  `buildTickets(pi)`; no change there.
- Add `tests/helpers/tickets.mjs` with a recording double exposing `activateTools`,
  `steer`, `prompt`, `join`, `return` as spies. Use it in direct
  `new SessionStation` tests that exercise a ticket path; tests that never call a
  ticket may keep `{}`. `tests/station-purity.test.mjs` already uses a rejecting
  ticket and stays the catch-all contract.
- No throwing proxy is needed at the call site: the registry refuses before a
  station exists.

### B4 — delete the test-only feature modules

- Delete `src/features/status/index.mjs`, `src/features/observer/index.mjs`, and
  `src/features/model-switch/index.mjs`. No `src/` file imports them; only
  `tests/contract/status-observer.test.mjs` and
  `tests/contract/folding-model-switch.test.mjs` do.
- Keep the production name gates: `src/host/status.mjs` (installStatus),
  `src/host/provider-observer.mjs` (wireProviderObservation), and
  `src/station/models.mjs` (queueModelSwitch/takePendingModelSwitch). They are
  load-bearing and already covered by `tests/port-wiring.test.mjs`.
- `tests/contract/status-observer.test.mjs`: delete it, or rewrite it as a
  host-level test that installs the real host runtime and asserts on/off. The
  parallel feature contract is not worth keeping once the feature modules are gone.
  `tests/port-wiring.test.mjs` already covers the install/no-install behavior.
- `tests/contract/folding-model-switch.test.mjs`: remove the modelSwitch import
  and cases (`:20-24` and the modelSwitch block); keep the folding half. Update the
  header comment.

### B5 — pin/amend/herd are built once and bound per station

- `src/activation/ports.mjs` returns three state-bound factory objects in
  `implementations`:

```js
{ name: "on" | "off", bindState(store) { return on ? createOn(store) : createOff(); } }
```

  `store` is the station state (`{ pins }`, `{ amends }`, `{ autopilot }`). The
  object is built once by `buildPorts`; `bindState` is called once per station.
  This is the smallest interface that keeps `buildPorts` before any station exists
  and still removes per-call construction. Record this choice: phase345.md said
  "state-bound" but did not name the binder.
- `src/station/station.mjs`:
  - in the constructor, resolve `const impls = registry?.implementations?.() ?? {}`
    and cache `this.pin = impls.pin?.bindState?.(this.state) ?? fallbackPin(this.state)`,
    same for amend/herd;
  - `pinPort()` / `amendPort()` / `herdPort()` return the cached objects;
  - remove the per-call `createPinOn/Off` etc. from those methods. Keep a
    once-per-station fallback for unit doubles that pass only `ports` names.
- `src/activation/index.mjs` already passes `implementations`; no change.
- Update `tests/port-wiring.test.mjs` to build the station through `buildPorts`
  (or pass `implementations`) and assert the object path; its status/observer/
  modelSwitch cases are host-level and stay.

### B6 — delete `forkForFlow`

- Delete `src/station/station.mjs:208-241`. `rg forkForFlow` finds no caller in
  `src/` or `tests/`. `git log -S forkForFlow -- src/station/station.mjs` shows it
  was introduced by `68f9224 fix(fission): isolate flow stations, resolve models,
  and continue after scope end`; the fission flow scheduler is gone and only the
  custom message types remain. Confirm with `git log` before deleting; no test is
  required. The Phase 4 ratchet can assert the name is absent.
- `Object.create(this)` was the hidden parent-state view; deleting the method
  removes both the dead path and the shared-state hazard.

## 3. Existing tests each slice must update

| Slice | File | Change |
|---|---|---|
| B1 | `tests/ports-resolve.test.mjs:24-29` | 12 → 11 ports; remove scope implementation assertion; `NAMED_SWITCHES` contains only relay |
| B1 | `tests/ports-resolve.test.mjs:33` | remove `switchName("scope")` |
| B1 | `tests/ports-resolve.test.mjs:53` | remove the scope default; keep relay/clock |
| B1 | `tests/ports-resolve.test.mjs:58-78` | relay-only name resolution; invalid relay name |
| B1 | `tests/ports-resolve.test.mjs:143-174` | delete scope ticket cases; add `uses.scope` refusal |
| B1 | `scripts/smoke-relay.mjs:167-178` | replace the retired-backend check |
| B1 | `README.md` | verify the line-17 promise; no `HERD_SCOPE` |
| B1 | `tests/refactor-guards.test.mjs:72-76` | the absence assertions remain true; verify no scope port reference |
| B2 | `tests/contract/relay.test.mjs:11` | import `src/relay/policy.mjs`; add `owesLedger`/`canHandoff` to the method-set case |
| B2 | `tests/relay-port.test.mjs:10-16` | pass `implementations` (or buildPorts); keep the none/ledger/handoff behavior cases |
| B2 | `tests/forkjoin-contract.test.mjs` | if its station double needs `relayPort`, add the implementation map or use the fallback |
| B2 | `tests/relay.test.mjs` | domain tests; no change expected |
| B3 | `tests/helpers/tickets.mjs` (new) | recording double for direct station tests |
| B3 | `tests/port-wiring.test.mjs:11,64,170` | pass the double where a ticket path runs; status/observer/modelSwitch cases stay |
| B3 | `tests/relay-port.test.mjs:10-16`, `tests/fork-tool-deadline.test.mjs:46`, `tests/silent-failure.test.mjs:47`, `tests/model-facing-copy.test.mjs:131,172` | pass the double if the test calls a ticket; `{}` is fine otherwise |
| B4 | `tests/contract/status-observer.test.mjs` | delete or rewrite to host installers |
| B4 | `tests/contract/folding-model-switch.test.mjs:20-24` | remove the modelSwitch import and cases; keep folding |
| B5 | `tests/port-wiring.test.mjs` | build through `buildPorts`/`implementations`; assert stable `pinPort()` identity |
| B6 | none | delete the method; Phase 4 ratchet may assert absence |

## 4. Files to delete

- `src/features/status/index.mjs`
- `src/features/observer/index.mjs`
- `src/features/model-switch/index.mjs`
- `src/features/relay/index.mjs` (moved to `src/relay/policy.mjs`)
- `tests/contract/status-observer.test.mjs` (or rewrite host-level)
- `nullTickets` block in `src/station/registry.mjs`
- `forkForFlow` block in `src/station/station.mjs`
- `scope` entry in `src/core/ports/registry.mjs`

Do not add compatibility re-exports or a second port table. A stale import should
fail loudly.

## 5. Ambiguities resolved here

1. **B5 binding**: `buildPorts` runs before a station exists, so the session ports
   are factory objects with `bindState(store)`; the station binds once. This is
   simpler than a mutable shared implementation and still removes per-call
   construction.
2. **B2 scope**: only the string checks and the parallel feature module move now;
   the ledger transition functions stay in `src/relay/ledger.mjs` until Phase 4d.
   The policy's capability methods are enough to remove the string path.
3. **B1 product decision**: delete `bare` rather than implement it. README line 17
   promises the three tools in every supported configuration; a `bare` mode that
   removes fork/join contradicts that. A future product decision can add a real
   refusal path, but it must not be a dead switch.
4. **B4**: delete the parallel feature modules, not the host name gates. The host
   runtime is the production implementation; the feature modules are a second
   model. If a host test needs a formatter, move that function to
   `src/host/status-format.mjs` and call it from the runtime; do not keep the
   feature module.
5. **B6**: delete `forkForFlow`; it is dead. If fission flow isolation is still a
   requirement, it must return as a tested station factory, not an
   `Object.create(this)` view.

## 6. Acceptance

- The two new test files pass after the slices land; they were not run red.
- Full `bun test tests` and `bunx eslint .` pass at the Phase 3 boundary.
- No `HERD_SCOPE`, no `PORTS.scope`, no `nullTickets`, no `forkForFlow`.
- No production `ports?.().relay ===` comparison in `handoff-state.mjs` or
  `station.mjs`; relay behavior is selected by the object, and contradictory
  `ports`/`implementations` maps prove it.
- No test-only feature module remains behind a live switch.
- `scripts/smoke-relay.mjs` no longer pins the retired scope backend.
