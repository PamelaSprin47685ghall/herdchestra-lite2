## next.promoted

Write the final answer. Full flow has ended.

## next.finish

Write the final answer.

## next.reopened

This write turns the full flow back on. You may still write the final answer.

## handoff-demand

Write the handoff report in your message body now; do not call tools. Let the content decide its format: there is no template and no required list of sections. The user's prompts are preserved verbatim for your successor, so do not restate them. Write what the successor cannot recover from the code, the files, the prompts preserved above, and the pins: completed work, verification evidence, unresolved risks, and where fact ends and judgment begins.

## successor-opening.user-prompts

## User Prompts (verbatim)

These are the user's own prompts, oldest first, preserved by the relay. They are the requirement record; the handoff report does not repeat them.

{{prompts}}

## next.rework-first

Work through the open items.

## next.rework-successor

Rework: use your own assessment of the user's requirements. Hand off again when the ledger is empty.

## next.continue

Continue the open items. If you stop with work open, the next generation inherits it.

## next.unchanged

No relay evaluation. Only a successful todo write counts.

## next.inside-scope

Scope level {{level}} ledger updated; this call did not advance the root relay.

## next.held-children

Empty ledger held: {{open}} unreceived result(s) from forked scopes. Receive them with scope_join, then resubmit.

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

A natural stop hands off without advancing the relay. Submit a todo ledger only if the task needs one.

## stop-rule

Only two empty evaluations end the relay: the one that starts the handoff and the successor's first. A natural stop is never one of them; it hands off without advancing the count.

## next.retire

The successor inherits the ledger on record. Write the handoff report now; do not call tools.

## inherited-ledger

Inherited open ledger: read it with todo({ op: "view" }) before writing your own.

## successor-mandate

You serve the user, not the previous holder. Read the handoff as context. Own the ledger as your own judgment of what the user still needs. Make your own contribution if appropriate. A pending check may travel to you; name what settles it and who owns it next.

## pinned-reading

Read the relevant Pinned Context documents in full before changing the work.

## successor-rule

Investigate before your first root todo write if needed. A todo view does not count. If your first evaluation finds open work, finish it and hand off again.

## successor-opening.head

Relay Handoff — Generation {{next}} (from {{prev}})

## successor-opening.pins

## Pinned Context

{{pins}}

## successor-start

Generation {{generation}}: continue from the handoff above.

## handoff-failure

HANDOFF FAILED: {{message}}
Write the handoff report again in your message body; do not call tools.

## handoff-blocked

RELAY_HANDOFF_PENDING: write the handoff report in your message body instead.
