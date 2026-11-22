---
name: scope-id-reuse
description: Domain contract for reusing an existing scopeId to amend budget and requirements instead of creating a second scope.
---

# Scope id reuse

## Acceptance

`scope_fork` with an existing `scopeId` amends that scope: it adds tool points and seconds, appends the new intent to `requirements`, and reports the target fork. A name owned by another owner is refused; a missing name creates a new scope.

## States

`running | ready | joined | failed | blocked`. Records live for the session.

- **running**: `amendFork` adds budget/time in place and queues the requirement.
- **blocked**: same arithmetic, status stays `blocked`; the station flips it to `running` when it spawns.
- **ready**: `supersedeFork` marks `supersededAt` and removes it from the ready queue; the station opens the next generation.
- **joined / failed**: not reopened in place (that would corrupt `closeSeq` / `assertPairing`); the station opens the next generation.

## Ownership

Same `scopeId` (case-insensitive, session-wide) and same `ownerId` = amend. Different owner = `FOREIGN_SCOPE_ID`. Unknown = create.

## Record fields

`generation` (default 1), `continuesForkId` (default null), `requirements[]` (default `[]`), `requirementsDelivered` (default 0), `supersededAt` (default null).

`registerFork` accepts `generation` and `continuesForkId`.

## Budget arithmetic

`grantBudget(record, { tools, seconds }, options)` holds the caps (8 points per tool, 300 seconds per call, free tools refused). `applyPanhandle` delegates to it and keeps the `panhandles[]` history. Amend reuses the same caps; a fork spec's own budget is still the birth grant and is not capped by panhandle limits.

## API

- `decideRegister(...)` → `{ ok, action: 'create' | 'amend', targetForkId?, record? }`, plus `items[]` carrying `action`/`targetForkId`. Picks the live record with the greatest `generation`, skipping `supersededAt`.
- `amendFork(ledger, forkId, { budget?, intent?, targets?, seconds?, now? })` → `{ ok, added: { tools, seconds }, queued, status }` or a failure: `UNKNOWN_FORK`, `FORK_CLOSED`, cap failures (`PANHANDLE_TOOL_LIMIT`, `PANHANDLE_SECONDS_LIMIT`, `PANHANDLE_INVALID_TOOLS`, `PANHANDLE_INVALID_SECONDS`, `PANHANDLE_FREE_TOOL`, `PANHANDLE_EMPTY`, `PANHANDLE_CLOCK_OFF`).
- `supersedeFork(ledger, forkId, now)` → `{ ok, record }`; only `ready` is superseded.
- `liveRecordForScope(records, scopeId)` → the newest non-superseded record or null.

## Pairing invariants

A superseded record is never queued, never received, and never counted as an open child. `assertPairing` must stay green after supersede + join; a joined record keeps its `closeSeq`/`closedOrder`.

## Tests

- `tests/station/domain/fork-join.test.mjs` — duplicate becomes amend; foreign owner refused.
- `tests/fork-reuse-domain.test.mjs` — amend running/blocked/closed, supersede queue removal, live lookup, caps, pairing.
