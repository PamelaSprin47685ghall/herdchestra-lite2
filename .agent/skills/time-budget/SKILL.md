---
name: time-budget
description: How fork wall-clock budgets are derived from the session's two sufficient turn statistics instead of being supplied by the model.
---

# Time budget

## Boundary

`src/scope/turn-stats.mjs` is a pure synchronous scope module. It reads or
mutates plain objects and does no I/O, awaits nothing, and imports no station.
The station owns the live request clock; the ledger owns the persisted totals.

The fork wall clock stays a property of the fork record
(`timeBudgetMs`, `deadlineAt`). This skill changes only who computes
`timeBudgetMs`: the system, not the model.

## Unit and formula

- One turn is one LLM request.
- `ledger.totals = { turnMs, turns }` is the only stored timing state:
  - `turnMs` is the sum of every scope's completed LLM request duration. Two
    scopes running at once each add their own duration, so concurrency grows
    the total by the number of active scopes, not by wall-clock once.
  - `turns` is the number of completed LLM requests across all scopes.
- `avgTurnMs = turnMs / turns`; with no completed turn it is `null`.
- `points = sum of the fork item's finite positive budget values`.
- `timeBudgetMs = 1000 * max(1, round(avgTurnMs / 1000 * points))`.
  - No sample: use `DEFAULT_TURN_MS` (60 000) in place of the average.
  - Empty or zero-point budget: the minimum is one second.

An open request plus the assistant message that answers it is one turn.
Missing usage does not disqualify it. A gate message that never opened a
provider request has no window, so it does not count.

## Event flow

1. `before_provider_request` (or the station's provider-request hook): call
   `beginRequest(clock, now)`. A second begin while a request is in flight does
   not reset the start.
2. The assistant message that completes that request: call
   `finishRequest(clock, totals, now)`. Usage is not required. The station
   records the message object and ignores a later `message_end` of the same
   object, so a late copy cannot close the next request. A non-assistant
   `message_end` is ignored.
3. `session_stop`, and `before_agent_start` of the next agent turn, call
   `abandonRequest(clock)`. In-flight time is not stored. `before_agent_start`
   runs before the next `before_provider_request`, so it drops a failed
   window and cannot erase a request that already finished.
4. `handleForkCall`: call `deriveTimeBudgetSeconds({ totals, budget })`, pass
   the seconds into `registerFork`, and put the same value in the child spec.

The request clock (`{ startedAt }`) is in memory only. A reload therefore
abandons the partial request instead of counting process downtime.

## Persistence and reload

`state.brackets` is the one ledger shared by reference across all scopes and
persisted with the root state. `createBracketLedger` initializes
`totals`; `validLedger` accepts a legacy ledger without it; the serializer
copies it; `restoreLedgerChecked` restores it. Missing totals read as
`{ turnMs: 0, turns: 0 }`, so no state version bump is needed.

Do not store the in-flight clock or per-request samples. The two totals are
sufficient statistics and the whole point of the design.

On reload the live index can be empty while the restored ledger has samples
and no open forks (`order` is empty). Ledger choice stays tree-first; when the
chosen ledger has no samples, the two totals are carried onto it from the
other candidate. Two sampled ledgers are never summed or overwritten, so a
reload cannot double count.

## Tests

- `tests/turn-stats.test.mjs`: pure module, explicit `now`, concurrency,
  idempotent finish, abandon, normalization, point sum, rounding, minimum,
  fallback, empty budget.
- `tests/fork-derived-time.test.mjs`: `handleForkCall` derives 80s from
  `{turnMs: 40000, turns: 2}` and four points; fallback 120s; `validateFork`
  accepts an item without `time`; the tool schema drops `time`; fork copy does
  not ask for a wall clock. Harness: a station stub with `state`, 
  `forkLedgerPort`, and `childSpawnPort`, following
  `tests/fork-budget-birth.test.mjs`.

- `tests/turn-wiring.test.mjs`: ledger round-trip and legacy `0/0`,
  double delivery, non-assistant ignore, `session_stop` / `before_agent_start`
  abandon, two stations writing one ledger, and the reload case where an
  empty `order` must not erase the recovered totals.

The implementation is in place. `bun test tests` and `bun run lint` are the
green check.

## Risks

- Only LLM request latency is measured; tool execution time is not. The
  derived wall clock can therefore be shorter than a scope's real busy time.
- No sample yet means the 60s default per point; the first forks are the
  least calibrated.
- Repeated host delivery of one assistant message must not add a second turn.
  `startedAt` stops a second finish of the same window. A `WeakSet` of counted
  message objects stops a late `message_end` from closing the next request.
- A read-only subagent counts when the host opens a provider request and later
  delivers that assistant message through `message_end`. `assistant_message`
  itself returns early for that policy, so the dedicated listener is the path.
  A read-only message with no open window does not count.
- Totals grow only when the root ledger is persisted. A crash between a
  child's finish and the next persist loses that increment.
