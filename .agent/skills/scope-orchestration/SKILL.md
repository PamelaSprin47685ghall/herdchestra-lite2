---
name: scope-orchestration
description: Design record for herdchestra-lite2 scope orchestration. Load before changing fork, join, return, panhandle, or scope identity behavior, before changing how pin or amend is explained, or when explaining why a scope is sized, split, or closed as it is.
---

# Scope Orchestration

The user-facing account is `README.md`; the code is authoritative for every number. This page owns the boundaries and the reasons they hold.

## Boundaries

- **Root** is outside all scopes. It plans, forks, joins, and answers. It has no budget or clock, so ordinary tools run in a child.
- **Station** owns state and stays synchronous; **Ticket** owns waiting and is the only place `await` runs. Fork, join, and return follow the same split.
- **Identity is a path, not a label.** `scopeId` names a scope among its siblings only. `validateFork` requires `scopeId`, `fsm`, `profession`, `n`, `budget`, and `targets`; a repeated sibling name is never an upsert — registration appends the lowest free numeric suffix (`worker` → `worker-2` → `worker-3`), and both the caller's receipt and the child's start receipt carry the final path. The same name under two different parents is legal and means two unrelated scopes.
- **Paths.** Root is `/` and is outside every scope. A child's path is its parent's path plus `/<scopeId>` (`/api`, `/api/auth`), so the tree the registry already encodes in `parentOwnerId` is its own address space; there is no global name table, only sibling uniqueness plus the parent chain.
- **Addressing.** `scope_send` resolves `.`, `..`, a relative `sub`, `../sibling`, an absolute `/a/b` or `/`, and GitHub-style `*` / `**`. A pattern resolves against active scopes only, so a wildcard never wakes a finished one; an exact path may also name a finished scope, and naming it wakes it. Delivery wraps the body as `[Message from <senderPath>]`, so the receiver answers by addressing that path and is never told who spoke.
- **Records are frozen in the ledger.** Only the child oath seals a record; there is no generation suffix and no older or newer view of the same path.
- **One word for the fork contract: `fsm`.** `validateFork`, `record.fsm`, `identity.fsm`, the spawn spec, and the receipt render key all use it; the ledger snapshot is version 2, and a version-1 snapshot is refused rather than migrated. The text describes the work as a set of state machines, one per branch: each machine's states, the transition that advances it, and how to build the result fastest. Complex flow orchestration is why the contract takes this shape.
- **`n` is a declared estimate, not an engine input.** Every fork item requires `n`, the parent's estimate of the ideal turns of work in hand. It travels with the tool call and into the transcript for a later audit; `validateFork` drops it, and no turns, clock, or admission reads it. `resources/prompts/system.md` owns the sizing rule that gives it meaning; `fork-join.md` owns the field's wording.
- **The return contract is `dafny` and an optional oath.** A non-empty report is required and `scope_return` runs alone. The default is a rewind, retaining the latest report and pins; in a child it also retains the birth instructions. A fresh report replaces the previous one, so it carries forward evidence that still matters. A child oath publishes its record with the trimmed report appended and preserves orphan adoption. `fsm` is the parent's task contract, not the child's report. `fork-join.md` owns the exact oath and report wording.

## State machine

`running → ready → joined` on the normal path. A forked scope owes its record: while its bracket is `running`, an assistant turn that ends without a tool call earns the return nudge as a steer, and the session-stop gate asks again when the host drops that steer. Both legs spend one allowance, `record.returnNudges` against `MAX_RETURN_NUDGES` in `src/scope/return-nudge.mjs`, so the child cannot be asked more times than the bound however the paths interleave; the spawn ticket charges the same field and closes the bracket as failed when it is spent, and nothing resets it after the seal. `failed` is terminal on that path; after a process restart a running child comes back as a failed ready result, so the parent can still take it and decide whether to re-declare the work (`src/scope/forkjoin.mjs`). There is no `blocked` state and no generation: a checkpoint lives in the latest return report and pins, and work that must run later is forked later. Join admission runs before a ready record is taken, so a refusal leaves it ready; and because a ready scope's session stays alive, a `scope_send` that names it wakes it in place (see Wake lifecycle). The nudge allowance belongs to the seal only — a woken scope is not asked again.

At root, a small return rewinds through compaction and resets the oath streak. The compacted root keeps verbatim user messages, pins, and the latest report. The first oath requests a fresh review; the second consecutive oath allows the final reply. Root must join outstanding children before an oath. In manual mode it may stop naturally; in autopilot it gets a return nudge unless the join nudge takes precedence. Native todo is optional notes and does not drive this protocol.

## Messaging

`scope_send({ target, message, budget? })` is a free control tool, so it spends no turn and passes the same control-process gate as fork and join.

- **One delivery path for three states.** A message to a running scope lands in the record's `inbox` and is flushed at the next turn boundary; one to `/` reuses the station's existing steer path and reaches the root; one to a finished scope also lands in `inbox` and wakes it. `budget` is an optional per-tool turn increment using the same grant arithmetic as a fork, and it is ignored for `/`.
- **Waking is cheap.** A child oath seals its record and returns immediately — it no longer parks in `waitForJoin`, so its session stays alive and idle while the bracket is `ready`. A woken scope re-enters the active list and keeps its own record: the parent's `ready` or `joined` state is untouched, and the reply is a message, not a second record.

## Wake lifecycle

The normal path stays `running → ready → joined`, and `failed` stays terminal. What changes is that `ready` is no longer a locked door, and `running` is no longer the only live state.

- **One return, then talk.** A woken scope receives no return nudge: its obligation was paid by its oath. It finishes by natural stop, once no unreceived message remains, and drops out of the active list again.
- **`scope_return` in a woken scope is a send to `..`.** The same delivery function runs, the parent receives the text as a message from this path, and the turn ends. That is the whole DRY rule: fork and join keep their 1:1 pairing, and every later exchange is `scope_send`.
- **What is gone.** `amendFork`, `reviveBlockedFork`, `supersedeFork`, `continuesForkId`, the `:g<N>` generation suffix, and the `blocked` field. A checkpoint is a return report with pins, not a scope; work that must exist later is forked later.

## Active list

Each turn's `<additional-system-instructions>` carries three sibling `<skill>` elements: status, language, and the active scope list. The third lists every unfinished path in lexicographic order with the receiver's own path on the first line, so a receiver reads who exists and where it stands without being told who is speaking. Finished scopes are omitted from the list and stay addressable by exact path — hiding is a display rule, not a deletion.

## Sizing

There is no table, and no constant in `src/scope/turns.mjs` holds one. A scope is sized by the work in hand: `resources/prompts/system.md` §Run scopes gives the turns for the `n` a scope declares and why the multiplier is ten, and that text sits in every worker's prefix, so this page points at it instead of repeating it. Fork as much as the work allows, and tell every child to fork again — a scope that cannot fork has rebuilt the bottleneck the fork removed. Nothing caps a scope's turns, the items in one call, or the depth of the tree; the over-budget and over-fanout warnings went out with the constants that fed them.

## Terms

Two names, two senses, orthogonal:

- **turn** (plural **turns**) — the countable unit: one assistant message spends at most one turn, split among its calls by count.
- **budget** — the allocation of turns to a tool or a scope, and the arithmetic over it: grant, increment, remaining, overdraw, validation.

They can share a sentence: the persisted field is named `budget` and it holds turns, a mapping stated where the reader types the field (`## fork.budget`); a tool with no budget left still runs on a panhandled turn. Only third names are retired: `allowance` and `balance` become budget (or "turns remaining"), `tally` becomes count, `points` becomes turns. `panhandle`/`panhandled` stays the overdraw event; the wall clock and a host `tokenBudget` are neither name; `point` keeps its other senses — position, argument, quality score.

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

- **Fork is free.** A child mints its own budget and clock; the parent's budget never funds it. A larger job becomes a deeper tree, not a fatter scope.
- **Join and return pause the caller's clock.** Waiting costs no wall time.
- **Spent turns are a receipt, not a fence.** A non-root call whose budget is gone still runs, clamps its charge at zero, and lands in the scope's panhandle count, which the caller reads on the record. The root is refused because it is outside every scope; join admission is the other refusal.
- **The root has no budget.** Reading a file at the root requires a child; that fixed cost buys a parent context that is never polluted.
- **Panhandling is discredit, not rescue.** There is no tool that asks for more. A scope that overruns has published that it sized itself wrong, and the panhandle count stays on the record beside it.
- **The wall clock is derived from LLM request duration, not tool time.** An I/O-heavy scope can reach its deadline before spending its turns; past the deadline a call still returns its result and the overrun lands in the panhandle count, so the deadline is a receipt, not a fence. Size the turns for the time the work needs. See `fork.time`.
- **Depth has no ceiling and no default.** Each extra layer compresses the record to prose and carries another ancestor prefix; that cost is the only thing a parent weighs.

## Known gaps

- `README.md` is the user-facing account; `resources/prompts/**` is the model-facing account. This page owns the internal boundaries and the reasons they hold.
- `CONTROL_TOOLS` in `src/scope/state.mjs` also carries the legacy transcript-scan names `amend` and `pin`; it is a scan set, not the live tool list. The live surface is `scope_fork`, `scope_join`, `scope_return`, `scope_send`, and `scope_context` (where `pin` and `amend` are its two modes). `resources/prompts/system.md` lists only live tools and must not be changed back.
- A send's receipt is composed from data, not from a template: `handleSendCall` names the delivered paths and the woken ones, so `fork-join.md` carries no `send.receipt` key. A template nothing renders is a second source of truth; delete the key rather than fill it.
