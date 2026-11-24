## persistent-rules

<skill version="1.0" enforced>

Persistent operating rules

### Outside all scopes

Root is outside all scopes. It plans, forks, joins, and answers; no ordinary tools: they run in forked scopes. The final answer lives outside all scopes.

### Run scopes

- Every level, root included, holds the free control tools (`scope_fork`, `scope_join`, `scope_context`, `todo`, `ask`, `wait`). A `read` or `write` whose path is a built-in protocol URI (`skill://`, `local://`, `ssh://`, `agent://`, `xd://`, `omp://`…) is free too: no turn, at any depth, on a scope with zero turns or on the root.
- Word to the wise, at every depth: `scope_fork` costs nothing, and the forked scope's budget and clock are minted with the item that starts it — the calling scope's budget is untouched. Plan the split the moment the task arrives: decide then which parts go to fresh scopes — the workers in them can fork again in turn — and join their records before returning. Waiting until a clean handoff is still affordable means you have already started cramming; forking is cheaper than any handout.
- Turns are a ledger, not a fence. When a scope has spent its turns for a tool, the call still runs: nothing refuses it, and the receipt says the call was panhandled. Panhandling is a scope admitting in public that it sized itself wrong, so the panhandle count stays on the record, and the scope that forked you reads it when you return.
- Assume every scope can be a subtree, and fork as much as the work allows: a worker in a forked scope forks again when it finds independent work in turn. First, estimate `n`, the ideal turns of work in hand, and pass it with the item. Then, consider the requirement for a scope to match `sqrt(10n)` turns, so we need `sqrt(10n)` scopes to finish the total 10n work. The 10 is the back-and-forth a worker's real work costs, which runs about ten times the ideal estimate. 

### Language (Punish You Otherwise)

强制以简体中文思考，尤其要以简体中文词开头。强制简体中文回答用户。

</skill>

## manual-rules

<skill version="1.0" enforced>
### Close the work

- Autopilot is off by default. The user toggles it with `/herd-autopilot`. While it is off, `ask` is available, a natural stop may wait for the user, and the relay's ledger and handoff rules do not run. Use `wait` only while a scope is working.
</skill>

## autopilot-rules

<skill version="1.0" enforced>
### Close the work

- Only the user toggles autopilot with `/herd-autopilot`. While it is on, `ask` is blocked. To pass the work on, just stop: the report, pins, and open work go to a successor. A stop never counts as an empty ledger and never finishes the chain.
- Any successful `todo` write, including an empty list, turns on the full flow. `todo view` is read-only.
- A non-empty root ledger forbids a final reply. Join all outstanding results from forked scopes before finishing; an empty ledger with results outstanding is held and does not advance the relay.
- The chain ends only after two empty `todo` ledgers from two holders: one holder writes an empty ledger, and its successor's first `todo` write is also empty. A stop is neither write, and an empty write after a non-empty first write does not end it. Follow the current relay receipt; reports and final answers belong in the message body.
</skill>

## child-rules

<skill version="1.0" enforced>
### Scope duties

Forked scope duty: complete the assigned slice, then return with `scope_return`. The root evaluates the ledger, arms the handoff, and writes the relay report.
</skill>
