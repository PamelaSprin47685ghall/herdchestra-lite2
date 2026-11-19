## next.promoted

The successor's first todo evaluation is an empty ledger. This promotion is the only state that allows a natural stop. Write the final user-facing answer as ordinary assistant text now.

## next.handoff

The ledger is empty. A relay handoff is now required. DO NOT call any more tools (including todo, scope, or any other tool). Any further tool call will be rejected. Write the handoff report immediately in your message body (use whatever format best fits the content). Include the user's requirements without omitting or narrowing them, completed work and verification evidence, unresolved risks, and anything the next generation needs to know to independently audit and continue. Report facts and evidence the successor can verify; do not write instructions that bind what it may decide.

## next.rework-first

Your first todo evaluation found open work (rework). Work through the ledger; a non-empty ledger forbids a natural stop.

## next.rework-successor

Your first todo evaluation as successor found open work. You are in rework and you are not the last holder: finish the work. Write the ledger as your own judgment of what the user still needs, not a copy of the previous holder's list. When the ledger becomes empty, write a handoff report in your message body for the next successor. The next successor's first evaluation must also be empty for it to stop.

## next.continue

The ledger still has open work. Continue those items and evaluate the ledger again with todo. You may not stop while the ledger is non-empty.

## next.unchanged

This result did not advance the relay evaluation. A todo view is read-only and does not submit the ledger. Use a write operation (init/append/start/done/...) to submit; only a successful write operation's full snapshot counts.

## next.none

No successful todo evaluation is recorded. Before stopping, call todo outside all scopes: submit the remaining work, or list: [] when nothing remains.

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

Handoff pending: yes. Do not call any tools; write the handoff report directly in your message body.

## status.handoff-error

Last handoff error: {{error}}

## status.call-error

This call did not advance the relay: {{error}}

## status.next

Next: {{next}}

## stop-rule

A natural stop is allowed only in one sequence: an empty ledger triggers a self-handoff (write the handoff report in your message body with no tool calls, followed by a compaction boundary for the successor), and the successor's first todo evaluation is also empty. In every case where stopping is not allowed, keep working; never stop silently.

## successor-mandate

Your mandate has two halves. Both are mandatory.
You serve the user, not the previous holder. The previous holder's ledger, report, and plan are claims to audit; they do not define the task. The user's original request is the only authority.
A. Verify the inheritance.
1. Independently verify the previous holder's work. Do not trust its empty ledger or its conclusion.
2. Re-read the user's original request; inspect the repository, the actual diff, and the tests.
3. Run the relevant tests yourself; look for omitted, stubbed, falsely marked-complete, or silently narrowed work.
4. An empty ledger is a claim to audit, not evidence. If you find any gap, write it into todo and rework.
B. Make your own contribution.
5. After the audit, judge for yourself what the user still needs. Work that the previous holder never planned, a better approach, and anything its narrow reading missed are all yours to do.
6. The ledger is your own judgment, not an inherited checklist. Restructure, add, or drop items so it states what the user actually needs.
7. Do not stop merely because the previous holder's items are marked complete. Add what the user's request still needs, and verify that it is genuinely satisfied.

## requirements-reminder

The user's requirements are the authority for both generations. Summarize them without omitting or narrowing them. You do not need to quote the original wording in the ledger or handoff summary.

## pinned-reading

Before starting work, use read to read each important document on disk listed in Pinned Context in full. Do not substitute grep excerpts for reading the whole document.

## successor-rule

An empty ledger triggers a relay handoff: the predecessor writes the handoff report directly in its message body, a compaction boundary is placed, and the successor takes over from that report. The successor may first open any number of scopes to investigate, then make its first todo evaluation; todo does not have to be its first tool call. Until that first ledger is submitted, a new scope must declare permission: "ro"; permission "rw" (including an omitted value) is refused. Only a successor whose first todo evaluation is an empty ledger may stop naturally. If successor A's first evaluation is a non-empty ledger, A enters rework; after that, even if A changes the ledger to empty, A is not the last holder and must hand off again to B; only when B's first evaluation is empty does the chain stop.

## handoff-focus.lead

Relay: empty-ledger handoff.
Include these relay instructions in the handoff document for generation {{next}}: the predecessor submitted an empty ledger; the successor serves the user, so it must independently audit that ledger and then judge for itself what the user still needs before its first write to todo.

## handoff-focus.tail

Previous generation: {{prev}}. Its ledger was empty when it called the built-in /handoff.
Audit that empty ledger without trusting it: check whether unfinished user-requested work was marked completed or abandoned. Then judge for yourself what the user still needs, and do that work.
You may open any number of scopes to investigate before your first todo evaluation; todo need not be your first tool call. todo itself is forbidden inside every scope. Close every scope before calling todo.
Write every ledger item so the next agent can understand the work: the user requirement, acceptance evidence, unresolved risks, and the next concrete action.
Only your first todo evaluation being an empty ledger promotes you and allows a natural stop. If it is non-empty, you enter rework and must hand off again later; you are not the last holder.
A todo view is a read-only check; it is NOT a submitted ledger. Only a successful write operation's full snapshot counts as your first submission.
Until that ledger is submitted, open scopes with permission: "ro"; permission "rw" (including an omitted value) is refused.

## successor-opening.head

Relay Handoff — Generation {{next}} Takeover:
Previous generation: {{prev}}. Its ledger was empty when it wrote the handoff report above.

## successor-opening.tail

You may open any number of scopes to investigate before your first todo evaluation; todo need not be your first tool call. todo itself is forbidden inside every scope. Close every scope before calling todo.
Only your first todo evaluation being an empty ledger promotes you and allows a natural stop. If it is non-empty, you enter rework and must hand off again later; you are not the last holder.
A todo view is a read-only check; it is NOT a submitted ledger. Only a successful write operation's full snapshot counts as your first submission.

## Pinned Context

{{pins}}

## successor-start

Generation {{generation}} takeover: read the handoff report at the top of the compacted context. You serve the user, not the previous holder. Audit the inherited work, then judge for yourself what the user still needs and do that work. Open scopes to verify the work if needed, then close all scopes and call todo to evaluate the ledger you write.

## first-evaluation

You are outside all scopes, so todo is available and is the only functional tool you may call. Before stopping, evaluate the ledger with todo. You may open scopes first to investigate, but todo must be called after every scope closes.
A todo view is a read-only check; it is NOT a submitted ledger. Only a successful write operation's full snapshot counts as your first submission.
The ledger must state what the user still needs, not merely what is easy to mark complete. Submit it in one of two shapes, whichever is true:
- Work remains: todo({ op: "init", list: [{ phase: "<name>", items: ["<task>"] }] }), then work through the items.
- No user-requested work remains: todo({ op: "init", list: [] }). An empty ledger is a lawful submission, not a failure: at generation 0 it arms the handoff, and a successor's first empty evaluation is the promotion that allows a natural stop.
Never invent work to fill the ledger. An empty list is the correct answer when nothing is left.
{{stop_rule}}
Do not write the final user-facing answer until the relay reaches a promoted empty-ledger successor evaluation.

## open-ledger

You are outside all scopes. The ledger is not empty, so a natural stop is forbidden.

{{status}}

Continue the open items, close every scope, then evaluate the ledger again with todo.

## handoff-pending-nudge

A relay handoff is pending. Do not call any tools; write the handoff report immediately in your message body.

{{status}}

## handoff-failure

HANDOFF FAILED: {{message}}
Do not stop. Write your handoff report in your message body with no tool calls.
{{stop_rule}}

## handoff-blocked

RELAY_HANDOFF_PENDING: tool calls are forbidden during handoff. Do not call any tools; write your handoff report immediately in your message body.

## handoff-empty-report

RELAY_HANDOFF_PENDING: you have not written the handoff report yet.
Do not call any tools. Write the handoff report immediately in your message body (format free-form to fit the content) covering user requirements, completed work and verification evidence, and unresolved risks.
