# Herdchestra Lite 2

Herdchestra Lite 2 adds budgeted work scopes to omp. Each scope controls which tools can run and how many times they can run. Use `scope({ end: true })` to close it.

When a scope folds, its user messages move before its opening `scope` call. Their content and order stay intact. The scope summary records outcomes and remaining work without repeating those messages.

## Relay handoff

When `todo` requests a handoff, it returns the ledger without waiting for the summary. On omp builds with the model-call gate, the next model request waits for the built-in `/handoff` to finish and uses its compacted history. The audit instructions go only in the `/handoff` argument; the extension does not send a separate message. A failed handoff blocks that request. If no request is about to start, `session_stop` schedules the handoff in the background without starting a new turn.

## Model selection

Set `begin.model` to an omp `/switch` selector to use a different model for a scope:

```js
scope({ begin: { intent: "Review the results", budget: { read: 3 }, model: "@smol" } })
```

Omit `model` or use `null` to inherit the enclosing scope’s model, or the session model when there is no enclosing scope. Closing a scope restores the enclosing model. A combined `end: true` and `begin` inherits from the enclosing scope, not from the scope being closed. The host handles model resolution, credentials, and thinking level. If the switch fails, the tool reports the failure and records the model the host is actually using.

Each model has a separate record of the conversation prefix it has cached. The extension uses the target model’s context window when it can resolve it in advance. At 82% of that window it attempts to fold eligible history without dropping the current workbench. It refuses to open the scope if the retained context is estimated to occupy at least 95% of the target window.

Returning to a smaller model also folds eligible history at 82%, keeping the scope that just closed as the workbench. If the host truncates nested scopes, the extension restores the model of the surviving outer scope before the next request when it sees the boundary during compaction or before the agent starts.
