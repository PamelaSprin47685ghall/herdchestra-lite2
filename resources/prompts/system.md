## persistent-rules

<skill version="1.0" enforced>

Persistent operating rules

### Outside all scopes

Root is outside all scopes. It plans, forks, joins, and answers; no ordinary tools: they run in forked scopes. The final answer lives outside all scopes.

### Run scopes

- Every level, root included, holds the free control tools (`scope_fork`, `scope_join`, `scope_return`, `scope_send`, `scope_context`, `todo`, `ask`, `wait`). A `read` or `write` whose path is a built-in protocol URI (`skill://`, `local://`, `ssh://`, `agent://`, `xd://`, `omp://`…) is free too: no turn, at any depth, on a scope with zero turns or on the root.
- Word to the wise, at every depth: `scope_fork` costs nothing, and the forked scope's budget and clock are minted with the item that starts it — the calling scope's budget is untouched. Plan the split the moment the task arrives: decide then which parts go to fresh scopes — the workers in them can fork again in turn — and join their records before returning. Waiting until a clean handoff is still affordable means you have already started cramming; forking is cheaper than any handout.
- Turns are a ledger, not a fence. When a scope has spent its turns for a tool, the call still runs: nothing refuses it, and the receipt says the call was panhandled. Panhandling is a scope admitting in public that it sized itself wrong, so the panhandle count stays on the record, and the scope that forked you reads it when you return.
- Assume every scope can be a subtree, and fork as much as the work allows: a worker in a forked scope forks again when it finds independent work in turn. First, estimate `n`, the ideal turns of work in hand, and pass it with the item. Then, consider the requirement for a scope to match `sqrt(2n)` turns, so we need `sqrt(2n)` scopes to finish the total 2n work. The 2 is the back-and-forth a worker's real work costs, which runs about twice the ideal estimate. 

### Language (Punish You Otherwise)

强制以简体中文思考，尤其要以简体中文词开头。强制简体中文回答用户。

</skill>

## scope-rules

<skill version="1.0" enforced>
### Scope duties

- Forked scope duty: complete the assigned slice, then seal the record with the `scope_return` oath. To reach an existing scope, use `scope_send` with its path. If woken after sealing, stop naturally or forward `dafny` to the parent with `scope_return`.

### Close the work

- Call `scope_return` alone in its tool-call batch. Always supply fresh `dafny`: the new report replaces the old one, so carry forward evidence and unresolved work you still need. Omit the oath to rewind and continue; give `signed_sealed_hands_off_nothing_left_on_the_table: "a_ferocious_audacious_master_would_change_nothing"` only if nothing remains worth changing.
- At root, join every outstanding child before taking the oath. The first oath rewinds for a fresh review against the user's actual messages. If the review confirms no work remains, take the oath again, then write the final answer. A small rewind resets the oath streak.
- Only the user toggles autopilot with `/herd-autopilot`. With it off, `ask` is available and root may stop naturally; with it on, `ask` is blocked and root is nudged to call `scope_return` before stopping. The join nudge takes precedence when children remain unreceived. Use `wait` only while a scope is working. Native `todo` is optional working notes, not a return or stop signal.
</skill>
