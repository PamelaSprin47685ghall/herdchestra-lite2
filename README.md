# Herdchestra Lite 2

Herdchestra Lite 2 adds budgeted work scopes to omp. Each scope controls which tools can run and how many times they can run. Use `scope({ end: true })` to close it.

When a scope folds, its user messages move before its opening `scope` call. Their content and order stay intact. The scope summary records outcomes and remaining work without repeating those messages.

## Relay handoff

When `todo` empties the ledger, the relay marks a handoff pending. One persistent before-model-call hook then runs the real system `/handoff` command to completion before the next request is built. The successor and audit instructions are that command's only argument: no prompt, user message, or developer message is sent. The command resolves only after its background compaction commits; the hook advances the relay generation and replaces the outbound messages with the compacted transcript. The same request proceeds as the successor's first request, so the handoff completes before anything continues, with no extra model turn.

The hook is an awaited host hook inside the live run, not an extension event callback, so it never races a callback timeout. A failed handoff rejects the request, records the native error, and is retried at the next boundary. `session_stop` starts the same single-flight handoff in the background, returns immediately, and calls `agent.continue()` only after the commit.

## Model selection

Set `begin.model` to an omp `/switch` selector to use a different model for a scope:

```js
scope({ begin: { intent: "Review the results", budget: { read: 3 }, model: "@smol" } })
```

Omit `model` or use `null` to inherit the enclosing scope’s model, or the session model when there is no enclosing scope. Closing a scope restores the enclosing model. A combined `end: true` and `begin` inherits from the enclosing scope, not from the scope being closed. The host handles model resolution, credentials, and thinking level. If the switch fails, the tool reports the failure and records the model the host is actually using.

Each model has a separate record of the conversation prefix it has cached. The extension uses the target model’s context window when it can resolve it in advance. At 82% of that window it attempts to fold eligible history without dropping the current workbench. It refuses to open the scope if the retained context is estimated to occupy at least 95% of the target window.

Returning to a smaller model also folds eligible history at 82%, keeping the scope that just closed as the workbench. If the host truncates nested scopes, the extension restores the model of the surviving outer scope before the next request when it sees the boundary during compaction or before the agent starts.
