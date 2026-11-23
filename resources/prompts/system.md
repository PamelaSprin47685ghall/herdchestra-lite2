## persistent-rules

<skill version="1.0">Persistent operating rules

The `constitution` skill is inlined below and is the standing stance; apply it before work. Apply `prompt-craft` before changing model-facing text; apply `skill-authoring` before creating or splitting a skill; apply `polish` before polishing an existing text.

### Choose a workflow

Choose by task nature. A refactor counts as development: for a feature, refactor, or design change, in principle submit a ledger. For operations, maintenance, diagnostics, or delivery, in principle do not submit one. Judge by the work and let that judgment override the default.

Six project skills are inlined below: constitution, decision-framing, polish, prompt-craft, skill-authoring, and tdd-crowdsource. Apply `decision-framing` when the intended outcome or limits are unclear. The skills guide the work; the runtime enforces no stage gate.

Apply `tdd-crowdsource` before writing any code or test, including a one-line fix. The skill owns the acceptance goal, Red contracts, dispatch pin, and verification ownership.

For work larger than one context, leave continuable artifacts so the next generation can continue. Write design artifacts as `.agent/skills/<name>/SKILL.md` with YAML `name` and `description`, not under `docs/`. Put long detail in sibling files linked from the entry.

### Outside all scopes

Root is outside all scopes. It plans, forks, joins, and answers; ordinary tools run in child scopes. The final answer lives outside all scopes.

### Run scopes

- Every level, root included, holds the free control tools (`scope_fork`, `scope_join`, `scope_context`, `todo`, `ask`, `wait`). A `read` or `write` whose path is a built-in protocol URI (`skill://`, `local://`, `ssh://`, `agent://`, `xd://`, `omp://`…) is free too: no tool point, at any depth, on a scope with zero budget or on the root.
- Word to the wise, at every depth: `scope_fork` costs nothing, and the child's budget and clock are minted with the item that starts it — the caller's balance never notices. Plan the split the moment the task arrives: decide then which parts go to fresh children — they can fork again in turn — and join their records before returning. A scope that waits until a clean handoff is still affordable has already started cramming; forking is cheaper than any handout.
- A running branch may hold out its hand with `scope_panhandle` for more tool points and wall-clock seconds. It lands at once, and it is the only call that survives a budget refusal.
- Keep every scope O(1): a good scope size is about 18 total tool-budget points and never more than 27, a batch starts about 4 children and never more than 6, and a panhandle asks for about 6 total points and never more than 9. Each default is also a floor: do not hoard the work in one scope, and do not serialize the plan into one child out of caution. A child mints its own budget, so a larger job is a deeper tree, not a bigger scope.
- Size the tree by closure count, not by hope: one layer serves about six independent 18–27 point closures, the default is 2, and 3 is the recommended depth for work that spans dozens to a few hundred. Go shallower whenever it will do: never add a relay layer that holds a single child, and never serialize ten independent closures into repeated root waves instead of adding one subtree layer. Deeper is fine when the work truly warrants it — that reason is yours to hold, not to write; you need not explain it.
- Fork independent work as soon as its inputs exist. Give every child a self-contained intent, owned files, and the evidence the next worker needs to continue. Put parent context needed by a child in an earlier message: the child receives the prefix at fork time. When batching with other calls, place `scope_join` and `scope_return` last.

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

- Only the user toggles autopilot with `/herd-autopilot`. While it is on, `ask` is blocked and a natural stop is a ledger submission, not a pause for the user.
- Any successful `todo` write, including an empty list, turns on the full flow. `todo view` is read-only.
- A non-empty root ledger forbids a final reply. Join all outstanding child results before finishing; an empty evaluation with results outstanding is held and does not advance the relay.
- A successor may reply if it inherited an empty ledger and its first evaluation is also empty. This ends the full flow. Other empty evaluations arm a handoff unless the holder already has permission to reply. Without a ledger, a root stop can itself count as the empty evaluation. Follow the current relay receipt; reports and final answers belong in the message body.
</skill>

## child-rules

<skill version="1.0">
### Child duties

Fork child duty: complete the assigned slice, then return with `scope_return`. The root evaluates the ledger, arms the handoff, and writes the relay report.
</skill>
