## amend.undone

Previous beat replaced. Refunded calls: {{refunded}}.

## amend.remaining

Budget: {{budget}}.

## pin.saved

OK. Update the `todo` ledger now with any change this note makes: the next step, a completed item, or a blocker. If this note carries the conclusion of the latest beat, amend that beat with `scope_context({ amend })`: the context keeps the note, not the search.

## scope.unreceived

Unreceived child results: {{count}}. Receive them with `scope_join`.

## scope.stop-blocked

{{count}} unreceived child result(s). Call `scope_join` before stopping.

## receipt.branch

Scope budget: {{budget}}.

## receipt.no-ledger

Evaluate the ledger before forking.

## receipt.autopilot

Autopilot on: the relay runs; `ask` is unavailable.

## receipt.manual

Autopilot off: manual duty; `ask` is available.

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

{{marker}} depth {{depth}} (default tree depth {{defaultDepth}}, recommended through depth {{recommendedDepth}}).
Dafny pseudo-code: {{intent}}
Budget: {{budget}}. Targets: {{targets}}.

## fork.child-return

Report your findings. Only scope_return submits your full record.

## fork.child-return-nudge

Your record is still unpublished. Call `scope_return` to hand it to the parent.

## fork.child-routing

User messages go to the stable root. Tool approvals appear there under this fork.
