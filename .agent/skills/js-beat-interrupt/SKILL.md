# js beat interrupt

## Job

One `js` tool call is one **beat**. The beat decides how a host interrupt is handled from the operations actually in flight, never from the tool name or the script text.

## Vocabulary

- **op**: one `api.*` call inside the beat.
- **park**: a pure wait with no side effect that cancellation would destroy: `scope_join`, `scope_request`, `wait`, `ask`.
- **work**: everything else, including `bash`, `read`, `write`, `edit`, `eval`, `task`, and unknown names. Default is work.
- **soft**: `signal.reason === Symbol.for("pi-agent-core.tool-interrupt")` — a queued user message (steer channel).
- **explicit**: every other reason — `REQUEST_INTERRUPT_REASON`, cascade, user abort, unknown.

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
4. A new park throws `BEAT_NO_MORE_WAITS` without dispatch.
5. Script completed: script value, `details.beat.decision = "steer"`. Script killed by its cancelled park: `isError`, `details.code = "JS_STEERED"`.
6. `finishJsCall` exactly once.

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

- `src/tools/beat.mjs` — pure state machine: classification, decision, op controllers, closing race.
- `src/tools/js-ticket.mjs` — beat lifecycle; dispatch always receives `op.signal`, never the host signal.
- `src/tools/tickets.mjs` — join park ids and `scope_request` signal.
- `src/station/station.mjs`, `src/station/request-controls.mjs` — request signal, cancellation, `REQUEST_INTERRUPTED`.
- `src/scope/request-queue.mjs` — `parked` is a `Set` of park ids, merged and removed per id.
- `src/scope/fork-registry.mjs` — unchanged: it already observes the op signal at the park.
- `host-omp/src/activation/hooks.mjs` — root runtime: idle + wake; the beat flips it to running/idle.

## Test map

`tests/js-beat-interrupt.test.mjs` is the acceptance contract. It pins the matrix above, the closing race for a never-settling Promise, local late refusals, exactly-once reconcile, request cancellation, root reachability, and `parked` as a Set.

## Known boundary

A synchronous CPU loop cannot be preempted: JavaScript runs it to completion before any abort handler can run. The beat makes every `await` return, including a bare Promise that never settles; it cannot make a busy loop yield. Do not pretend otherwise in docs or tests.
