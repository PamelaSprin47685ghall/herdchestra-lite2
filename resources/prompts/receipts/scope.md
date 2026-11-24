## amend.undone

Previous beat replaced. Refunded calls: {{refunded}}.

## amend.remaining

Budget: {{budget}}.

## pin.saved

OK. Update the `todo` ledger now with any change this note makes: the next step, a completed item, or a blocker. If this note carries the conclusion of the latest beat, amend that beat with `scope_context({ amend })`: the context keeps the note, not the search.

## scope.unreceived

Unreceived results from forked scopes: {{count}}. Receive them with `scope_join`.

## scope.stop-blocked

{{count}} unreceived result(s) from forked scopes. Call `scope_join` before stopping.

## receipt.branch

Scope budget: {{budget}}.

## receipt.branch-missing

Scope budget: unavailable; the ledger holds no record for this scope.

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

No ledger. A stop still hands off, but it never finishes the chain; use `todo` to record remaining work.

## receipt.view-required

Run `todo({ op: "view" })` before writing the inherited ledger.

## fork.child-status

{{marker}} depth {{depth}}.
State machine: {{fsm}}
Budget: {{budget}}. Targets: {{targets}}.

## fork.child-return

Report your findings. Only scope_return submits your full record.

## fork.child-return-nudge

Your record is still unpublished. Call `scope_return` to hand it to the scope that forked this one.

## language

（宿主扩展在每轮末尾附带的常规友情提醒，非用户新消息，请继续当前工作）强制以简体中文思考，尤其要以简体中文词开头。强制简体中文回答用户。

## fork.child-routing

User messages go to the stable root. Tool approvals appear there under this scope.
