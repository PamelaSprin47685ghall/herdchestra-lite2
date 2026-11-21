## tool

Record the ledger of remaining work. todo is free and is the only functional tool that may be called when all scopes are closed. It is forbidden inside any active scope at any level: close every scope first. The ledger is canonical: it is what the next relay holder reads before deciding whether work remains. Submitting a todo ledger turns on the full flow: the four working stages from acceptance-cases through direct-execution and the relay apply from then on, until two consecutive empty evaluations end it. decision-framing is a separate, manual stage that only opens while the user has enabled /herd; it is not part of this workflow. An empty list counts as a submission too. After that the session is simple again: a new task may finish in one direct-execution scope without a ledger. A later todo write after that (an empty list included) turns the full flow on again.

Operations: init replaces and submits the whole ledger; view is a read-only check that does NOT advance the relay evaluation and does not change the ledger; list: [] is an empty ledger. A non-empty ledger forbids a natural stop. An empty ledger does not allow a stop either: it triggers a relay handoff where you must stop calling tools and immediately write the handoff report in your message body, after which a compaction boundary is placed and the successor takes over. Only the successor's first submitted write-operation evaluation being empty (a promotion) allows a natural stop. The successor may open any number of scopes to investigate first; todo need not be the successor's first tool call. If the successor's first submitted evaluation is non-empty, it enters rework and is not the last holder: even if it later empties the ledger, it must reach another handoff to the next successor.

Write every item so the next agent can understand the work: the user requirement, acceptance evidence, unresolved risks, and the next concrete action. Summarize requirements without omitting or narrowing them; you do not need to quote them. The tool result appends RELAY STATE: the current generation, this generation's first evaluation, whether the ledger is empty, whether stopping is allowed, and the next required action.

Task nature chooses the flow; the one authority for that rule is `persistent-rules` in the system prompt. `todo` remains forbidden inside any scope or fission flow.

## op

One incremental todo operation. Omit it and the native tool infers the operation from the other fields. init replaces and submits the entire ledger from list (list: [] submits an empty ledger). start moves an existing task to in_progress. done completes it. rm removes it. drop abandons it. block marks it blocked, with reason as the blocker note. unblock returns it to pending. append adds items to a phase. view is a read-only check: it does NOT advance the relay evaluation and does not change the ledger. To submit a ledger, use a write operation, most explicitly init with the full list. A failed call never advances the relay state. In simple mode a view is a no-op that keeps the flow simple.

## list

Full ledger replacement for op: init. Each entry is { phase, items }, where phase names the phase and items is an array of task strings. The list replaces every existing phase; an empty array is an empty ledger, which triggers the relay handoff protocol rather than allowing a stop.

## list.item

Task strings for this phase.

## task

The existing task's verbatim content, used by start, done, rm, drop, block, and unblock. Copy it exactly from the ledger.

## phase

The phase name. Used by append and by the init list entries. Phase names are the lookup key for later operations.

## items

Task strings for op: append. Each string becomes a pending task in the named phase.

## reason

When op is block, a short note on what the task is waiting for. Optional otherwise.
