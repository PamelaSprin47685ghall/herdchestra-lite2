## scope.unreceived

Unreceived results from forked subscopes: {{count}}. Receive them with `scope_join`.

## scope.stop-blocked

{{count}} unreceived result(s) from forked subscopes. Call `scope_join` before stopping.

## receipt.autopilot

Autopilot on: `ask` is unavailable.

## receipt.manual

Autopilot off: manual duty; `ask` is available.

## receipt.can-stop

Ready to answer the user.

## receipt.return-required

Call `scope_return` before stopping. The oath field is required: pass `unfinished` to rewind and continue, or the seal value if nothing is left to change.

## root.return-nudge

Call `scope_return` alone with fresh `dafny` and the required oath: `unfinished` to rewind and continue, the seal value only if nothing is left to change.

## mode.abandoned

This scope was abandoned by `{{by}}`{{reasonClause}}. Only `scope_return` is bound: hand back your current findings and partial state in `dafny` now (no rewind will happen).

## mode.context-limit

Context is past its midpoint; only `scope_return` is bound. Hand the record back now with the oath `unfinished`; fork the rest after the rewind, which re-baselines the context.

## mode.final-answer

Nothing remains worth changing. No tool is bound; answer the user.

## fork.subscope-status

{{marker}} depth {{depth}}, upscope {{upscopePath}}, caller {{callerPath}}.
State machine: {{fsm}}
Turns left: {{remaining}}. Targets: {{targets}}.

## fork.subscope-cross-caller

Your context was inherited from {{upscopePath}}, but your `scope_return` delivers to caller {{callerPath}} (which does not share {{upscopePath}}'s context). Put every fact, path, and deduction {{callerPath}} needs into `dafny`.

## fork.subscope-return

Use `scope_return` to submit your record. The oath field is required: `unfinished` rewinds without submitting it; the seal value publishes it to {{callerPath}}.

## fork.subscope-return-nudge

Your record is still unpublished. Call `scope_return` with the seal value to hand it to your caller, or with `unfinished` to rewind and continue.

## fork.subscope-routing

User messages go to the stable root (`/`). Tool approvals appear there under this scope's path.

## language

（宿主扩展在每轮末尾附带的常规友情提醒，非用户新消息，请继续当前工作）强制以简体中文思考，尤其要以简体中文词开头，强制简体中文回答用户。
