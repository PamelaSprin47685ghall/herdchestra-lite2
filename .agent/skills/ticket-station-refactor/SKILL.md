---
name: ticket-station-refactor
description: Design record for the whole-repository clean-break refactor that brings src/, host-omp/, and host-omp-ui/ back under the Ticket Station Method. Load before editing station wiring, fork context injection, scope ledgers, host process registries, or the manager/server split.
---

# Ticket Station refactor (clean break)

## Job

One artifact per fact, one owner per state. The station owns state and stays synchronous; a ticket owns every `await`; the wiring is a composition root and holds no decision. This record names the boundaries the refactor enforces and the evidence that they hold.

## Goal (user side)

A successor edits one module without learning a second convention. After the refactor:

- A station never grows a second way to receive a capability: one immutable context is injected at construction, and a missing capability fails closed at construction, not at first use.
- No module-level `WeakMap`, no `Symbol.for` carrier, no `globalThis[...]` slot outside one explicit process-registry object.
- A ticket never writes a station field: it calls a synchronous station method that commits.
- `src/scope/**` is statically free of `async`/`await` (no eslint exemption).

## Non-goals

- No compatibility shim, no dual-read of an old shape, no `-2` fallback path. Dead code is deleted, not kept dark.
- No behavior change in: error-code strings, ledger field names, receipt bytes (`capSignature`, `renderConsoleReceipt`), stop/nudge ordering, persistence versions, js beat semantics, or the `HOST_CONTRACT` key set.
- No new package-level export from `src/index.mjs` (it must stay exactly `export { createEngine } from "./engine.mjs";`).

## Selected and rejected alternatives

| Question | Selected | Rejected | Why rejected |
|---|---|---|---|
| Fork capability delivery | One immutable `ForkContext` injected at construction (`this.fork`) | 12 default lambdas patched after construction (`bindForkPorts`/`bindHostForkPorts`) | A capability set that is a function of time cannot be stated as an invariant; `childSpawnPort` failed at call time while other ports failed at construction |
| Process-wide sharing | `ForkProcess` value object held by the host slot and passed in | `Symbol.for(...)` on the ledger, module-level `RUNNING_BY_LEDGER`, lazy `defineProperty` WeakMaps | Four carriers, contradictory arbitration (`first-wins` vs `last-wins`), no single owner |
| Ledger runtime cache | Non-enumerable `Symbol` field on the ledger and record themselves | Module-level `ledgers`/`owners` WeakMaps | Hidden global state outside the aggregate, unreachable from the station's invariants |
| Host shape | Grouped shape only; `shapeHost({})` output unchanged | Keep the flat legacy bag beside the grouped one | Two conventions for one fact; only `tests/turn-wiring.test.mjs:74` consumed the flat key |
| Station size | Facade plus three pure domain cores (`usage-sample`, `directory-baseline`, `projection`) | Leave 1204 lines / ~62 methods, passing `this` to free functions | Handing `this` to a free function exposes every internal field to a sibling module |
| Receipt pricing | One `childReceiptText(spec)` render used for both price and send | `priceFor()` renders, `spec.receipt` renders again, `withProfession` splices by line index | Pricing a different record than the one sent is a defect this repo already forbids |
| Skill records | `tests/architecture/skill-records.test.mjs` asserts every backticked path exists | Leave `.agent/skills/**` unread by any test | A stale version claim ("snapshot goes to 2") survived because nothing read it |
| `failure()` unification | Keep three shapes and document them | Merge into `core/primitives.mjs` in this refactor | `primitives` nests `details`; `ledger-charge` spreads it flat and three consumers read `budget`/`forkId`/`tool` directly |

## Refused defaults

- "Smallest diff": a one-file patch that keeps a hidden global is larger than a three-file change that removes it.
- "Serialize the waves": independent slices on disjoint files ran in parallel; sequencing them would only add wall time.
- "Let the tests adapt": where a ratchet asserted a shape the refactor changes, the ratchet was rewritten in the same batch, never relaxed to make the change pass.
- "Add a migration path": an old snapshot is refused and the tree is rebuilt, as `fork-fsm-clean-break` already states.

## Bet and falsification

**Bet:** every violation reduces to one of four root causes — late capability injection, hidden global carriers, tickets writing station fields, and multi-responsibility modules — and removing those four restores the method without touching behavior.

**Falsified if** any of these fails after the refactor:

- `bun test tests` is not fully green, or a test had to be deleted or loosened rather than rewritten as a behavior assertion.
- `capSignature` changes for an unchanged state (two projections of one state differ).
- A parent fork and a child station stop sharing one registry/ledger/waiter set across extension instances.
- `bun run lint` reports `async`/`await` inside `src/scope/**` or `src/station/**`.

## Fatal assumptions

1. `mergeHost`'s missing-key defaulting is load-bearing test infrastructure. Fail-closed may apply only to the fork context and `IMPLEMENTATION_KEYS`, never to the host bag, or ~20 fork tests break.
2. `station.mjs` must keep the literal string `toolCallLedger` (a ratchet asserts it) and must never contain `this.processed =`, `this.dispatch =`, or `this.toolGate =`.
3. `src/core/host-shape.mjs` must not sit under a `host/` path segment: `core-host-free` refuses any `(^|/)host/` specifier and any `ctx.` member access in `src/`.
4. The host package takes exactly one symbol from the core (`createEngine`). A read-only-subagent token must travel as `policy()` data or inside `HOST_CONTRACT`, never as a new package export.
5. `activation-bag.test.mjs` pins both `first-wins` on the fork-wiring slot and cross-engine reuse; any replacement carrier must be one explicit object that preserves both.

## Module boundaries

```text
src/core/primitives.mjs         # isPlainObject, isLocalPlainObject, failure, put, copyCounts,
                                # isNonEmptyString, validBudget, normalizeBudget, roundAmount,
                                # formatCents, formatUnits. Zero imports.
src/core/host-shape.mjs         # shapeHost/mergeHost, grouped shape only (moved out of station.mjs)
src/scope/ledger-*.mjs          # ledger state machine, serialization, charge; the runtime cache is a
                                # non-enumerable Symbol on the ledger and on each record
src/scope/ledger-brackets.mjs   # BRACKET_LEDGER_VERSION = 3 (ledgerShapeOk accepts 3)
src/scope/state.mjs             # STATE_VERSION = 2 (exported once as VERSION)
src/scope/entry-plan.mjs        # STATE_ENTRY_VERSION = 3 — three numbers, three homes
src/station/domain/fork-context.mjs    # immutable ForkContext; a missing capability throws at build
src/station/domain/fork-context.mjs    # ForkProcess: registry + ledgerByConversation + runningByLedger
                                       # + states, one explicit object on the wiring; no Symbol.for
                                       # carrier, no module-level table. A display holder is not
                                       # process state: a display belongs to one station.
src/station/domain/{usage-sample,directory-baseline,projection,rewind,host-boundary}.mjs
src/station/domain/tool-call-ledger.mjs # tool-call bookkeeping core (createToolCallLedger), owned by the station
src/station/errors.mjs                 # one CODE -> {doc, vars, detail} table; three handlers share refuse()
src/tools/join-wait.mjs                # park/waitForReady — the async half of the fork registry
src/wiring/fork-wiring.mjs             # binds a ForkProcess plus host wiring; no decision, no global
host-omp/src/host/process-registry.mjs # one object, one arbitration table (firstWins/lastWins/clearOnRoot)
host-omp-ui/src/manager/{station,server}.mjs and manager/tickets/*
host-omp-ui/src/station/domain/{delta-merger,protocol-codec,ticket-result}.mjs
```

## Consumer contracts

- **Station construction:** `new SessionStation(manager, pi, tickets, registry, pricing)` still receives `registry` as its fourth argument (`tests/helpers/station-ports.mjs` depends on it). `this.fork` is the only fork capability surface.
- **`SessionStation.prototype.policy`** stays callable with a bare object that supplies `fork.ownerId`, `agentPolicy`, and `sessionView`.
- **Host bag:** grouped shape only; the 22 keys of `HOST_CONTRACT` minus `ENGINE_ONLY_HOST_KEYS` are exactly what `shapeHost({})` returns.
- **Fork ledger selection:** `selectForkLedger({identity, indexed, restored, create})` returns `{ledger, source, filled, adopt}`; the wiring calls it and honors `adopt`, deciding nothing itself.
- **Join:** one `joinEnvelope(station, record)` and one render entry point; `finalizeJoin` keeps its `(toolCallId, record)` signature (three test doubles call it, one on the prototype).
- **UI frames:** `SERVER_FRAMES` (14 names) plus the four direct frames (`command.pending`, `command.result`, `history.page`, `client.error`) must each have a `case` in `host-omp-ui/web/src/protocol/{store.ts,reducers/frames.ts}` (`tests/host-omp-ui/frame-vocabulary.test.mjs`).

## Edit-tool safety rule

An `edit` with fuzzy matching swallows whatever follows the anchor. Anchoring on a bare identifier deleted the next token twice in this refactor: `export function restoreLedger(` lost `value) {`, and `const STOP_AFTER_HANDLER` lost its initializer.

**Rule:** every `old_string` and `new_string` must contain the target statement in full form — the parameter list through its closing `) {`, the initializer through its `;`. Never end an anchor on an identifier.

## Dispatch waves

| Wave | Scope | Independent slices |
|---|---|---|
| 1 | core primitives, ledger purification, wait split, UI bridge, manager split | 5 editors on disjoint files |
| 2A | ForkContext + ForkProcess, station split, errors table, receipts, host process-registry, skill records | parallel; the shared contract is the module list above |
| 2B | verification | one devops run of lint plus the full suite |

## Verification ownership

- Each editor slice reports "not tested yet" with the exact command and the condition it needs.
- The lead runs `bun run lint && bun test tests` after the last edit of a wave and records the counts (baseline 2148 pass / 226 files; after Wave 1: 2151 pass / 227 files).
- A green wave is a receipt, not a discovery: a check that cannot change the next move is not run.

## Residuals

- Three `failure()` shapes remain (`primitives` nests `details`, `ledger-charge` spreads it flat, `state`/`fork-registry` take two arguments). Merging needs the full reader list first.
- `validBudget` in `src/scope/turns.mjs` still duplicates `core/primitives.mjs`; one consumer points at it. The former src/scope/plain.mjs has been deleted.
- `manager/session-service.mjs` bounds both `inFlight` and `newFlights` with a deadline (`withDeadline`).
- `host-omp/src/host/branch-session.mjs` and `child-display.mjs` are partly split (`branch/refusals.mjs`, `child-display/tool-tray.mjs`); their remaining roles still share one file.
- `.agent/skills/**` is now read by `skill-records.test.mjs` for path existence only; prose drift is still caught by review, not by a test.
