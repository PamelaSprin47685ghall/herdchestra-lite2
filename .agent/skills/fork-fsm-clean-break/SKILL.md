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
| Tool schema | `fsm` | `src/tools/descriptions.mjs` — already correct, do not touch |
| Receipt template | `{{fsm}}` | `resources/prompts/receipts/scope.md`, `resources/prompts/tools/fork-join.md` |
| Render key | `fsm` | passed to `render(...)` / `childReceiptText(...)` |
| Queue of later texts | `requirements[]` | keeps its name: it is a queue of fsm texts, not one fsm |
| Error codes | `INVALID_FSM`, `missing-fsm` | already correct, do not touch |

### Do not rename

- `src/station/gates.mjs`, `src/station/domain/tool-call.mjs`, `resources/prompts/skills/constitution/SKILL.md` — there `intent` is the plain English word.
- `host-omp-ui/web/**` and `tests/host-omp-ui/**` — `ScrollIntent` is a different concept.

## Ledger

Snapshot version goes to `2`. `validRecord` requires a non-empty `record.fsm`, with **no** `?? record.intent` fallback. A version-1 snapshot takes the existing reset path (`{ ok: false, ledger: createBracketLedger() }`) and must not throw. `fork-registry`'s identity map is memory-only; it needs no compatibility work.

## Pricing

`receiptChars: number[]` becomes `pricedChars[i]`, one record per fork item:

| Key | Value | Sends |
|---|---|---|
| `fresh` | `childReceiptText(...)` for this fork's own data | first receipt to a new child |
| `revive` | `childReceiptText(...)` for the blocked **target's** fsm, budget, and targets | receipt to a woken checkpoint |
| `generation` | `generationReceiptText(...)` including `priorRecordText(target)` | receipt to the next generation; the largest text in the system and unbounded in length |
| any path that sends nothing (running amendment, queued item, blocked item) | `0` for all three keys | — |

Each non-zero value is the character count of that rendered text plus the identity line. Identity is resolved exactly as the send path resolves it: `(item.profession ?? fork.profession ?? "").trim()`, then `length + 1` when non-empty, else `0`. A value priced from a different record than the one that gets sent is a defect, not an approximation.

## Admission coverage

`decideRegister` resolves each item's action first, then picks the number with **the same predicate** that picks the send path; it skips an item only when that number is `0`. The pricing side must not keep a second action judgement. If the domain's existing action vocabulary differs from `fresh` / `revive` / `generation`, keep the domain's words as the object keys — the invariant is one number per receipt-sending path, chosen by the send-side predicate.

## Constants removed

`FORK_RECEIPT_PREFIX_CHARS` and `JOIN_RECEIPT_OVERHEAD_CHARS` are deleted together with their comments. Neither had a counterpart in the text that actually ships: the first double-counted fixed lines already inside `childReceiptText`, the second had no identifiable object at all. On the join side the envelope is measured as the length difference of the same serialization the harness performs; where no wrapper exists the envelope is `0`.

## Slice ownership

| Slice | Files |
|---|---|
| S1 | `src/scope/forkjoin.mjs`, `src/scope/fork-registry.mjs`, `src/station/domain/identity.mjs`, `src/station/domain/fork-join.mjs` |
| S2 | `src/station/fork-controls.mjs` (both constant removals, `pricedChars` production side, send path) |
| S3 | `resources/prompts/**` placeholders and copy (`{{intent}}` → `{{fsm}}`) |
| T1, T2 | `tests/**` mechanical rename and the new cases |

S1 also owns the paragraph in `.agent/skills/scope-orchestration/SKILL.md` that still claims "the ledger record keeps `intent`" — after this change the record keeps `fsm` and `validateFork` normalizes nothing.

## Acceptance

- A refused fork reports `FORK_CONTEXT_EXCEEDED` with numbers that contain no `600`.
- A reused `scopeId` whose prior record does not fit the window is refused at registration, instead of letting the child hit the wall on its first request.
- `git grep '\bintent\b' src/ resources/` returns only the whitelist above.

Every later slice reads this record and invents no third naming.
