---
name: scope-orchestration
description: Design record for herdchestra-lite2 scope orchestration. Load before changing fork, join, return, request, panhandle, or scope identity behavior, or when explaining why a scope is sized, split, or closed as it is.
---

# Scope Orchestration

The user-facing account is `README.md`; the code is authoritative for every number. This page owns the boundaries and the reasons they hold.

## Boundaries

- **Root** is outside all scopes. It plans, forks, joins, and answers. It has no budget or clock, so ordinary tools run in a forked scope.
- **Station** owns state and stays synchronous; **Ticket** owns waiting and is the only place `await` runs. Fork, join, and return follow the same split.
- **Role is the privilege, and the name carries it.** Every path segment is `<role>.<name>` (`manager`, `devops`, `editor`, `inspector`); Root `/` is a `manager`. Privilege narrows monotonically, and a scope may fork or abandon only its own role or a narrower one, so a low-privilege `inspector` cannot borrow a higher path to escalate. `src/scope/roles.mjs` owns the ranks, the per-role host-tool sets, the `editor` concrete-file target check, and the `devops` single-`running` mutex; `fork-join.mjs`, `capabilities.mjs`, and `abandon.mjs` consume it and never import each other.
- **Identity is a unique path, fail-closed.** `scope_fork` items require `path`, `fsm`, `profession`, and `n`; `budget` and `targets` are optional and role-checked (`FORBIDDEN_ROLE_BUDGET`, `INVALID_EDITOR_TARGETS`). Duplicate paths (running or done, case-insensitive) fail closed with `DUPLICATE_SCOPE_PATH` — no automatic `-2`/`-3` suffix renaming. A control call carries two ids: `call.id` is the call's own (unique in the ledger and the processed-call cache, synthetic inside `js` as `<frame>#<index>`), and `call.frameId` is the assistant tool call the journal knows.
- **Orthogonal upscope (context) and caller (ownership).** Root is `/` and is outside every scope. A subscope's `upscope` is its path parent (`upscopePath` / `upscopeId`), whose last closed turn snapshot (`safeSnapshotLeafId`) it inherits, and whose `resolvedModel` + `resolvedThinking` it inherits when `model` is omitted. Its `caller` (`ownerId` / `callerPath`) is the scope that called `scope_fork`, which receives its `scope_return` via `scope_join`. Because `ownerId` is a strict creation-order tree, `scope_join` cannot deadlock.
- **Directory delta.** Every turn's REPL probe carries `state.scopes_delta` (when changed since the previous turn) with overwrite semantics per path (`running | <model> | <base>+ / <window>` or `done | <model> | <ctx> / <window>`, including Root `/`). Running scopes do not emit per-turn token deltas; baselines reset on Turn 1, rewind, compaction, and resume.
- **Records are frozen in the ledger.** Only the oath of a started scope seals a record; there is no generation suffix and no older or newer view of the same path.
- **One word for the fork contract: `fsm`.** `validateFork`, `record.fsm`, `identity.fsm`, the spawn spec, and the receipt render key all use it; the ledger snapshot is version 2, and a version-1 snapshot is refused rather than migrated. The text describes the work as a set of state machines, one per branch: each machine's states, the transition that advances it, and how to build the result fastest. Complex flow orchestration is why the contract takes this shape.
- **`n` is a declared estimate, not an engine input.** Every fork item requires `n`, the estimate of the ideal turns of work in hand. It travels with the tool call and into the transcript for a later audit; `validateFork` drops it, and no turns, clock, or admission reads it. `resources/prompts/system.md` owns the split rule that gives it meaning; `fork-join.md` owns the field's wording.
- **The return contract is `dafny` and an optional oath.** A non-empty report is required and `scope_return` runs alone. The default is a rewind, retaining the latest report; in a forked scope it also retains the birth instructions. A fresh report replaces the previous one, so it carries forward evidence that still matters. The oath of a started scope publishes its record with the trimmed report appended and preserves orphan adoption. `fsm` is the task contract of the scope that starts the work, not the report of the scope that does it. `fork-join.md` owns the exact oath and report wording.

## State machine

`running -> ready -> joined` on the normal path, and `failed` is terminal. A forked scope owes its record: an assistant turn that ends without a tool call earns the return nudge as a steer, and the session-stop gate asks again when the host drops that steer. Both legs spend one allowance, `record.returnNudges` against `MAX_RETURN_NUDGES` in `src/scope/return-nudge.mjs`, so a forked scope cannot be asked more times than the bound however the paths interleave. After a process restart a running forked scope comes back as a failed ready result, so the scope above can still take it.
A forked scope that ends a turn without sealing is closed as failed once `MAX_RETURN_NUDGES` is spent. A join has no deadline — a bound would waste a slow scope's work — so a user message ends a parked join without a record and leaves that scope running; `scope_abandon({ target })` closes that scope from the scope above: the bracket becomes ready-with-failure so the parked join takes `failed: true`, its agent stops, its unreceived subscopes transfer to its caller, and its `done` record stays joinable.

At root, a small return rewinds through compaction and resets the oath streak. The compacted root keeps verbatim user messages and the latest report. The first oath requests a fresh review; the second consecutive oath allows the final reply. Root must join every scope it forked before an oath. In manual mode it may stop naturally; in autopilot it gets a return nudge unless the join nudge takes precedence.

## Sizing

There is no table, and no constant in `src/scope/turns.mjs` holds one. `resources/prompts/system.md` §Run scopes gives the two split rules — about `sqrt(n)` scopes for an `n`-turn estimate, and forking stops two levels below you — and that text sits in every worker's prefix, so this page points at it instead of repeating it. The engine caps nothing: not a scope's turns, not the items in one call, not the depth of the tree. Those rules are guidance, not admission; the over-budget and over-fanout warnings went out with the constants that fed them.

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
  catalog entry for the persisted base key. The resolution itself lives in
  `resolveContextWindow` (`src/station/domain/context.mjs`); `src/station/fork-reads.mjs`
  reads the same method, so admission and pressure cannot disagree about the limit.

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
- **`fork` hands the waiting away.** The calling scope keeps the critical path and pays nothing for the split; Tradeoffs owns the accounting.

The test is the same for both: can the next action reach what it needs from here? What it cannot reach belongs in the `dafny` report, and what does not depend on it is forked off.

Owners, so no fact is written twice:

- `resources/prompts/tools/fork-join.md` — every field of `fork`, `join`, `return`, and `abandon`, with the wording the model reads at the call site. `inject.mjs` compiles the placeholder-free sections into the managed block, because `js` is the only registered tool and no JSON schema carries these four controls.
- `CONTROL_TOOLS` in `src/scope/state.mjs` is the live control surface: `scope_fork`, `scope_join`, `scope_return`, `scope_abandon`, and `wait`. A tool outside it is a host tool, and a host tool spends budget.
- `resources/prompts/system.md` §Run scopes — the sizing rule that gives `n` meaning.
- This page — the reasons, and nothing the model reads as an instruction.

## Tradeoffs

- **Fork is free.** A forked scope mints its own budget and clock; the calling scope's budget never funds it. A larger job becomes more scopes, not a fatter one.
- **Join and return pause the caller's clock.** Waiting costs no wall time.
- **Spent turns are a receipt, not a fence.** A non-root call whose budget is gone still runs, clamps its charge at zero, and lands in the scope's panhandle count, which the caller reads on the record. The root is refused because it is outside every scope; join admission is the other refusal.
- **The root has no budget.** Reading a file at the root requires a forked scope; that fixed cost buys a calling context that is never polluted.
- **Panhandling is discredit, not rescue.** There is no tool that asks for more. A scope that overruns has published that it sized itself wrong, and the panhandle count stays on the record beside it.
- **The wall clock is derived from LLM request duration, not tool time.** An I/O-heavy scope can reach its deadline before spending its turns; past the deadline a call still returns its result and the overrun lands in the panhandle count, so the deadline is a receipt, not a fence. Size the turns for the time the work needs. See `fork.time`.
- **Depth is guidance, not admission.** Each extra layer compresses the record to prose and carries another prefix; the two-level rule keeps that cost bounded.

## Known gaps

- `README.md` is the user-facing account; `resources/prompts/**` is the model-facing account. This page owns the internal boundaries and the reasons they hold.
- Module layout after the clean break: `src/scope/forkjoin.mjs` and `src/scope/persistence.mjs` are re-export facades over `ledger-{brackets,serialize,charge}.mjs` and `state-codec.mjs` / `entry-plan.mjs` / `state-delta.mjs` / `ledger-entry.mjs`; `src/station/fork-controls.mjs` is the facade over `fork-reads.mjs`, `join-controls.mjs`, `return-controls.mjs`, `abandon-controls.mjs`; the one-per-process fork wiring lives in `src/wiring/fork-wiring.mjs`.
