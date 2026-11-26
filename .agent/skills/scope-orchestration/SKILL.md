---
name: scope-orchestration
description: Design record for herdchestra-lite2 scope orchestration. Load before changing fork, join, return, request, panhandle, or scope identity behavior, or when explaining why a scope is sized, split, or closed as it is.
---

# Scope Orchestration

The user-facing account is `README.md`; the code is authoritative for every number. This page owns the boundaries and the reasons they hold.

## Boundaries

- **Root** is outside all scopes. It plans, forks, joins, and answers. It has no budget or clock, so ordinary tools run in a child.
- **Station** owns state and stays synchronous; **Ticket** owns waiting and is the only place `await` runs. Fork, join, and return follow the same split.
- **Identity is a path, not a label.** `scopeId` names a scope among its siblings only. `validateFork` requires `scopeId`, `fsm`, `profession`, `n`, `budget`, and `targets`; a repeated sibling name is never an upsert — registration appends the lowest free numeric suffix (`worker` → `worker-2` → `worker-3`), and both the caller's receipt and the child's start receipt carry the final path. The same name under two different parents is legal and means two unrelated scopes. A control call carries two ids: `call.id` is the call's own (unique in the ledger and the processed-call cache, synthetic inside `js` as `<frame>#<index>`), and `call.frameId` is the assistant tool call the journal knows. The fork spec, the join receipt, and the return batch check read the frame; nothing outside `js-ticket` parses the inner id.
- **Paths.** Root is `/` and is outside every scope. A child's path is its parent's path plus `/<scopeId>` (`/api`, `/api/auth`), so the tree the registry already encodes in `parentOwnerId` is its own address space; there is no global name table, only sibling uniqueness plus the parent chain.
- **Addressing.** `scope_request` resolves one exact path against the caller's own: `..`, a relative name, or an absolute `/a/b`. There is no pattern and no self-target, so a fanout is `Promise.all` over `state.scopes` inside one script. A finished scope stays addressable, and asking it wakes it for one reply turn; the target learns who asked only as `state.request.from`.
- **Records are frozen in the ledger.** Only the child oath seals a record; there is no generation suffix and no older or newer view of the same path.
- **One word for the fork contract: `fsm`.** `validateFork`, `record.fsm`, `identity.fsm`, the spawn spec, and the receipt render key all use it; the ledger snapshot is version 2, and a version-1 snapshot is refused rather than migrated. The text describes the work as a set of state machines, one per branch: each machine's states, the transition that advances it, and how to build the result fastest. Complex flow orchestration is why the contract takes this shape.
- **`n` is a declared estimate, not an engine input.** Every fork item requires `n`, the parent's estimate of the ideal turns of work in hand. It travels with the tool call and into the transcript for a later audit; `validateFork` drops it, and no turns, clock, or admission reads it. `resources/prompts/system.md` owns the sizing rule that gives it meaning; `fork-join.md` owns the field's wording.
- **The return contract is `dafny` and an optional oath.** A non-empty report is required and `scope_return` runs alone. The default is a rewind, retaining the latest report; in a child it also retains the birth instructions. A fresh report replaces the previous one, so it carries forward evidence that still matters. A child oath publishes its record with the trimmed report appended and preserves orphan adoption. `fsm` is the parent's task contract, not the child's report. `fork-join.md` owns the exact oath and report wording.

## State machine

`running → ready → joined` on the normal path. A forked scope owes its record: while its bracket is `running`, an assistant turn that ends without a tool call earns the return nudge as a steer, and the session-stop gate asks again when the host drops that steer. Both legs spend one allowance, `record.returnNudges` against `MAX_RETURN_NUDGES` in `src/scope/return-nudge.mjs`, so the child cannot be asked more times than the bound however the paths interleave; the spawn ticket charges the same field and closes the bracket as failed when it is spent, and nothing resets it after the seal. `failed` is terminal on that path; after a process restart a running child comes back as a failed ready result, so the parent can still take it and decide whether to re-declare the work (`src/scope/forkjoin.mjs`). There is no `blocked` state and no generation: a checkpoint lives in the latest return report, and work that must run later is forked later. Join admission runs before a ready record is taken, so a refusal leaves it ready; and because a ready scope's session stays alive, a `scope_request` that names it wakes it in place (see Wake lifecycle). The nudge allowance belongs to the seal only — a woken scope is not asked again.

A child that ends a turn without sealing is closed as failed once `MAX_RETURN_NUDGES` is spent. A pending `scope_request` the child never answers is rejected after `MAX_WAKE_ATTEMPTS` wake prompts (`src/tools/spawn-ticket.mjs`), so an unanswered question cannot keep the loop alive. A join has no deadline — a bound would waste a slow child's work — so a user message ends a parked join without a record and leaves the child running; `scope_abandon({ target })` closes that child from its parent: the bracket becomes ready-with-failure so the parked join takes `failed: true`, its agent stops, its queued requests reject, and its address leaves `state.scopes`.

At root, a small return rewinds through compaction and resets the oath streak. The compacted root keeps verbatim user messages and the latest report. The first oath requests a fresh review; the second consecutive oath allows the final reply. Root must join outstanding children before an oath. In manual mode it may stop naturally; in autopilot it gets a return nudge unless the join nudge takes precedence.

## Requesting

`scope_request({ target, message, interrupt })` is a free control tool, so it spends no turn and passes the same control-process gate as fork and join. It is the only way to reach a scope after creation, and it is synchronous: the caller's script parks on the returned Promise and continues with `{ ok, from, reply }`.

- **The target is forced to answer.** `src/scope/request-queue.mjs` holds the parked resolver and one FIFO per path; the target's next projection finds the queue head and collapses to `AWAITING_REPLY`, where `scope_reply` is the only bound method. One reply resolves the request and lifts the mode, so an answer cannot be deferred past one of the target's turns.
- **Two structural guards.** `waitFor` records who is parked on whom for both `scope_request` and `scope_join`, and a bounded reachability walk refuses a target that is already waiting on the caller: a cycle is rejected at the door instead of parking two scopes forever. Nothing here is persisted — the tables are process memory, because a reload cannot replay a conversation that is no longer running.
- **`interrupt` carries its own reason.** `REQUEST_INTERRUPT_REASON` cuts a target out of its work; it is not a user abort, so the stop button still cancels the tree and a request never does.

## Wake lifecycle

The normal path stays `running → ready → joined`, and `failed` stays terminal. What changes is that `ready` is no longer a locked door, and `running` is no longer the only live state.

- **One reply, then stop.** A woken scope receives no return nudge: its obligation was paid by its oath. It answers the queued question in its single `AWAITING_REPLY` turn and then stops naturally, dropping out of the active list again.
- **Waking never rewrites the record.** A question is not a second result: the parent's `ready` or `joined` state and the sealed record are untouched. Fork and join keep their 1:1 pairing, and every later exchange is `scope_request` / `scope_reply`.
- **What is gone.** `amendFork`, `reviveBlockedFork`, `supersedeFork`, `continuesForkId`, the `:g<N>` generation suffix, the `blocked` field, and the append-only inbox with its glob engine. A checkpoint is a return report, not a scope; work that must exist later is forked later.

## Active list

Every turn ends with the REPL probe: a `> ({ api: Object.keys(api), ...state })` command, the one-line object it evaluates to, and the language comment. `state.scopes` lists every path that can still answer, in lexicographic order, with the reader's own path among them, so a receiver reads who exists without being told who is speaking. A finished scope stays in that list while it remains addressable — a question still wakes it — and the list is the model's address book for a fanout. A record whose outcome failed is dropped instead: a refused spawn or a dead child never produced a session, so a request sent there would park forever. `listAddressableScopePaths` owns that rule and `scope_request` refuses the same records with `REQUEST_UNREACHABLE`.

## Sizing

There is no table, and no constant in `src/scope/turns.mjs` holds one. A scope is sized by the work in hand: `resources/prompts/system.md` §Run scopes gives the turns for the `n` a scope declares and why the multiplier is ten, and that text sits in every worker's prefix, so this page points at it instead of repeating it. Fork as much as the work allows, and tell every child to fork again — a scope that cannot fork has rebuilt the bottleneck the fork removed. Nothing caps a scope's turns, the items in one call, or the depth of the tree; the over-budget and over-fanout warnings went out with the constants that fed them.

## Context pressure

A scope's outbound request carries one extra `skill` when the scope has
outgrown the midpoint between its own birth context and the model's input
limit: `(window - baseline) / 2 + baseline`. The decision is arithmetic, so it
lives in `src/scope/context-nudge.mjs`; the measured facts live on the usage
ledger in `src/scope/usage-ledger.mjs`; the text is the `context.nudge` section
of `resources/prompts/receipts/scope.md`.

The owner of each input is fixed:

- **Baseline** — the input the provider reported for the scope's first measured
  request. A fork's first request is the first request of its own session, so
  this is the birth context without an estimate. `resetWatermark()` clears it,
  which is why a rewind or a reborn scope re-baselines; a fold (`rebase`) keeps
  it, because a fold changes the context, not the birth.
- **Occupancy** — `lastTotalInput + lastOutputTokens`: where the last response
  ended. Pending messages are excluded on purpose; the contract arms on what
  the last request returned.
- **Window** — `Station.contextWindowTokens()`, the single resolution order:
  the fork window port, then the live model object the host resolved, then the
  catalog entry for the persisted base key. `fork-controls.mjs` reads the same
  method, so admission and pressure cannot disagree about the limit.

Three states refuse to arm: an unmeasured baseline, an unmeasured occupancy,
and an unknown window. An unknown never produces a nudge, and it never reaches
the division. A window at or below the baseline arms at once: the scope has no
room left, and no midpoint exists to cross. The comparison is strict — equality
means continuing still pays.

The signal is a hard mode, not a paragraph. `Station.contextNudgeArmed()` is
the projection's `contextOverHalf` input, so an armed scope collapses to
`CONTEXT_LIMIT` and the probe prints `scope_return` as the only key in `api`
— the ordinary tool set disappears, with no text to read and nothing to
weigh. Disarming prints the ordinary set again. Both states keep the prefix
byte-identical, so arming and disarming cost the provider nothing: the steer
is a per-turn receipt, never prompt text, and `tests/context-nudge.test.mjs`
asserts the collapse and the untouched prefix. The flag is refreshed
synchronously by `observeActualModel`, `onMessage`, `resetWatermark` and
`rebase`, so the projection always describes the last measured response.

## Terms

Two names, two senses, orthogonal:

- **turn** (plural **turns**) — the countable unit: one assistant message spends at most one turn, split among its calls by count.
- **budget** — the allocation of turns to a tool or a scope, and the arithmetic over it: grant, increment, remaining, overdraw, validation.

They can share a sentence: the persisted field is named `budget` and it holds turns, a mapping stated where the reader types the field (`## fork.budget`); a tool with no budget left still runs on a panhandled turn. Only third names are retired: `allowance` and `balance` become budget (or "turns left"), `tally` becomes count, `points` becomes turns. `panhandle`/`panhandled` stays the overdraw event; the wall clock and a host `tokenBudget` are neither name; `point` keeps its other senses — position, argument, quality score.

## Cadence

Two movements are left, and both pay at the moment they are used:

- **`scope_return` closes the beat.** The fresh `dafny` is the only thing a later turn inherits, so what still matters has to be inside it; a report that omits a finding loses it.
- **`fork` hands the waiting away.** The parent keeps the critical path and pays nothing for the split; Tradeoffs owns the accounting.

The test is the same for both: can the next action reach what it needs from here? What it cannot reach belongs in the `dafny` report, and what does not depend on it is forked off.

Owners, so no fact is written twice:

- `resources/prompts/tools/fork-join.md` — every field of `fork`, `join`, `request`, `reply`, `return`, and `abandon`, with the wording the model reads at the call site. `inject.mjs` compiles the placeholder-free sections into the managed block, because `js` is the only registered tool and no JSON schema carries these six controls.
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
- `CONTROL_TOOLS` in `src/scope/state.mjs` is the live control surface: `scope_request`, `scope_fork`, `scope_join`, `scope_reply`, `scope_return`, `scope_abandon`, `wait`. `pin`, `amend`, `scope_context`, and `scope_send` no longer exist, in code or in the prompt documents; `resources/prompts/system.md` lists only live tools and must not be changed back.
- A request's result is composed from data, not from a template: the queue resolves `{ ok, from, reply }`, and `fork-join.md` §request.tool states that shape in the prose the managed block carries. A template nothing renders is a second source of truth; delete the key rather than fill it.
