---
name: scope-context
description: Design record for the scope_context merge: one working-level tool carrying optional pin and amend halves.
---

# scope_context

`pin` and `amend` were two registered tools with nearly identical shape: both
are free, both write bookkeeping rather than project state, and both belong to
the same working-level moment. They are now one tool so the family stays under
one `scope_` prefix, and so the model chooses the bookkeeping move inside one
schema.

## Boundary

| Layer | Owns |
|---|---|
| `resources/prompts/tools/notes.md` | The prose: one tool sentence, then the pin and amend judgment attached to the two parameter objects |
| `src/tools/descriptions.mjs` | `SCOPE_CONTEXT_DESCRIPTION` (one sentence) and `scopeContextParameters` (two optional objects, top-level `anyOf`) |
| `src/activation/tools.mjs` | One `registerTool` call, `loadMode: "essential"` |
| `src/tools/tickets.mjs` | `scopeContextTicket`: refuses an empty call, wraps a throw, delegates to the station |
| `src/station/execute.mjs` | `executeContext`: synchronous composition, derived cache keys, partial-failure result |
| `src/features/pin/`, `src/features/amend/` | Unchanged ports. The merge never touched the state they own |
| `src/scope/state.mjs`, `src/core/policy.mjs` | Free and read-tier membership; the retired names stay listed for old persisted data |

## Decisions

- **Order.** Amend runs before pin. Its refund must be in the ledger before the
  note that may describe the outcome; the reverse order would let a successful
  note sit beside a refund that never landed.
- **Derived cache keys.** The station's processed cache is keyed by tool-call
  id. One physical call carries two halves, so each half uses
  `<id>#amend` / `<id>#pin`. The outer id still caches the composite result so a
  host retry short-circuits.
- **Direct-amend compatibility.** `decideToolCall` still runs the amend half
  before the ordinary calls of the message, because the refund must be visible
  when the model reads the results. That path caches under the real id; the
  composite reads that entry instead of amending twice.
- **Partial failure.** A failed amend does not cancel a pin, and vice versa.
  The combined result is `isError` with `details.code: "scope_context-partial"`
  and both halves' text, so the model sees which one landed.
- **Legacy.** Retired names stay in `CONTROL_TOOLS`, `SCOPE_TOOLS`,
  `NEUTRAL_TOOL_NAMES`, and the replay renderer. They are never registered, but
  an old transcript or a persisted `session_init` still names them, and both
  must keep working. The station scan reads `amend` directly and `scope_context`
  through its `amend` object.

## Tests

- `tests/scope-context.test.mjs`: registration, schema shape, both-halves order
  and keys, retry, direct-amend reuse, partial failure.
- `tests/pin-tool.test.mjs`: argument validation and persistence, retargeted to
  `scopeContextParameters.properties.pin` and `scopeContextTicket`.
- `tests/station/domain/tool-call.test.mjs`: free control tool, amend routing,
  JSON-string input, pin-only has no direct amend.
- `tests/forkjoin-transcript.test.mjs`: both halves render; a pin-only receipt
  is dropped, an amend receipt is kept; the legacy `[pin]` line still renders.
- `tests/branch-charge.test.mjs`, `tests/fork-panhandle.test.mjs`: the free
  tool name in charging and panhandle refusal.

## Open

- The replay line for a combined call is two lines (`[pin]…`, `[amend]…`). If a
  reader needs the combined receipt's refund number in the child record, the
  amend receipt line already carries it and is kept.
