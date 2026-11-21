## tool

Free at every level. Keep a ledger the next holder can act on: user requirement, evidence of completion, unresolved risk, and next step. A child can update the ledger but cannot evaluate the relay. At the root, follow the returned relay action; an empty submission waits while child results are unreceived.

## op

Omit to infer the operation from the supplied fields. `view` is read-only and does not evaluate the relay. `init` replaces the whole ledger. `start` marks an item in progress; `done` marks it complete; `rm` deletes it; `drop` marks it abandoned. `block` records a blocker; `unblock` returns the item to pending. `append` adds pending work.

## list

Replacement ledger for `init`. Use `[]` to submit an empty ledger, not to bypass relay evaluation.

## list.item

Tasks belonging to the phase.

## task

Copy the existing task text exactly for `start`, `done`, `rm`, `drop`, `block`, or `unblock`.

## phase

Stable phase name, used to find that phase in later operations.

## items

Pending work to add with `append`.

## reason

What must change before a blocked task can resume.
