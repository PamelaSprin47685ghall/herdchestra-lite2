# Phase 1/2 contracts — written, not run

Owned by `contracts-phase12`. Source changes are owned by the implementation
slices. This file records the red contracts and the interfaces they assume.

## Test files

### `tests/station-purity.test.mjs`

| Case | What it proves | Red against current tree |
|---|---|---|
| `policy() is a query and never dispatches the todo grant` | `policy(ctx)` only returns the verdict; `ensureTools` is the only caller of `syncTodo` | yes: `policy` calls `syncTodo`, so `calls` is 1 |
| `ensureTools grants todo once per active tool set` | the grant stays idempotent when `policy` no longer dispatches | pending the first fix; fails if the move duplicates the grant |
| `a rejecting activateTools ticket is recorded, not left unhandled` | `syncTodo` uses a catch-all and records on the `tickets` domain | yes: current `void` leaves an unhandled rejection and no record |
| `a synchronous throw from the ticket capability is recorded, not thrown` | the catch-all also covers a synchronous throw from the capability | yes: current `syncTodo` rethrows |

The duplicate `directAmend` is enforced by ESLint, not by a runtime test:
`eslint.config.mjs` gains `"no-dupe-class-members": "error"`. That rule is the
red contract for the duplicate.

The `onContext` Compute→Commit change is behavior-preserving. It has no
consumer-visible case that can fail for a real user reason, so it is recorded
here as a refactor with the existing receipt/fold tests as the safety net. It
is not manufactured into a test.

### `tests/ablation/folding.test.mjs`

| Case | What it proves |
|---|---|
| `folding off is a real ablation: no receipt is shortenable` | `buildPorts({ HERD_FOLDING: "off" })` returns the off implementation; `foldable` is `[]`; `apply` returns the same message array and no `FOLDED_MARKER` |
| `folding on shortens the elder receipt through the same port` | the on implementation returns the elder receipt and `apply` replaces its text with `FOLDED_MARKER` |
| `the station's transformContext asks the injected folding implementation` | the station calls `registry.implementations().folding`; a fake implementation observes `foldable`, so an inline import cannot satisfy it |

### `tests/ablation/clock.test.mjs`

| Case | What it proves |
|---|---|
| `clock off is a real ablation: no deadline, no pause, no tool gate` | off leaves `deadlineAt=null`, `info()` is unbounded, `toolLimit()` is null, pause/resume are false |
| `clock on owns the deadline arithmetic` | start sets `deadlineAt`, info counts down, toolLimit is remaining+1s, pause freezes, resume shifts and records `pausedMs` |
| `registerFork no longer computes the deadline inline` | a registered record starts with `deadlineAt=null`; only `clock.start` fills it |
| `the station's clock methods ask the injected clock implementation` | `toolTimeLimit`/`pauseBranchClock`/`resumeBranchClock` call the injected clock object, not the inline arithmetic |

### `tests/clock-policy.test.mjs`

Pins the pure arithmetic in the new `src/scope/clock.mjs`: countdown,
deadline-as-overtime, unbounded, pause freeze, resume shift, repeated pause and
resume-without-pause no-ops.

### `tests/architecture/fire-and-forget.test.mjs`

Scans `src/station/**/*.mjs` for `void this.tickets.`. It is a ratchet; the
behavioral proof is in `tests/station-purity.test.mjs`.

## Intended interfaces

1. `src/activation/ports.mjs` — `buildPorts(env = process.env)` returns
   `{ ok: true, names, implementations }` or a refusal shape. `names` is the
   resolved implementation name per port; `implementations.folding` and
   `implementations.clock` are objects. `HERD_FOLDING=off` and
   `HERD_CLOCK=off` select off. The existing `HERD_DISABLE_FOLDING=1` /
   `HERD_DISABLE_CLOCK=1` form must keep working.
2. `src/features/folding/index.mjs` — `foldingOn()` / `foldingOff()` expose
   `foldable(receipts)` and `apply(messages, receipts, { foldable })` with the
   same result shapes as `foldableReceipts` / `applyReceiptFolds`;
   `FOLDING_IMPLEMENTATIONS = { on, off }`. The old `note/fold/kept` API is
   retired.
3. `src/scope/clock.mjs` — pure `pauseClock(record, now)`,
   `resumeClock(record, now)`, `deadlineInfo(record, now)`; plus
   `createClockOn(now = () => Date.now())` / `createClockOff()` exposing
   `start(record, budgetMs, startedAt)`, `pause(record, now)`,
   `resume(record, now)`, `info(record, now)`, `toolLimit(record, now)`;
   `CLOCK_IMPLEMENTATIONS = { on, off }`. Stateless: the record is the only
   state. Off means `deadlineAt=null`, `info().bounded=false`,
   `toolLimit()===null`.
4. `src/station/registry.mjs` — `createStationRegistry(..., { ports,
   implementations })` gains `implementations()` returning the object map;
   `ports()` still returns names. Backward compatible when `implementations`
   is absent.
5. `src/station/station.mjs` — `syncTodo` detaches through
   `dispatchFireAndForget(promise, label)`; `policy(ctx)` does not dispatch or
   mutate state; `transformContext` uses
   `this.registry.implementations()?.folding ?? foldingOn()`; clock methods use
   `this.registry.implementations()?.clock ?? createClockOn()`.

## Contract change for the ports-core slice

The existing resolver's two-implementation ports read only
`HERD_DISABLE_<PORT>=1`; `HERD_<PORT>=off` is ignored even though
`switchName()` names it. The ablation tests use the name form because it is the
port's own vocabulary. Extend `readSwitch` to honor `HERD_<PORT>=on|off` for
two-implementation ports, and keep the disable flag as the older form. Add the
corresponding cases to `tests/ports-resolve.test.mjs`; that file is owned by
the ports-core slice, not this one.

## Old tests owned by the implementation slices

- `tests/contract/folding-model-switch.test.mjs` — the folding half pins the
  retired `note/fold/kept` API and must be rewritten to `foldable/apply`. The
  modelSwitch half stays. Owned by the folding slice.
- `tests/contract/clock.test.mjs` — pins the retired keyed-map API
  (`start(scopeId, budget)`, `remaining(scopeId)`, `expired`, `bounded`,
  `clear`). Rewrite to the record policy. Owned by the clock slice.
- `tests/fork-tool-deadline.test.mjs` — constructs `registerFork` and expects a
  finite `deadlineAt` immediately. Start the clock through the station/port
  instead. Owned by the clock slice.
- `tests/forkjoin-recovery.test.mjs` — reload cases for a deadline. Owned by
  the clock slice.
- `tests/forkjoin-receipts.test.mjs` / `tests/forkjoin-transcript.test.mjs` —
  they use the pure `foldableReceipts`/`applyReceiptFolds` directly. They can
  stay as the arithmetic contract; the port delegates to the same functions.
- `tests/port-wiring.test.mjs` — pin/amend/herd only; no change.
- `tests/ports-resolve.test.mjs` — add the name-form cases described above.

## Verification ownership

The red tests were written, not run, per the dispatch. The implementation
slices run their focused files; the integrator runs `bun test tests` and
`bunx eslint .`. The full `activate()` composition harness
(`tests/helpers/composition.mjs`) is owned by the integration slice; before
Phase 2 closes it must add one end-to-end case per port so `buildPorts` is
proven to be the production path, not only a test factory.
