# Ports and ablation — recon

Read-only map of the port surface. Written for the Phase 2 slices (folding, clock)
and for the later relay/status/observer/modelSwitch cleanup. Source of truth is
the working tree, not this prose; line numbers are from the tree at recon time.

## 0. Verdict

The switch table is real. The implementation table is not.

- `src/core/ports/registry.mjs` declares 12 ports and resolves a name for each.
- `src/activation/index.mjs` resolves the names once and hands the name table to
  the station registry.
- No composition-root step builds an implementation object for most ports.
  `SessionStation` reads names and constructs only `pin`, `amend`, and `herd`
  inline (`station.mjs:637-655`).
- Feature modules for `folding`, `clock`, `relay`, `status`, `observer`, and
  `modelSwitch` are imported only by `tests/contract/*` and `tests/port-wiring`
  style tests. They are parallel models, not production paths.
- `scope` has no implementation module at all (`src/features/scope/` is absent;
  `tests/refactor-guards.test.mjs` asserts it stays absent) and no reader.

So the audit's "12 ports, 9 consumed" is too generous. Only 5 have a production
implementation or option gate; 4 have a production string gate plus a test-only
implementation; 3 are dead switches.

## 1. Port table and production status

| Port | Implementations | Production consumer | Status |
|---|---|---|---|
| `pin` | on/off | `station.pinPort()` (`station.mjs:637-641`), `handlePinCall` (`controls.mjs:59`) | load-bearing implementation |
| `amend` | on/off | `station.amendPort()` (`station.mjs:643-647`), `handleAmendCall` (`controls.mjs:29`) | load-bearing implementation |
| `herd` | on/off | `station.herdPort()` (`station.mjs:649-655`), `onAutopilotCommand` | load-bearing implementation |
| `chineseReminder` | on/off | `host/prompts.mjs:52-57` | load-bearing option gate |
| `vibeCompat` | on/off | `station.mjs:777` passes the name table to `rewriteVibeMessage`; `transcript/tail.mjs:13` reads it | load-bearing option gate |
| `relay` | none/ledger/handoff | string checks in `handoff-state.mjs:30,46,78,118,136` and `station.mjs:350` | string gate; feature implementation test-only |
| `modelSwitch` | on/off | string checks in `station/models.mjs:69,85` | string gate; feature implementation test-only |
| `status` | on/off | `host/status.mjs:401` | string gate; feature implementation test-only |
| `observer` | on/off | `host/provider-observer.mjs:296` | string gate; feature implementation test-only |
| `clock` | on/off | none | dead switch; feature implementation test-only; production arithmetic inline |
| `folding` | on/off | none | dead switch; feature implementation test-only; production folding inline |
| `scope` | bare/batch | none | dead switch; no implementation module; `HERD_SCOPE` only changes the table |

Count: 5 load-bearing gates, 4 string gates with unused implementations, 3 dead
switches. The 861 green tests prove the feature modules satisfy their own
contracts; they do not prove any switch is wired to production.

## 2. Composition root reality

- `resolveWiringPorts` (`activation/index.mjs:41-50`) calls `resolvePorts({}, env)`
  and returns `{ ports: { name: implementationName } }`.
- `wireExtension` (`activation/index.mjs:51`) passes `...table` into
  `createStationRegistry` (`activation/index.mjs:127-139`). That table is a map
  of names, not objects.
- `station/registry.mjs:38` stores `resolvedPorts = { ...ports }`; `ports()`
  returns a copy of the names (`registry.mjs:91-93`).
- `SessionStation` reads names and builds `pin`/`amend`/`herd` per call. No other
  port is constructed.
- Contract tests import implementations directly:
  `tests/contract/clock.test.mjs`, `folding-model-switch.test.mjs`,
  `relay.test.mjs`, `status-observer.test.mjs`, `pin-amend.test.mjs`.
  They never call `activate`/`wireExtension`.
- Tests that do build through the real composition root: `tests/integration.test.mjs`,
  `tests/todo-any-level.test.mjs`, `tests/capture.test.mjs`, `tests/ui-init.test.mjs`.
  Most fork/join tests build `new SessionStation(...)` directly.
- Therefore a missing wire is invisible: a feature can be absent from production
  and its contract can still be green.

The missing piece is a `buildPorts(table, deps)` step in activation. Until it
exists, "port" means "a name some call site compares against a string".

## 3. Exact production paths

### 3.1 Folding

Production, `src/station/station.mjs:748-790` (`transformContext`):

```js
let messages = filterAmends(original, this.state.amends);      // 755
const foldable = foldableReceipts(this.state.receipts);        // 760
if (foldable.length > 0) {
  const folded = applyReceiptFolds(messages, this.state.receipts, { foldable }); // 762
  messages = folded.messages;
  if (folded.collapsed.length > 0) this.settleReceiptFolds(folded.collapsed);   // 764
}
```

Feature, `src/features/folding/index.mjs`: `note(entry)` / `fold({ retired })` /
`kept()`. No `src` module imports it.

Mismatch: the feature is a keep-list keyed by amend-retired beat keys. Production
folding is receipt-text projection (`foldableReceipts` + `applyReceiptFolds` in
`src/scope/receipts.mjs` and `src/transcript/collapse.mjs`). Retired beats are
already handled by `filterAmends` (`transcript/amend.mjs`). The feature is not a
drop-in for production; it is a different design for the same word.

Two coherent options:

- A. Redefine `folding` as the receipt projection strategy. `on` delegates to
  `foldableReceipts`/`applyReceiptFolds`; `off` returns no foldable and the
  original messages. This makes the switch load-bearing and keeps the README's
  receipt-folding behavior.
- B. Delete the port and feature module, and keep receipt folding as an
  unswitchable core domain optimization. This is honest if folding is never meant
  to be off.

Recommendation: A, because the registry already advertises the switch and the
README describes folding as a behavior the user can reason about. If the user
wants folding always on, B is simpler and removes a fake knob.

Off behavior: no receipt shortening; full text stays; no error. This is a
degradation, not a correctness gate.

### 3.2 Clock

Production:

- `registerFork` computes `deadlineAt` inline (`scope/forkjoin.mjs:117-120`):
  `deadlineAt = timeBudgetMs !== null && startedAt !== null ? startedAt + timeBudgetMs : null`.
- `pauseClock` / `resumeClock` / `deadlineInfo` (`scope/forkjoin.mjs:752-808`).
- `station.pauseBranchClock` / `resumeBranchClock` / `toolTimeLimit`
  (`station.mjs:450-472`).
- `forkBudgetText` (`scope/forkjoin.mjs:795-808`) is called by
  `station/texts.mjs:41`.
- `host/child-display.mjs:363` reads `record.clockPausedAt` directly to count
  busy/idle branches.

Feature, `src/features/clock/index.mjs`: a keyed map (`start(scopeId, budgetMs)` /
`remaining` / `expired` / `clear`). No `src` module imports it.

Mismatch: the feature owns its own deadline map; production owns the deadline on
the persisted fork record. Wiring the current port would create two sources of
truth and lose deadlines on reload. The port must become a stateless policy over
the record, or be deleted.

Recommendation: record policy. It preserves persistence and gives `off` a real
meaning.

```js
// on
start(record, budgetMs, startedAt) // set deadlineAt, clear pause/overtime
pause(record, now)                 // current pauseClock
resume(record, now)                // current resumeClock
info(record, now)                  // current deadlineInfo
toolLimit(record, now)             // current station.toolTimeLimit arithmetic
bounded = true

// off
start(record)                      // deadlineAt = null; clear pause/overtime
pause/resume -> false
info -> { bounded: false }
toolLimit -> null
bounded = false
```

Move the pure arithmetic to `src/scope/clock.mjs` so `features/clock` and
`scope/forkjoin` both use it without a cycle. Re-export from `scope/index.mjs` so
existing imports keep working.

Integration points:

- `registerFork`: stop computing `deadlineAt`; set `deadlineAt: null` and clear
  the clock fields. `fork-controls.mjs` starts the clock after registration:
  `station.port("clock").start(record, record.timeBudgetMs, record.startedAt)`.
- `station.pauseBranchClock()` -> `this.port("clock").pause(this.branchRecord())`.
- `station.resumeBranchClock()` -> `this.port("clock").resume(...)`.
- `station.toolTimeLimit()` -> `this.port("clock").toolLimit(this.branchRecord())`.
- `forkBudgetText` keeps using `deadlineInfo` from `scope/clock.mjs` for display;
  with `deadlineAt = null` it already omits the time segment. Display is not the
  enforcement path.

Off behavior: no deadline, no tool time gate, no pause/resume, no time segment.
`timeBudgetMs` may remain for the declared time, but it is advisory. Document it.

### 3.3 Scope

- `PORTS.scope` (`registry.mjs:16-20`) declares `bare`/`batch`; `NAMED_SWITCHES`
  includes `scope` (`registry.mjs:41`).
- No `ports().scope` reader exists in `src` (grep).
- `src/features/scope/` is absent; `tests/refactor-guards.test.mjs` asserts
  `src/features/scope/index.mjs` and `bare.mjs` stay gone.
- README line 17: "The three tools exist in every supported configuration...
  a configuration that cannot support fork/join refuses the call." This
  contradicts `bare` ("fork/join does not exist").

Recommendation: delete the `scope` port. Remove it from `PORTS`/`NAMED_SWITCHES`,
remove `HERD_SCOPE` from tests/README, and keep the three tools always. If `bare`
is a real product requirement, implement it as "tools not registered + calls
refuse `PORT_UNAVAILABLE`" and change the README; do not leave a dead switch.

### 3.4 Relay

- Production reads the name as a string in `handoff-state.mjs:30,46,78,118,136`
  and `station.mjs:350`.
- The actual transitions live in `src/relay/ledger.mjs`:
  `applyLedgerEvaluation`, `applyRetirement`, `beginGenerationAfterHandoff`,
  plus `state.mjs`/`prompts.mjs`.
- `features/relay/index.mjs` (`none`/`ledger`/`handoff`, `record`/`status`/`advance`)
  is imported only by `tests/contract/relay.test.mjs`.

Mismatch: the feature models a normalized ledger obligation, not the full relay
state machine (generation, handoffPending, viewRequired, userPrompts, first
evaluation). Wiring the current contract would lose behavior.

Recommendation (Phase 3, not Phase 2): a relay policy object with the real
transitions:

```js
{ name, owesLedger, canHandoff,
  evaluate(relay, phases, op, options),
  retire(relay),
  arm(relay),
  advance(relay, options),
  status(relay) }
```

`none` no-ops and never arms; `ledger` evaluates/retires but never arms;
`handoff` does all. Then remove the string checks from `handoff-state.mjs` and
`station.mjs:350`.

### 3.5 Status, observer, modelSwitch

These switches are load-bearing as strings, but the feature modules are parallel
test-only implementations:

- `status`: production `installStatus` (`host/status.mjs:401`) binds a full
  runtime; `features/status` is a line formatter used only by contract tests.
  Either make the formatter the runtime's renderer, or delete the feature module
  and keep the gate.
- `observer`: production `wireProviderObservation`
  (`host/provider-observer.mjs:296`) writes to the station; `features/observer`
  is a small record store used only by contract tests. Either wire it into the
  observer, or delete it and keep the gate.
- `modelSwitch`: production `models.mjs` queues/takes a pending switch per
  station; `features/model-switch` is per-scope choices used only by contract
  tests. Either redesign to the pending-switch policy, or delete the feature
  module and keep the gate.

Recommendation: Phase 3, per port, choose one. Never leave a test-only parallel
model behind a switch that production implements elsewhere.

### 3.6 Pin, amend, herd, chineseReminder, vibeCompat

These are genuinely load-bearing:

- `pin`: `station.pinPort()`; `createPinOn` writes `state.pins`; `off` refuses
  before `handlePinCall` persists.
- `amend`: `station.amendPort()`; `createAmendOn` writes `state.amends`; `off`
  refuses before `applyAmend` mutates the ledger.
- `herd`: `station.herdPort()`; `createHerdOn` writes `state.autopilot`; `off`
  refuses a toggle.
- `chineseReminder`: removes one line from the persistent rules; no feature
  module.
- `vibeCompat`: rewrites two lines in the outbound vibe message; no feature
  module.

Caveat: `pinPort()`/`amendPort()`/`herdPort()` construct a new object per call.
That is acceptable for stateless wrappers over stable state, but it prevents the
composition root from owning implementation identity and makes test doubles hard.
`buildPorts` should construct them once per station, and `forkForFlow` (if kept)
must rebuild them for its own state.

## 4. Composition-root harness design

Needed before Phase 2. Without it, the ablation tests would repeat the current
mistake of testing implementations directly.

### 4.1 `src/activation/ports.mjs` (new)

```js
export function buildPorts(table, deps) {
  return {
    folding: table.folding === "off" ? foldingOff() : foldingOn(),
    clock: table.clock === "off" ? createClockOff() : createClockOn(),
    pin: table.pin === "off" ? createPinOff() : createPinOn({ notes: deps.state.pins }),
    amend: table.amend === "off" ? createAmendOff() : createAmendOn({ retired: deps.state.amends }),
    herd: table.herd === "off" ? createHerdOff() : createHerdOn(deps.state),
    // later: relay, status, observer, modelSwitch, scope decision
  };
}
```

- `deps` is `{ state, pi, registry, collapse, clockArithmetic, baselineModel }`.
- Construct once per station, after `restoreState`, so the implementations point
  at the station's own state.
- `registry.port(name)` returns `built[name]`. Keep `registry.ports()` returning
  the name table during migration so existing string checks keep working.
- `activation/index.mjs` builds the ports after the registry exists and before
  `attachStation` (or passes `buildPorts` into the registry so each station gets
  its own state-bound implementations).

### 4.2 `tests/helpers/composition.mjs` (new)

Extract `makeManager`/`makeHost`/`start` from `tests/integration.test.mjs`:

```js
export async function start({ env = {}, beforeStart = true } = {}) {
  const host = makeHost();
  const wired = await activate(host.pi, env);
  const manager = makeManager();
  const ctx = { sessionManager: manager };
  // ... same session/agent/preparation boilerplate as integration.test.mjs
  return { host, ctx, registry: wired.registry, station: wired.registry.stationFor(ctx), tools: host.tools, commands: host.commands };
}
```

- This is the real `activate` path, including `resolveWiringPorts`, the registry,
  hooks, and tools.
- Ablation tests call `start({ env: { HERD_DISABLE_FOLDING: "1" } })` and drive
  the real hooks (`emit(host.handlers, "context", payload, ctx)`) or tool
  executes. They do not construct `SessionStation` directly and do not import
  feature modules.
- Keep a small `stationWith(ports)` helper only for pure unit tests, not for
  ablation acceptance.

### 4.3 Contract tests

Keep `defineContract` for pure implementation arithmetic (it catches shape
drift), but add one composition-root test per port. The contract test alone is
not evidence that the switch is wired.

## 5. Phase 2 — folding slice

### 5.1 Contract (recommended)

```js
export function foldingOn() {
  return {
    name: "on",
    foldable(receipts) { return foldableReceipts(receipts); },
    apply(messages, receipts, options) { return applyReceiptFolds(messages, receipts, options); },
  };
}

export function foldingOff() {
  return {
    name: "off",
    foldable() { return []; },
    apply(messages) { return { messages, collapsed: [] }; },
  };
}
```

No state. The station owns `receipts` and `messages`. `markCollapsed` stays in
`settleReceiptFolds` (state write).

### 5.2 Integration

`station.transformContext`:

```js
const folding = this.port("folding");
const foldable = folding.foldable(this.state.receipts);
if (foldable.length > 0) {
  const folded = folding.apply(messages, this.state.receipts, { foldable });
  messages = folded.messages;
  if (folded.collapsed.length > 0) this.settleReceiptFolds(folded.collapsed);
}
```

Remove `foldableReceipts` and `applyReceiptFolds` from the station imports.
`filterAmends` stays; it is amend, not folding.

### 5.3 Ablation test

Through `start({ env: { HERD_DISABLE_FOLDING: "1" } })`:

1. Build a branch with two receipt records at one level: an older one with a
   report and a younger one. Put both right-bracket `toolResult` messages in the
   context payload.
2. Emit the `context` hook.
3. `off`: the older text is unchanged (`FOLDED_MARKER` absent), `collapsed` stays
   false.
4. `on`: the older text contains `FOLDED_MARKER`, the younger receipt stays full,
   `collapsed` is true for the older id.

Also assert the station imported no feature module directly: the behavior comes
from the port object. The test must fail if `buildPorts` is removed or if
`transformContext` bypasses the port.

### 5.4 Ownership

- `src/features/folding/index.mjs`
- `src/station/station.mjs` (`transformContext`, imports) — one integrator owns
  this file
- `src/activation/ports.mjs`, `src/activation/index.mjs`, `src/station/registry.mjs`
- `tests/helpers/composition.mjs`
- `tests/ablation/folding.test.mjs`
- `tests/contract/folding-model-switch.test.mjs` (split folding from modelSwitch)

## 6. Phase 2 — clock slice

### 6.1 Contract (recommended)

```js
// on
start(record, budgetMs, startedAt) // deadlineAt = startedAt + budgetMs; clear pause/overtime
pause(record, now)                 // pauseClock
resume(record, now)                // resumeClock
info(record, now)                  // deadlineInfo
toolLimit(record, now)             // remaining + 1000, or 1000 in overtime, or null
bounded = true

// off
start(record)                      // deadlineAt = null; clear pause/overtime
pause/resume -> false
info -> { bounded: false }
toolLimit -> null
bounded = false
```

Stateless; the record is the single source of truth.

### 6.2 Pure arithmetic module

New `src/scope/clock.mjs`: move `pauseClock`, `resumeClock`, `deadlineInfo` and
the `toolLimit` arithmetic there. `src/scope/forkjoin.mjs` imports `deadlineInfo`
for `forkBudgetText`; `src/features/clock/index.mjs` imports the rest. Re-export
the moved names from `src/scope/index.mjs` so existing test imports keep working.
No cycle: `scope/clock` has no imports; `scope/forkjoin` -> `scope/clock`;
`features/clock` -> `scope/clock`.

### 6.3 Integration

- `registerFork` (`scope/forkjoin.mjs:60-125`): set `deadlineAt: null` and clear
  `overtimeAt`/`clockPausedAt`/`pausedMs`. Remove the inline deadline formula.
- `station/fork-controls.mjs:466`: after `registerFork`, call
  `station.port("clock").start(record, record.timeBudgetMs, record.startedAt)`.
  If `startedAt` is null, pass `Date.now()` explicitly; the current fork call
  site already supplies `startedAt: Date.now()`.
- `station.pauseBranchClock()` -> `this.port("clock").pause(this.branchRecord())`.
- `station.resumeBranchClock()` -> `this.port("clock").resume(...)`.
- `station.toolTimeLimit()` -> `this.port("clock").toolLimit(this.branchRecord())`.
- `forkBudgetText` stays as is; `deadlineAt = null` makes it omit time.

### 6.4 Ablation test

Through `start({ env: { HERD_DISABLE_CLOCK: "1" } })`:

1. Fork a child with `time: 1` (or call the real `scope_fork` tool).
2. Inspect the registered record: `deadlineAt` null; `toolTimeLimit()` null;
   `prepareToolDispatch(..., "read")` false; `pauseBranchClock()` false;
   `forkBudgetText(record)` has no `time` segment.
3. `on`: `deadlineAt` finite; `toolTimeLimit()` in `(0, 2000]`; gating true;
   pause/resume shifts the deadline; overtime path returns 1000 and stamps
   `overtimeAt`.
4. Reload: serialize/deserialize a state with a deadline; `on` preserves it,
   `off` starts null. (Existing `forkjoin-recovery` tests may need updating.)

### 6.5 Ownership

- `src/features/clock/index.mjs`
- `src/scope/clock.mjs` (new)
- `src/scope/forkjoin.mjs` (remove arithmetic; import display helper)
- `src/scope/index.mjs` (re-export)
- `src/station/fork-controls.mjs` (start clock after register)
- `src/station/station.mjs` (clock methods) — shared with folding; one integrator
- `tests/fork-tool-deadline.test.mjs` (update direct `registerFork` tests)
- `tests/ablation/clock.test.mjs`
- `tests/contract/clock.test.mjs` (update to the record contract)

## 7. DAG and file ownership

Nodes:

- A `ports-core` (integrator): `src/activation/ports.mjs` (new),
  `src/activation/index.mjs`, `src/station/registry.mjs`,
  `src/station/station.mjs` (constructor, `transformContext`, clock methods),
  `tests/helpers/composition.mjs`. Owns the `port(name)` API.
- B `folding` (worker): `src/features/folding/index.mjs`,
  `tests/ablation/folding.test.mjs`, folding half of the contract test. Depends
  on A's interface; does not edit `station.mjs`.
- C `clock` (worker): `src/features/clock/index.mjs`, `src/scope/clock.mjs`,
  `src/scope/forkjoin.mjs`, `src/scope/index.mjs`,
  `src/station/fork-controls.mjs`, `tests/ablation/clock.test.mjs`,
  `tests/fork-tool-deadline.test.mjs`, clock contract test. Depends on A's
  interface; does not edit `station.mjs`.
- D `red-contracts` (test worker): harness + ablation tests written before Green.
  Can run in parallel with A/B/C; owns only test files. If D and B/C both touch
  the same test file, split by file: D owns `tests/helpers/composition.mjs` and
  `tests/ablation/*`; B/C own implementation-specific existing tests.
- E `verify` (integrator): full `bun test tests`, `bunx eslint .`, smoke, seam
  fixes. Runs after A+B+C.

Edges: A -> B, A -> C, D parallel, B+C -> E. `station.mjs` has one writer (A/E);
B/C submit exact snippets or a patch to A. This avoids the shared-file conflict
that the current worktree already shows.

## 8. Open decisions and recommended defaults

1. Folding: redesign to receipt projection (recommended) or delete the port.
   Redesign if folding must be switchable; delete if it is core.
2. Clock: record policy (recommended) or delete the port. Record policy preserves
   persistence and gives `off` a real meaning.
3. Scope: delete the port (recommended). README says the three tools always
   exist; `bare` contradicts it. Implementing `bare` is a product change.
4. Relay/status/observer/modelSwitch: Phase 3. For each, either make the feature
   module the production factory or delete it. Do not leave a test-only parallel
   model.
5. `forkForFlow`: delete (no caller in `src` or `tests`) or rebuild ports for its
   own state. Recommend delete; it also hides shared state via `Object.create(this)`.
6. `nullTickets`: replace the silent no-op with an explicit capability refusal
   (`MISSING_TICKETS`) and use a real double in tests.
7. `directAmend` duplicate (`station.mjs:654/670`): delete one; enable
   `no-dupe-class-members`.
8. Fire-and-forget: `station.mjs:313` `void this.tickets.activateTools(...)` has
   no catch. Wrap it with `noteError`. Audit every `void this.tickets.*`.
9. `policy()` purity: move `syncTodo` dispatch out of `policy`; let the
   gatekeeper (`ensureTools` or `onBeforeAgentStart`) dispatch at the tail.
10. Context state writes: `settleReceiptFolds`/`maybeRebase`/`noteSentContext`
    run inside `transformContext`. They must finish before any dispatch and must
    not expose half-updated state. Treat `transformContext` as a Compute→Commit
    gatekeeper; document the order.

## 9. Verification commands

- `bun test tests`
- `bunx eslint .`
- `bun run smoke:relay`
- Focused: `bun test tests/ablation tests/fork-tool-deadline.test.mjs tests/contract/clock.test.mjs`
- Composition drift: `bun scripts/sync-plugin.mjs --check`

## 10. Residuals

- The `scope` port's README contradiction needs a product decision (delete vs
  implement bare).
- The relay/status/observer/modelSwitch implementations need contract redesign or
  deletion; this recon only maps the mismatch.
- The current worktree has uncommitted changes in `station.mjs`,
  `fork-controls.mjs`, `tickets.mjs`, and many tests. The Phase 2 workers must
  read the current tree, not HEAD, and must not revert those changes.
- `forkForFlow` has no caller but may be a reserved seam; confirm with git log
  before deleting.
