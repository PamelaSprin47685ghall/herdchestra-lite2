---
name: scope-orchestration
description: Design record for herdchestra-lite2 scope orchestration. Load before changing fork, join, return, panhandle, or scope identity behavior, or when explaining why a scope is sized or split as it is.
---

# Scope Orchestration

The user-facing account is `README.md`; the code is authoritative for every number. This page owns the boundaries and the reasons they hold.

## Boundaries

- **Root** is outside all scopes. It plans, forks, joins, and answers. It has no tool budget or clock, so ordinary tools run in a child.
- **Station** owns state and stays synchronous; **Ticket** owns waiting and is the only place `await` runs. Fork, join, and return follow the same split.
- **Identity** is `scopeId`. A reused id is an upsert: `running` and `blocked` take budget increments, one more requirement, and merged targets; `ready` supersedes and starts the next generation; `joined` and `failed` start a new generation with the old record as history.
- **Records are frozen in the ledger.** The tool surface resolves a `scopeId` to its latest generation only; an older generation has no public query.
- **The model surface names the contract `fsm`; the ledger record keeps `intent`.** `validateFork` reads the new field and normalizes it to `intent`, so snapshots, `validRecord`, and the station domain stay unchanged. The text describes the work as several state machines running at once, one per parallel branch: each one's states, the transitions that advance each, and how to build the result fastest. Complex flow orchestration is why the contract takes this shape.

## State machine

`running → ready → joined` on the normal path. `failed` is terminal on that path; after a process restart a running child comes back as a failed ready result, so the parent can still take it and decide whether to re-declare the work (`src/scope/forkjoin.mjs`). `blocked` records a checkpoint only: it starts nothing, spends nothing, and is never woken later; the next `scope_fork` with the same `scopeId` and `blocked: false` starts it. `supersededAt` and `generation` mark a record replaced by a later generation of the same `scopeId`. Join admission runs before a ready record is taken, so a refusal leaves it ready.

## Constants

| Constant | Value | Source |
|---|---|---|
| Default scope budget | 18 points | `src/scope/budget.mjs` |
| Maximum scope budget | 27 points | `src/scope/budget.mjs` |
| Default fanout | 4 children | `src/scope/budget.mjs` |
| Maximum fanout | 6 children | `src/scope/budget.mjs` |
| Default tree depth | 2 | `src/scope/budget.mjs` |
| Recommended depth | 3 | `src/scope/budget.mjs` |
| Panhandle default | 6 points | `src/scope/panhandle.mjs` |
| Panhandle maximum | 9 points, 300 seconds | `src/scope/panhandle.mjs` |

## Tradeoffs

- **Fork is free.** A child mints its own budget and clock; the parent's balance never funds it. A larger job becomes a deeper tree, not a fatter scope.
- **Join and return pause the caller's clock.** Waiting costs no wall time.
- **Caps are soft.** Over-budget, over-fanout, and deep nesting still run and carry a `WARNING`. Only the 300-second panhandle limit and join admission refuse.
- **The root has no budget.** Reading a file at the root requires a child; that fixed cost buys a parent context that is never polluted.
- **The wall clock is derived from LLM request duration, not tool time.** An I/O-heavy scope can reach its deadline before spending its points; `scope_panhandle` buys seconds. See `fork.time`.
- **Depth has no hard ceiling.** Each extra layer compresses the record to prose and carries another ancestor prefix; the defaults are guidance, not gates.

## Known gaps

- `README.md` is the user-facing account; `resources/prompts/**` is the model-facing account. This page owns the internal boundaries and the reasons they hold.
- `CONTROL_TOOLS` in `src/scope/state.mjs` also carries the legacy transcript-scan names `amend` and `pin`; it is a scan set, not the live tool list. `resources/prompts/system.md` lists only live tools and must not be changed back.
