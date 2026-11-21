## next.promoted

Write the final answer. Full flow has ended.

## next.finish

Write the final answer.

## next.reopened

This write turns the full flow back on. You may still write the final answer.

## handoff-demand

Write the handoff report in your message body now; do not call tools. Include the user's full requirements, work completed, verification evidence, and remaining gaps or risks. Distinguish facts the successor can verify from your judgment.

## next.rework-first

Work through the open items.

## next.rework-successor

Rework: use your own assessment of the user's requirements. Hand off again when the ledger is empty.

## next.continue

Continue the open items. If you stop with work open, the next generation inherits it.

## next.unchanged

No relay evaluation. Only a successful todo write counts.

## next.inside-scope

Branch {{level}} ledger updated; this call did not advance the root relay.

## next.held-children

Empty ledger held: {{open}} unreceived child result(s). Receive them with scope_join, then resubmit.

## next.none

Submit todo({ op: "init", list: [] }) if nothing remains, or list the work that does.

## status.title

RELAY STATE

## status.generation

Generation: {{generation}} ({{holder}}).

## status.evaluation

First todo evaluation of this generation: {{label}}.

## status.ledger

Ledger: {{state}} ({{total}} total; {{open}} open; {{blocked}} blocked; {{completed}} completed; {{abandoned}} abandoned).

## status.ledger-none

Ledger: not evaluated yet.

## status.can-stop

Can stop now: {{answer}}.

## status.promotion

Promotion invalidated: yes.

## status.handoff-pending

Handoff pending: yes.

## status.handoff-error

Last handoff error: {{error}}

## status.call-error

This call did not advance the relay: {{error}}

## status.next

Next: {{next}}

## status.flow

Flow: {{flow}}.

## next.simple

A natural stop counts as an empty evaluation. Submit a todo ledger only if the task needs one.

## stop-rule

Only two consecutive empty evaluations end the relay: the one that starts the handoff and the successor's first. Stopping without open work counts as empty.

## next.retire

The successor inherits the open ledger. Write the handoff report now; do not call tools.

## inherited-ledger

Inherited open ledger: read it with todo({ op: "view" }) before writing your own.

## successor-mandate

Check the work and verification against the user's original request. Rerun relevant checks; look for missing or narrowed work. Treat the inherited report and ledger as claims, not proof.

## pinned-reading

Read the relevant Pinned Context documents in full before changing the work.

## successor-rule

Investigate before your first root todo write if needed. Until then, forks must declare permission: "ro". A todo view does not count. If your first evaluation finds open work, finish it and hand off again.

## successor-opening.head

Relay Handoff — Generation {{next}} (from {{prev}})

## successor-opening.pins

## Pinned Context

{{pins}}

## successor-start

Generation {{generation}}: audit the handoff above.

## handoff-failure

HANDOFF FAILED: {{message}}
Write the handoff report again in your message body; do not call tools.

## handoff-blocked

RELAY_HANDOFF_PENDING: write the handoff report in your message body instead.
