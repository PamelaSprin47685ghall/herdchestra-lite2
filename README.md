# Herdchestra Lite 2

Herdchestra Lite 2 adds budgeted work scopes to omp. Each scope controls which tools can run and how many times they can run. Use `scope({ end: true })` to close it.

When a scope folds, its user messages move before its opening `scope` call. Their content and order stay intact. The scope summary records outcomes and remaining work without repeating those messages.

## Relay handoff

When `todo` empties the ledger, the relay arms a handoff transaction and the next provider request is refused by a synchronous `agent.addBeforeModelCall` gate. The gate never awaits the handoff: it starts one background ticket and returns `{ stop: true }`, so no request is built on the empty ledger and no extra model turn is spent.

The ticket waits for `session.waitForRunEnd()`, then calls `session.compact(focus, { mode: "handoff" })`. That is exactly what the builtin `/handoff` and the RPC `handoff` command call; `focus` is the command's only argument, so no prompt, user message, or developer message is sent. The call resolves only after its background compaction commits. The ticket then advances the relay generation and calls `agent.continue()`; the successor's first request is a fresh request on the compacted transcript.

The transaction records the session id, the branch handoff count, and the source generation before compaction. After the commit, the count must grow before the generation advances. If the process stops between the commit and the advance, the next gate recognizes the new handoff entry and advances idempotently instead of compacting twice. A pending station belongs to its session manager: a `/new` or session switch never routes the next stop to the old session.

## Model selection

Set `begin.model` to an omp `/switch` selector to use a different model for a scope:

```js
scope({ begin: { intent: "Review the results", budget: { read: 3 }, model: "@smol" } })
```

Omit `model` or use `null` to inherit the enclosing scope’s model, or the session model when there is no enclosing scope. Closing a scope restores the enclosing model. A combined `end: true` and `begin` inherits from the enclosing scope, not from the scope being closed. The host handles model resolution, credentials, and thinking level. If the switch fails, the tool reports the failure and records the model the host is actually using.

Each model has a separate record of the conversation prefix it has cached. The extension uses the target model’s context window when it can resolve it in advance. At 82% of that window it attempts to fold eligible history without dropping the current workbench. It refuses to open the scope if the retained context is estimated to occupy at least 95% of the target window.

Returning to a smaller model also folds eligible history at 82%, keeping the scope that just closed as the workbench. If the host truncates nested scopes, the extension restores the model of the surviving outer scope before the next request when it sees the boundary during compaction or before the agent starts.
