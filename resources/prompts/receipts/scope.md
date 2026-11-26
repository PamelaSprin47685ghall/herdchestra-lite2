## amend.undone

Previous beat replaced. Refunded calls: {{refunded}}.

## amend.remaining

Budget: {{budget}}.

## pin.saved

Pin saved. If this note carries the conclusion of the latest beat, amend that beat with `scope_context({ amend })`: the context keeps the note, not the search.

## scope.unreceived

Unreceived results from forked scopes: {{count}}. Receive them with `scope_join`.

## scope.stop-blocked

{{count}} unreceived result(s) from forked scopes. Call `scope_join` before stopping.

## receipt.branch

Scope budget: {{budget}}.

## receipt.branch-missing

Scope budget: unavailable; the ledger holds no record for this scope.

## receipt.autopilot

Autopilot on: `ask` is unavailable.

## receipt.manual

Autopilot off: manual duty; `ask` is available.

## receipt.can-stop

Ready to answer the user.

## receipt.return-required

Call `scope_return` before stopping: rewind to continue, or take the oath if nothing is left to change.

## root.return-nudge

Call `scope_return` alone with fresh `dafny`. Omit the oath to rewind and continue; take the oath only if nothing is left to change.

## fork.child-status

{{marker}} depth {{depth}}.
State machine: {{fsm}}
Budget: {{budget}}. Targets: {{targets}}.

## fork.child-return

Use the `scope_return` oath to submit your record. Without the oath, the call rewinds without submitting it.

## fork.child-return-nudge

Your record is still unpublished. Call `scope_return` with the oath to hand it to the scope that forked this one, or omit the oath to rewind and continue.

## language

（宿主扩展在每轮末尾附带的常规友情提醒，非用户新消息，请继续当前工作）强制以简体中文思考，尤其要以简体中文词开头。强制简体中文回答用户。

## fork.child-routing

User messages go to the stable root. Tool approvals appear there under this scope.
