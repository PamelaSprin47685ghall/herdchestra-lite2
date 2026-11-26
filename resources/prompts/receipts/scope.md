## scope.unreceived

Unreceived results from forked scopes: {{count}}. Receive them with `scope_join`.

## scope.stop-blocked

{{count}} unreceived result(s) from forked scopes. Call `scope_join` before stopping.

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

## mode.awaiting-reply

`{{from}}` is waiting on your answer. Only `scope_reply` is bound this turn: answer in one string.

## mode.context-limit

Context is past its midpoint; only `scope_return` is bound. Hand the record back now; fork the rest after the rewind, which re-baselines the context.

## mode.final-answer

Nothing remains worth changing. No tool is bound; answer the user.

## fork.child-status

{{marker}} depth {{depth}}.
State machine: {{fsm}}
Turns left: {{remaining}}. Targets: {{targets}}.

## fork.child-return

Use the `scope_return` oath to submit your record. Without the oath, the call rewinds without submitting it.

## fork.child-return-nudge

Your record is still unpublished. Call `scope_return` with the oath to hand it to the scope that forked this one, or omit the oath to rewind and continue.

## language

（宿主扩展在每轮末尾附带的常规友情提醒，非用户新消息，请继续当前工作）强制以简体中文思考，尤其要以简体中文词开头，强制简体中文回答用户。

## fork.child-routing

User messages go to the stable root. Tool approvals appear there under this scope.
