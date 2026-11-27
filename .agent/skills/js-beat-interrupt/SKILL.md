---
name: js-beat-interrupt
description: One js tool call is one beat. Load before editing the park/work classification or the soft/explicit interrupt decision matrix in src/tools/beat.mjs and src/tools/js-ticket.mjs.
---

# js beat interrupt

## Job

One `js` tool call is one **beat**. The beat decides how a host interrupt is handled from the operations actually in flight, never from the tool name or the script text.

## Vocabulary

- **op**: one `api.*` call inside the beat.
- **park**: a pure wait with no side effect that cancellation would destroy: `scope_join`, `wait`, `ask`.
- **work**: everything else, including `bash`, `read`, `write`, `edit`, `eval`, `task`, and unknown names. Default is work.
- **soft**: `signal.reason === Symbol.for("pi-agent-core.tool-interrupt")` — a queued user message (steer channel).
- **explicit**: every other reason — user abort (Esc), cascade, host abort, unknown.

## Decision (once, idempotent)

| in flight | soft | explicit |
|---|---|---|
| any work | **steer** | **interrupt** |
| only parks | **interrupt** | **interrupt** |
| nothing | **interrupt** | **interrupt** |

So `bash + bash = steer`, `bash + join = steer`, `join + join = interrupt`, `join = interrupt`, and an explicit interrupt always forces through work.

## Interrupt

1. `closed = true`; abort every live op with the host reason.
2. Resolve `closing`; the ticket races the script against it and returns without waiting.
3. Result `isError`, `details.code = "JS_INTERRUPTED"`, `details.beat` present.
4. Any later `api.*` throws `BEAT_CLOSED`, dispatches nothing, costs nothing, increments `lateCalls`.
5. `finishJsCall` runs exactly once. Every op abandoned mid-flight gets a terminal `innerCalls` entry.

## Steer

1. `parksAllowed = false`; abort only park ops; work keeps its own signal.
2. Do not resolve `closing`; the script finishes naturally.
3. After the script settles, wait for surviving work ops; late results land in `innerCalls`.
4. A new call after the steer is refused without dispatch: a park throws `BEAT_NO_MORE_WAITS`, work throws `BEAT_STEERED`. The script cannot start a second wave of work after giving the turn up.
5. If the script outlives its work on a bare Promise, a second release arms: once every surviving work op settled and one macrotask yielded, `steerClosing` resolves. A script that finishes inside that window wins and keeps its value; one still parked is released as `isError`, `details.code = "JS_STEERED"`.
6. Script completed: script value, `details.beat.decision = "steer"`. Script killed by its cancelled park: `isError`, `details.code = "JS_STEERED"`.
7. `finishJsCall` exactly once.

## Result contract

```js
details.beat = {
  decision: null | "interrupt" | "steer",
  reason: null | "soft" | "explicit",
  abortReason: string,
  inFlight: [{ name, cls }],
  lateCalls: number,
  orphanWork: number,
}
```

`details.beat` is a live object: a late refusal after the tool returned still increments `lateCalls`.

## Files

- `src/tools/beat.mjs` — pure state machine: classification, decision, op controllers, `closing` and `steerClosing`, `rejectIfClosed`.
- `src/tools/js-ticket.mjs` — beat lifecycle; dispatch always receives `op.signal`, never the host signal.
- `src/tools/tickets.mjs` — join park ids.
- `src/scope/fork-registry.mjs` — observes the op signal at the park.
- `src/station/station.mjs` (`shapeHost`) — forwards a grouped `session.abort` to the host agent and keeps the legacy flat `sessionFor` lookup as the fallback. Dropping the grouped form made every root interrupt a silent no-op.

## Test map

`tests/js-beat-interrupt.test.mjs` is the acceptance contract. It pins the matrix above, the closing race for a never-settling Promise, local late refusals, exactly-once reconcile, and late-work accounting.

## Dispatch record

- The red contract `tests/js-beat-interrupt.test.mjs` was written first and not run.
- Implementation: `beat.mjs`; the `js-ticket` lifecycle; `steerClosing`; `BEAT_STEERED`.
- Second pass after adversarial review: `steerClosing` (a steer cannot hang on a bare Promise), `BEAT_STEERED` for new work after a steer, late-work accounting, and refusal ordering (`BEAT_CLOSED` before `halted`).
- Verification: `tests/js-beat-interrupt.test.mjs`; the full `bun test tests` suite (2144 pass, 2 skip, 0 fail); `bun run lint` clean; the review reproducer now returns `{"settled":true,"code":"JS_STEERED"}`.

## Known boundary

A synchronous CPU loop cannot be preempted: JavaScript runs it to completion before any abort handler can run. The beat makes every `await` return, including a bare Promise that never settles; it cannot make a busy loop yield. Do not pretend otherwise in docs or tests.
