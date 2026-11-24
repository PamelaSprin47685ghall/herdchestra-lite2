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
- **One word for the contract: `fsm`.** `validateFork`, `record.fsm`, `identity.fsm`, the spawn spec, and the receipt render key all use it; the ledger snapshot is version 2, and a version-1 snapshot is refused rather than migrated. The text describes the work as a set of state machines, one per branch: each machine's states, the transition that advances it, and how to build the result fastest. Complex flow orchestration is why the contract takes this shape.

## State machine

`running → ready → joined` on the normal path. `failed` is terminal on that path; after a process restart a running child comes back as a failed ready result, so the parent can still take it and decide whether to re-declare the work (`src/scope/forkjoin.mjs`). `blocked` records a checkpoint only: it starts nothing, spends nothing, and is never woken later; the next `scope_fork` with the same `scopeId` and `blocked: false` starts it. `supersededAt` and `generation` mark a record replaced by a later generation of the same `scopeId`. Join admission runs before a ready record is taken, so a refusal leaves it ready.

## Sizing

There is no table, and no constant in `src/scope/budget.mjs` holds one. A scope is sized by the work in hand: about `sqrt(n)` tool-budget points, where `n` is that scope's share of the work counted in points. Fork as much as the work allows, and tell every child to fork again — a scope that cannot fork has rebuilt the bottleneck the fork removed. Nothing caps a scope's points, the items in one call, or the depth of the tree; the over-budget and over-fanout warnings went out with the constants that fed them.

## Tradeoffs

- **Fork is free.** A child mints its own budget and clock; the parent's balance never funds it. A larger job becomes a deeper tree, not a fatter scope.
- **Join and return pause the caller's clock.** Waiting costs no wall time.
- **A spent budget is a receipt, not a fence.** A non-root call whose allowance is gone still runs, clamps its charge at zero, and lands in the scope's panhandle tally, which the caller reads on the record. The root is refused because it is outside every scope; join admission is the other refusal.
- **The root has no budget.** Reading a file at the root requires a child; that fixed cost buys a parent context that is never polluted.
- **Panhandling is discredit, not rescue.** There is no tool that asks for more. A scope that overruns has published that it sized itself wrong, and the tally stays on the record beside it.
- **The wall clock is derived from LLM request duration, not tool time.** An I/O-heavy scope can reach its deadline before spending its points, and nothing buys the seconds back; size the points for the time the work needs. See `fork.time`.
- **Depth has no ceiling and no default.** Each extra layer compresses the record to prose and carries another ancestor prefix; that cost is the only thing a parent weighs.

## Known gaps

- `README.md` is the user-facing account; `resources/prompts/**` is the model-facing account. This page owns the internal boundaries and the reasons they hold.
- `CONTROL_TOOLS` in `src/scope/state.mjs` also carries the legacy transcript-scan names `amend` and `pin`; it is a scan set, not the live tool list. `resources/prompts/system.md` lists only live tools and must not be changed back.
