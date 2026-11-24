---
name: scope-orchestration
description: Design record for herdchestra-lite2 scope orchestration. Load before changing fork, join, return, panhandle, or scope identity behavior, before changing how pin or amend is explained, or when explaining why a scope is sized, split, or closed as it is.
---

# Scope Orchestration

The user-facing account is `README.md`; the code is authoritative for every number. This page owns the boundaries and the reasons they hold.

## Boundaries

- **Root** is outside all scopes. It plans, forks, joins, and answers. It has no turns or clock, so ordinary tools run in a child.
- **Station** owns state and stays synchronous; **Ticket** owns waiting and is the only place `await` runs. Fork, join, and return follow the same split.
- **Identity** is `scopeId`. A reused id is an upsert: `running` and `blocked` take turn increments, one more requirement, and merged targets; `ready` supersedes and starts the next generation; `joined` and `failed` start a new generation with the old record as history.
- **Records are frozen in the ledger.** The tool surface resolves a `scopeId` to its latest generation only; an older generation has no public query.
- **One word for the fork contract: `fsm`.** `validateFork`, `record.fsm`, `identity.fsm`, the spawn spec, and the receipt render key all use it; the ledger snapshot is version 2, and a version-1 snapshot is refused rather than migrated. The text describes the work as a set of state machines, one per branch: each machine's states, the transition that advances it, and how to build the result fastest. Complex flow orchestration is why the contract takes this shape.
- **`n` is a declared estimate, not an engine input.** Every fork item requires `n`, the parent's estimate of the ideal turns of work in hand. It travels with the tool call and into the transcript for a later audit; `validateFork` drops it, and no turns, clock, or admission reads it. `resources/prompts/system.md` owns the sizing rule that gives it meaning; `fork-join.md` owns the field's wording.
- **The return contract is `dafny`.** `scope_return`'s one optional argument appends a string after the child's record; the record already carries the child's narration, so the string says what the replay drops, and the content chooses its form. Density, not length, is the criterion. It travels in a field of its own, and that field is not the fork contract: the fork item's `fsm` is the parent's instruction, describing the work the child scope is to do, and registration refuses an empty one; `dafny` is the child's closing text, appended to the record it hands back and absent when there is nothing to add. A change to one says nothing about the other. The name is deliberate: it invites a Dafny-style specification. `fork-join.md` owns what the model is told about the form, so do not restate that list here.

## State machine

`running → ready → joined` on the normal path. `failed` is terminal on that path; after a process restart a running child comes back as a failed ready result, so the parent can still take it and decide whether to re-declare the work (`src/scope/forkjoin.mjs`). `blocked` records a checkpoint only: it starts nothing, spends nothing, and is never woken later; the next `scope_fork` with the same `scopeId` and `blocked: false` starts it. `supersededAt` and `generation` mark a record replaced by a later generation of the same `scopeId`. Join admission runs before a ready record is taken, so a refusal leaves it ready.

## Sizing

There is no table, and no constant in `src/scope/turns.mjs` holds one. A scope is sized by the work in hand: `resources/prompts/system.md` §Run scopes gives the turns for the `n` a scope declares and why the multiplier is ten, and that text sits in every worker's prefix, so this page points at it instead of repeating it. Fork as much as the work allows, and tell every child to fork again — a scope that cannot fork has rebuilt the bottleneck the fork removed. Nothing caps a scope's turns, the items in one call, or the depth of the tree; the warnings for a scope over its turns or over its fanout went out with the constants that fed them.

## Terms

One quota unit has one name: a **turn** (plural **turns**). A scope holds turns, spends one at most per assistant message, and every other word for that unit — point, allowance, balance, tally — is retired.

Two identifiers are not prose and do not change: the persisted JSON field is named `budget`, and one unit of it is one turn, a mapping stated where the reader has to type the field (`## fork.budget`). `panhandle`/`panhandled` names the overdraw event and stays. The wall clock and a host token budget are not turns, and `point` keeps its other senses — position, argument, quality score.

## Cadence

Three tools move the clock, not the content: `pin`, `amend`, and `fork`. Each pays at the moment it is used and leaves nothing worth going back for.

- **`pin` buys reach.** The next hold is out of reach; one pin turns one hard move into two easy ones. The return is collected by the next action, so a later reader is a by-product.
- **`amend` closes the beat.** A model has no dusk, so a beat that failed stays as present as the beat after it; amend draws the dusk by hand. A shorter context is the by-product; the rite is the point.
- **`fork` hands the waiting away.** The parent keeps the critical path and pays nothing for the split; Tradeoffs owns the accounting.

The test is the same in all three: can the next action reach what it needs from here? What it cannot reach gets a `pin`, what has already happened gets closed, what does not depend on it is forked off.

Owners, so no fact is written twice:

- `resources/prompts/tools/notes.md` — the wording and the test the model reads at the call site for `pin` and `amend`.
- `resources/prompts/tools/fork-join.md` — every field of `fork`, `join`, and `return`.
- `resources/prompts/system.md` §Run scopes — the sizing rule that gives `n` meaning.
- This page — the reasons, and nothing the model reads as an instruction.

## Tradeoffs

- **Fork is free.** A child mints its own turns and clock; the parent's turns never fund it. A larger job becomes a deeper tree, not a fatter scope.
- **Join and return pause the caller's clock.** Waiting costs no wall time.
- **Spent turns are a receipt, not a fence.** A non-root call whose turns are gone still runs, clamps its charge at zero, and lands in the scope's panhandle count, which the caller reads on the record. The root is refused because it is outside every scope; join admission is the other refusal.
- **The root has no turns.** Reading a file at the root requires a child; that fixed cost buys a parent context that is never polluted.
- **Panhandling is discredit, not rescue.** There is no tool that asks for more. A scope that overruns has published that it sized itself wrong, and the panhandle count stays on the record beside it.
- **The wall clock is derived from LLM request duration, not tool time.** An I/O-heavy scope can reach its deadline before spending its turns; past the deadline a call still returns its result and the overrun lands in the panhandle count, so the deadline is a receipt, not a fence. Size the turns for the time the work needs. See `fork.time`.
- **Depth has no ceiling and no default.** Each extra layer compresses the record to prose and carries another ancestor prefix; that cost is the only thing a parent weighs.

## Known gaps

- `README.md` is the user-facing account; `resources/prompts/**` is the model-facing account. This page owns the internal boundaries and the reasons they hold.
- `CONTROL_TOOLS` in `src/scope/state.mjs` also carries the legacy transcript-scan names `amend` and `pin`; it is a scan set, not the live tool list. The live surface is `scope_context`, where `pin` and `amend` are its two modes, plus `scope_fork`. `resources/prompts/system.md` lists only live tools and must not be changed back.
