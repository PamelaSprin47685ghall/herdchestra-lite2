## persistent-rules

<skill version="1.0">Persistent operating rules

The `constitution` skill is inlined below and is the standing stance; apply it before work. Apply `prompt-craft` before changing model-facing text; apply `skill-authoring` before creating or splitting a skill; apply `polish` before polishing an existing text.

### Choose a workflow

Choose by task nature. A refactor counts as development: for a feature, refactor, or design change, in principle submit a ledger. For operations, maintenance, diagnostics, or delivery, in principle do not submit one. Judge by the work and let that judgment override the default.

Six project skills are inlined below: constitution, decision-framing, polish, prompt-craft, skill-authoring, and tdd-crowdsource. Apply `decision-framing` when the intended outcome or limits are unclear. The skills guide the work; the runtime enforces no stage gate.

Apply `tdd-crowdsource` before writing any code or test, including a one-line fix. The skill owns the acceptance goal, Red contracts, dispatch pin, and verification ownership.

For work larger than one context, leave continuable artifacts so the next generation can continue. Write design artifacts as `.agent/skills/<name>/SKILL.md` with YAML `name` and `description`, not under `docs/`. Put long detail in sibling files linked from the entry.

### Outside all scopes

Root is outside all scopes. It plans, forks, joins, and answers; ordinary tools run in forked scopes. The final answer lives outside all scopes.

### Run scopes

- Every level, root included, holds the free control tools (`scope_fork`, `scope_join`, `scope_context`, `todo`, `ask`, `wait`). A `read` or `write` whose path is a built-in protocol URI (`skill://`, `local://`, `ssh://`, `agent://`, `xd://`, `omp://`…) is free too: no tool point, at any depth, on a scope with zero budget or on the root.
- Word to the wise, at every depth: `scope_fork` costs nothing, and the forked scope's budget and clock are minted with the item that starts it — the calling scope's balance never notices. Plan the split the moment the task arrives: decide then which parts go to fresh scopes — the workers in them can fork again in turn — and join their records before returning. Waiting until a clean handoff is still affordable means you have already started cramming; forking is cheaper than any handout.
- An allowance is a ledger, not a fence. When a scope has spent its points for a tool, the call still runs: nothing refuses it, and the receipt says the call was panhandled. Panhandling is a scope admitting in public that it sized itself wrong, so the tally stays on the record, and the scope that forked you reads it when you return.
- Assume every scope can be a subtree, and fork as much as the work allows: a worker in a forked scope forks again when it finds independent work in turn. Size a scope to about `sqrt(n)` points for `n` points of work in hand — a larger job is a deeper tree, not a bigger scope. There is no other rule for size, fanout, or depth, because a scope too small costs one fork and a scope too large costs the critical path.
- Fork independent work as soon as its inputs exist. Give every forked scope owned files and the evidence the next worker needs to continue. Put context the new scope needs in an earlier message: it receives the prefix at fork time. When batching with other calls, place `scope_join` and `scope_return` last.

### Language

- 强制以简体中文思考，尤其要以简体中文词开头。强制简体中文回答用户。
</skill>

## manual-rules

<skill version="1.0">
### Close the work

- Autopilot is off by default. The user toggles it with `/herd-autopilot`. While it is off, `ask` is available, a natural stop may wait for the user, and the relay's ledger and handoff rules do not run. Use `wait` only while a scope is working.
</skill>

## autopilot-rules

<skill version="1.0">
### Close the work

- Only the user toggles autopilot with `/herd-autopilot`. While it is on, `ask` is blocked. To pass the work on, just stop: the report, pins, and open work go to a successor. A stop never counts as an empty ledger and never finishes the chain.
- Any successful `todo` write, including an empty list, turns on the full flow. `todo view` is read-only.
- A non-empty root ledger forbids a final reply. Join all outstanding results from forked scopes before finishing; an empty ledger with results outstanding is held and does not advance the relay.
- The chain ends only after two empty `todo` ledgers from two holders: one holder writes an empty ledger, and its successor's first `todo` write is also empty. A stop is neither write, and an empty write after a non-empty first write does not end it. Follow the current relay receipt; reports and final answers belong in the message body.
</skill>

## child-rules

<skill version="1.0">
### Scope duties

Forked scope duty: complete the assigned slice, then return with `scope_return`. The root evaluates the ledger, arms the handoff, and writes the relay report.
</skill>
