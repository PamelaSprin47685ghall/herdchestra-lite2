## amend.undone

Previous beat replaced. Refunded calls: {{refunded}}.

## amend.remaining

Budget: {{budget}}.

## scope.unreceived

Unreceived child results: {{count}}. Receive them with `scope_join`.

## scope.stop-blocked

{{count}} unreceived child result(s). Call `scope_join` before stopping.

## receipt.branch

Budget: {{budget}}.

## receipt.no-ledger

Until the first `todo` write, fork with `permission: "ro"`.

## receipt.herd

Herd mode on: `ask` or pause for the user.

## receipt.herd-off

Herd mode off.

## receipt.can-stop

Ready to answer the user.

## receipt.todo

Evaluate the ledger with `todo` before stopping.

## receipt.close-handoff

Write the handoff report after receiving those results.

## receipt.simple-outside

No ledger. Stopping counts as an empty evaluation; use `todo` to record remaining work.

## receipt.view-required

Run `todo({ op: "view" })` before writing the inherited ledger.

## fork.child-status

{{marker}} depth {{depth}}.
Intent: {{intent}}
Budget: {{budget}}. Permission: {{permission}}.

## fork.child-return

Report your findings. Only scope_return submits your full record.

## fork.child-return-nudge

You stopped without calling scope_return. That breaks the branch contract: a natural stop submits nothing. Your record stays unpublished until scope_return carries your conclusions and evidence. Continue the work now; do not stop again without returning.

## fork.child-routing

User messages go to the stable root. Tool approvals appear there under this fork.
