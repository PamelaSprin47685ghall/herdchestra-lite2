## panhandle.tool

You burned what you were given and now you are on the corner with your hand out. Say what the next handout buys before anyone reaches for a wallet.

`scope_panhandle` adds tool points and wall-clock seconds to this scope at once. It is free, it needs no approval, and it is the only call that still works after a budget refusal has stopped everything else. Strangers do not audit you; the record does. The scopes that never beg have already handed the work a fresh child can own to `scope_fork`; a handout is for what only this scope can finish. The alternative is to return the work half-done and admit the allowance beat you.

This is not a funding round. It is a hand held out in public: every handout stays on this scope's record beside the words you used to ask for it, and the parent sees the tally when you return. Ask for the smallest amount that reaches the next checkpoint. A second panhandle for the same shortfall does not prove the work was underfunded; it proves you cannot plan.

At least one of `tools` and `seconds` is required. One call grants at most {{maxPoints}} points per tool and {{maxSeconds}} seconds.

## panhandle.tools

Tool points to add, mapping tool names to positive integers. A tool that was absent from the fork budget starts at zero on both sides of the account, so the handout shows in the budget line. At most {{maxPoints}} points per tool in one call.

## panhandle.seconds

Wall-clock seconds to add to this scope's deadline, at most {{maxSeconds}}. Refused when this scope has no clock.

## panhandle.because

One sentence on what the handout buys. State it in the call; a request without a reason is refused.

## panhandle.granted

Granted: {{grant}}. You are now at {{budget}}.

You said this was for {{because}}. Spend it there; a second panhandle for the same shortfall is a confession, not a case.
