---
name: fork-fsm-clean-break
description: Design record for the fork/join clean break — one vocabulary (`fsm`) for the fork's state-machine text, and receipt-length estimates that measure only the text actually sent. Load before touching fork field naming, the ledger snapshot format, receipt rendering, or context admission.
---

# Fork fsm clean break

## Job

One word for the fork's state-machine text: `fsm`. One rule for receipt pricing: a path is priced by the length of the text it will actually send, never by a constant.

## Non-goal

No `intent` alias, no dual-read, no compatibility shim. An old snapshot is rejected and the ledger is rebuilt; it is not migrated half-way.

## Vocabulary

| Place | Name | Note |
|---|---|---|
| Ledger record | `record.fsm` | required, non-empty |
| In-memory identity | `identity.fsm` | `src/scope/fork-registry.mjs`, `src/station/domain/identity.mjs` |
| Spawn spec | `spec.fsm` | same information, third copy — must change in the same batch |
| Domain request | `s.fsm` | `validateFork` reads it directly; no normalization step |
| Tool schema | `fsm` | `resources/prompts/tools/fork-join.md`, injected by `src/prompts/inject.mjs` — already correct, do not touch |
| Receipt template | `{{fsm}}` | `resources/prompts/receipts/scope.md`, `resources/prompts/tools/fork-join.md` |
| Render key | `fsm` | passed to `render(...)` / `childReceiptText(...)` |
| Queue of later texts | `requirements[]` | keeps its name: it is a queue of fsm texts, not one fsm |
| Error codes | `INVALID_FSM`, `missing-fsm` | already correct, do not touch |

### Do not rename

- `src/station/gates.mjs`, `src/station/domain/tool-call-ledger.mjs`, `resources/prompts/features.md` (`constitution.core` / `constitution.full`) — there `intent` is the plain English word.
- `host-omp-ui/web/**` and `tests/host-omp-ui/**` — `ScrollIntent` is a different concept.

## Ledger

Three version numbers exist and must never be conflated:

| Constant | Value | Where |
|---|---|---|
| `BRACKET_LEDGER_VERSION` (returned as `createBracketLedger().version`) | `3` | `src/scope/ledger-brackets.mjs`; `ledgerShapeOk` accepts `3` only |
| `STATE_VERSION` (exported once as `VERSION`) | `2` | `src/scope/state.mjs` — the scope state shape's own number |
| `STATE_ENTRY_VERSION` | `3` | `src/scope/entry-plan.mjs` — the journal envelope, readable `[2, 3]` |

An older ledger snapshot takes the reset path (`{ ok: false, ledger: createBracketLedger() }`) and must not throw: it is refused, never migrated. `validRecord` requires a non-empty `record.fsm`, with **no** `?? record.intent` fallback. `fork-registry`'s identity map is memory-only; it needs no compatibility work.

## Pricing

One receipt render, one number. `childReceiptText(spec)` emits the whole text — identity line included — and both the price and the send path use that same return value:

- `priceFor(item)` returns `{ fresh: childReceiptText(specOf(item)).length }`.
- `spec.receipt` is `childReceiptText(specOf(item))`, the same string.
- The identity line is rendered inside `childReceiptText` from `(item.profession ?? fork.profession ?? "").trim()`, then `length + 1` when non-empty, else `0`. There is no `withProfession` splice and no separate `identityCharsOf`.

A value priced from a different record than the one that gets sent is a defect, not an approximation. The checkpoint-era three-tier table (`fresh` / `revive` / `generation`) and its `pricedChars[i]` record are retired: `forkReceiptPath` returns `fresh` only, and the send path has no second render.

## Admission coverage

`decideRegister` takes the single `priceFor(item)` and skips an item only when that number is `0`; the send-side predicate is the same one. The pricing side keeps no second action judgement, and one number covers the one receipt that ships.

## Constants removed

`FORK_RECEIPT_PREFIX_CHARS` and `JOIN_RECEIPT_OVERHEAD_CHARS` are deleted together with their comments. Neither had a counterpart in the text that actually ships: the first double-counted fixed lines already inside `childReceiptText`, the second had no identifiable object at all. On the join side the envelope is measured as the length difference of the same serialization the harness performs; where no wrapper exists the envelope is `0`.

## Slice ownership

| Slice | Files |
|---|---|
| S1 | `src/scope/ledger-brackets.mjs`, `src/scope/ledger-serialize.mjs`, `src/scope/ledger-charge.mjs`, `src/scope/ledger-cache.mjs` (the facade that re-exported them is deleted; callers import the leaves); `src/scope/fork-registry.mjs`, `src/station/domain/identity.mjs`, `src/station/domain/fork-join.mjs` |
| S2 | `src/station/fork-controls.mjs` (facade) and `src/station/fork-reads.mjs` (both constant removals, one `priceFor`, one `childReceiptText` render shared by price and send) |
| S3 | `resources/prompts/**` placeholders and copy (`{{intent}}` → `{{fsm}}`) |
| T1, T2 | `tests/**` mechanical rename and the new cases |

S1 also owns the paragraph in `.agent/skills/scope-orchestration/SKILL.md` that still claims "the ledger record keeps `intent`" — after this change the record keeps `fsm` and `validateFork` normalizes nothing.

## Acceptance

- A refused fork reports `FORK_CONTEXT_EXCEEDED` with numbers that contain no `600`.
- A reused `scopeId` whose prior record does not fit the window is refused at registration, instead of letting the started scope hit the wall on its first request.
- `git grep '\bintent\b' src/ resources/` returns only the whitelist above.

Every later slice reads this record and invents no third naming.
