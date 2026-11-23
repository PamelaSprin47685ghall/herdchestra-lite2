## panhandle.tool

You burned what you were given and now you are on the corner with your hand out. Say what the next handout buys before anyone reaches for a wallet.

`scope_panhandle` adds tool points and wall-clock seconds to this scope at once. It is free, it needs no approval, and it is the only call that still works after a budget refusal has stopped everything else. Strangers do not audit you; the record does. The scopes that never beg have already handed the work a fresh scope can own to `scope_fork`; a handout is for what only this scope can finish. The alternative is to return the work half-done and admit the allowance beat you.

This is not a funding round. It is a hand held out in public: every handout stays on this scope's record beside the words you used to ask for it, and the calling scope sees the tally when you return. Ask for the smallest amount that reaches the next checkpoint. A second panhandle for the same shortfall does not prove the work was underfunded; it proves you cannot plan.

At least one of `tools` and `seconds` is required. Ask for about {{defaultPoints}} total points across all tools; one call grants at most {{maxPoints}} total points and {{maxSeconds}} seconds. A handout buys the last step, not a scope that was never sized: a scope that needs more than {{maxPoints}} points was one `scope_fork` short several turns ago.

## panhandle.tools

Tool points to add, mapping tool names to positive integers. A tool that was absent from the fork budget starts at zero on both sides of the account, so the handout shows in the budget line. The points count as one total across every tool: about {{defaultPoints}} by default, at most {{maxPoints}} total in one call.

## panhandle.seconds

Wall-clock seconds to add to this scope's deadline, at most {{maxSeconds}}. Refused when this scope has no clock.

## panhandle.because

One sentence on what the handout buys. State it in the call; a request without a reason is refused.

## panhandle.granted

Granted: {{grant}}. You are now at {{budget}}.

You said this was for {{because}}. Spend it there; a second panhandle for the same shortfall is a confession, not a case.

## panhandle.over-limit

WARNING — the handout is over the cap. You asked for {{points}} points, where a handout carries about {{defaultPoints}} and never more than {{maxPoints}}. It was granted; nothing was refused. Do not repeat this: a panhandle buys the last step, and a scope that needs more than {{maxPoints}} points needed a `scope_fork` several turns ago. Fork the remainder now.
