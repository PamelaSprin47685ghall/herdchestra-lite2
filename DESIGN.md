# Herdchestra Lite 2.0 — design contract

Plain `.mjs` omp extension. No ClojureScript, no sandbox, no board, no stages.
Four tools: `scope`, `regret`, `defer`, `pin`. Built-in tools stay installed; the
`tool_call` hook blocks every non-control tool outside a scope and charges the
innermost scope's budget for every allowed call.

## Scope ADT

`scope({ begin: { intent, budget } })` or `scope({ end: { return_markdown } })`.
`intent` names one task of moderate scope: if the whole user request needs
about n tool calls, a moderate scope covers about sqrt(n) of them. Size
`budget` so its total across tools is roughly sqrt(n).
`budget` is `{ [exactToolName]: nonNegativeInteger }`. Absent tool => zero.
`scope`, `regret`, `defer`, and `pin` are free and are never budgeted.
Several calls to the same tool in one assistant message are one batch and
consume one unit of that tool's budget; budget and spend by batches, not
individual calls.
For a heavy task, also budget `task`: parallel subagent workers take
independent slices at once, and one batch of `task` calls costs one unit.

Scopes nest. Only the innermost scope's budget is consumed.

`begin` returns `You are now inside this scope.` plus intent/budget state.
`end`:
1. Pops the innermost scope.
2. The closing scope's immediately elder sibling at the same level is
   collapsed, if one exists: that sibling's begin tool result is replaced by
   `You have finished this scope. Here is your report: <return_markdown>` and all
   messages between that begin result and the assistant message that carried
   that sibling's `end` call are removed (in-place fork), except the begin
   beat's own tool results, which stay to keep the tool-call sequence valid.
   Pin calls and their results inside the removed interior survive: they move
   after the collapsed scope's end beat.
   The scope that just closed stays visible until a younger sibling closes.
   Collapse order is sibling order, not global close order. A parent close
   does not collapse its children; an enclosing scope's later collapse removes
   their receipts.
3. All defers collected in the scope are delivered as one user steering prompt.
4. After the pop, if an enclosing scope remains, the model is back inside it;
   the tool result shows its intent and remaining budget. Only when no scope
   remains is the model outside all scopes. More tool work requires a scope.
   The final user-facing report is ordinary assistant text, written only
   outside all scopes. Finishing is never a tool call.

`return_markdown` is a self-delivery report: it becomes the scope's begin
receipt for later scopes. The user-facing answer is ordinary assistant text,
not `return_markdown`.

## State

```js
{
  version: 1,
  seq: 0,
  scopes: [{
    id: "scope-1",
    intent: "…",
    beginToolCallId: "call_…",
    budget: { bash: 6, read: 7 },
    remaining: { bash: 6, read: 7 },
    spent: { bash: 0, read: 0 },
    defers: [{ toolCallId, intent }],
    residualDefers: [{ toolCallId, intent }]
  }],
  charges: { [toolCallId]: { scopeId, tool, amount, groupKey } },
  regrets: ["tc:call_a,call_b", "msg:timestamp:hash"],
  collapses: [{
    beginToolCallId, endToolCallId, report,
    parentId, order, collapsed, createdAt
  }]
}
```

`residualDefers` holds defer texts withdrawn by `regret`; they remain valid and
are still delivered when the scope ends. `regrets` holds beat keys removed by
`regret`; they are filtered from every outbound request. `collapses` holds every
closed scope. `collapsed: false` means the scope is still fully visible;
`collapsed: true` means its begin receipt has replaced its interior. `parentId`
is the enclosing scope id or null; `order` is the creation order. This makes the
scope-end history replacement idempotent and sibling-local.

## `src/engine.mjs` (pure, no I/O)

Export exactly:

- `createState()` -> fresh version-1 state.
- `currentScope(state)` -> innermost scope or `null`.
- `beginScope(state, { toolCallId, intent, budget })`
  -> `{ ok: true, scope }` or `{ ok: false, code, reason }`.
  Validate: non-empty trimmed intent; plain budget object; every key non-empty
  string; every value an integer >= 0. Push the scope. `scope.id` is
  `scope-<++seq>`.
- `chargeTool(state, { toolCallId, toolName, groupKey })`
  -> `{ ok: true, remaining }` or `{ ok: false, code, reason }`.
  No scope => `NOT_IN_SCOPE`. No budget key or zero => `BUDGET_EXHAUSTED`
  (mention the tool and remaining budget). Otherwise decrement `remaining`,
  increment `spent`, record
  `charges[toolCallId] = { scopeId, tool, amount: 1 }`, and return
  `{ ok: true, remaining }`. Repeating the same `toolCallId` must not
  double-charge; it returns the current `remaining` without changing state.
  Same `groupKey` and same normalized tool in one scope charge once; later
  calls in the batch return the current `remaining` without deducting again.
  Different tools in the same batch charge separately.
- `deferIntent(state, { toolCallId, intent })`
  -> `{ ok: true }` or `{ ok: false, code, reason }`. Requires a scope and a
  non-empty trimmed intent. No budget charge.
- `closeScope(state, { toolCallId, report })`
  -> `{ ok: true, scope, defers, steerText }` or
  `{ ok: false, code, reason }`. Requires a scope and a non-empty trimmed
  report. Pop the innermost scope. Collect `defers` + `residualDefers`,
  deduplicate by trimmed intent text preserving first occurrence. Remove all
  `charges` whose `scopeId` is the closed scope. Return `steerText` = the
  English user-prompt text that lists the deferred findings; `""` when none.
- `applyRegret(state, { scopeId, beat, toolCalls })`
  -> `{ ok: true, refunded, residualDefers, remaining }` or
  `{ ok: false, code, reason }`.
  `beat` is `{ key, toolCallIds }`; `toolCalls` is
  `[{ id, name, arguments }]` for that beat. For each call:
  - no active scope => `NOT_IN_SCOPE`; missing `beat.key` => `INVALID_BEAT`;
  - if `charges[id]` belongs to `scopeId`, add the amount back to `remaining`
    and subtract from `spent`, delete the charge, count it in `refunded`;
  - if the call is `defer`, remove that defer from the scope's `defers` (match
    by toolCallId) and push it to `residualDefers` (dedupe by toolCallId).
  Push `beat.key` to `regrets`. Return updated remaining.
- `regretRemaining(state, scopeId)`? No — use `scope.remaining` directly.
- `budgetText(scope)` -> deterministic comma list, e.g.
  `bash 3/6, read 2/7`, sorted by tool name; `""` when there is no budget.
- `serializeState(state)` / `deserializeState(data)`
  -> JSON-safe object / state. `deserializeState` accepts either a JSON-safe
  object or a JSON string. Validate `seq` as a non-negative integer, every
  scope's counts and defers, every charge, every regret, and every collapse.
  Reject unknown versions, malformed input, or invalid fields by returning a
  fresh state. Ignore unknown fields. Never throw on malformed data.

All functions mutate the passed state. Keep them boring and synchronous.

## `src/transcript.mjs` (pure, no I/O)

Message shapes follow omp:

- assistant `{ role: "assistant", content: [{ type: "text" | "thinking" | "toolCall", ... }], timestamp }`
- tool result `{ role: "toolResult", toolCallId, toolName, content, isError, timestamp }`
- user `{ role: "user", content, timestamp }`
- custom `{ role: "custom", customType, content, ... }`

Export exactly:

- `toolCalls(message)` -> `[]` or `[{ id, name, arguments }]`.
- `beatKey(message)` -> stable key. Assistant with tool calls:
  `tc:` + sorted ids joined by `,`. Otherwise
  `msg:` + timestamp + `:` + FNV-1a hash of the joined text/thinking content.
- `exitBeat(messages, assistantIndex)` -> `{ key, toolCallIds, calls }` for the
  assistant at that index.
- `findToolCallIndex(messages, toolCallId)` -> index of the assistant message
  containing that call, or -1.
- `findBegin(messages, beginToolCallId)`
  -> `{ assistantIndex, resultIndex, assistant, result }` or `null`.
  `resultIndex` is the first `toolResult` with that `toolCallId` after the
  assistant.
- `findRegretTarget(state, messages, currentAssistantIndex, scope)`
  -> `{ ok: true, beat, toolCalls }` or `{ ok: false, code, reason }`.
  Scan backwards from `currentAssistantIndex - 1` for assistant messages.
  Skip beats whose key is in `state.regrets`. Stop and reject
  `SCOPE_BOUNDARY` when the candidate is at or before the assistant message
  that carries `scope.beginToolCallId`. Reject `SCOPE_BOUNDARY` if the
  candidate contains any tool call named `scope`. Reject `OUTSIDE_SCOPE` if
  any charged tool call in the candidate belongs to a different scope. Skip
  pure user/toolResult messages. If none, reject `NO_BEAT`.
- `filterRegrets(messages, regrets)` -> new array. Drop every assistant whose
  `beatKey` is in `regrets`, and every `toolResult` whose `toolCallId` belongs
  to one of those assistants.
- `applyCollapses(messages, collapses)` -> new array. Apply only records with
  `collapsed !== false`, in array order: find the begin assistant/result and
  the assistant carrying
  `endToolCallId`. If all three exist and the end is after the begin result,
  replace the begin result content with
  `You have finished this scope. Here is your report: <report>` (preserve
  `toolCallId`, `toolName`, `isError: false`, `timestamp`, `details`) and
  remove every message strictly between the begin result and the end
  assistant, except tool results belonging to the begin assistant's own beat.
  Pin calls and their results are kept and moved after the end assistant's
  tool results. Idempotent when already collapsed.
- `PIN_TOOL_NAME` -> `"pin"`.
- `collectPinnedMessages(messages, { start, end, skipResultIds })` -> pin
  assistant messages (text/thinking blocks plus pin calls) and pin tool
  results inside the range, in order; `skipResultIds` keeps results that
  already survive in place. Used by collapse.
- `finishedReport(report)` -> exact string
  `You have finished this scope. Here is your report: ${report}`.
- `rewriteVibeMessage(message)` -> message; if
  `role === "custom" && customType === "vibe-mode-context" && typeof content === "string"`,
  apply the two exact replacements from Lite and return a shallow copy when
  changed. Otherwise return the same object.
- `appendUserTail(messages, text)` -> new array with one final
  `{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }`.

## Host wiring (`src/main.mjs`, `src/runtime.mjs`)

- Register `scope`, `regret`, `defer`, `pin` with `executionMode: "sequential"`.
- `assistant_message` hook processes all control calls in a finalized
  assistant message before tool dispatch, in this order: every `regret` (in
  message order), then every `scope` / `defer` / `pin` in message order.
  - `begin` opens a scope. `defer` records. `pin` returns `OK` and stores
    nothing. `end` closes and performs the
    persistent fork for the elder sibling at the same level: branch the session
    manager to that scope's begin assistant's parent, append a copy of the
    begin assistant, append a `toolResult` with the begin `toolCallId` whose
    text is `finishedReport(report)`, then replay the persisted tail from the
    previous end call onwards unchanged.
    Folding is presentation only: when the elder's begin is no longer on the
    branch (compaction, restore, or an earlier fork), mark the record collapsed
    and close anyway. A close never fails because history is missing.
    Persist the updated scope state as a `scope.state` custom entry on the new
    branch. Queue the defer steering prompt with
    `pi.sendUserMessage(text, { deliverAs: "steer" })`.
  - Store the control tool's result in an in-memory `handled` map keyed by
    `toolCallId`; the tool's `execute` returns it. If the map is absent, the
    execute fallback performs the same transition.
  - `scope begin` and `scope end` in the same assistant message is rejected
    with `SAME_MESSAGE_BOUNDARY`.
- `tool_call` hook: for non-control tools, call `chargeTool`; on failure return
  `{ block: true, reason }`. Persist after a successful charge. This is also
  the fallback that processes unprocessed controls in the current assistant
  message (covers resumed tool batches).
- `context` hook:
  1. base = `event.messages`;
  2. `filterRegrets`;
  3. `applyCollapses(...)` so only records marked `collapsed: true` are
     rewritten; the newest closed scope stays visible;
  4. rewrite vibe messages;
  5. append one user tail with
     `<additional-system-instructions>…</additional-system-instructions>`
     and the unchanged language `<system-reminder><skill …>…</skill></system-reminder>`.
     Outside every scope the instruction text is exactly
     `You are not in a scope. Before using any tool, start a scope; otherwise finish the task. You are outside all scopes: write the final user-facing answer as ordinary assistant text. return_markdown is your self-delivery report, not the user-facing answer. Finishing is not a tool call, and there is no finish tool.`
     Inside, report depth, intent, and `budgetText` per scope (innermost is
     authoritative), and forbid the final user-facing conclusion. A finalized
     assistant message with no tool calls while a scope is active queues a
     steering nudge. Always include the additional-system-instructions wrapper.
- Scope state is per `ctx.sessionManager`, restored from the newest
  `scope.state` custom entry on the current branch. Persist after every
  transition. Unknown/corrupt state => fresh state.
  On restore, drop active scopes and mark collapse records whose begin is not
  in the visible transcript as collapsed, so state and branch start aligned.
- After a fork, optionally rebase `session.agent.state.messages` from
  `sessionManager.buildSessionContext().messages` when the live session is
  available; outbound correction must not depend on it.
- `before_agent_start`: inject the retained English repo-aware prompt as a
  managed block, exactly like Lite (idempotent markers). Do not add scope
  mechanics to it.
- `regret` tool: reflection non-empty; only inside a scope; one call undoes one
  previous beat. Return refund summary.
- `defer` tool: intent non-empty; only inside a scope; return `OK`.
- `pin` tool: every field optional and Markdown; works inside or outside a
  scope; no budget charge; always returns `OK`. Collapse preserves its
  assistant message and tool result after the collapsed scope's end beat.

## Status display (`src/usage.mjs`, `src/status.mjs`)

Ported from Lite's `show-usage!`, `show-session-prefix!`, and `show-host!`.

- The native working line is never modified: never call `ui.setWorkingMessage`.
  Never call `setHookWidget`.
- One widget line above the editor: `<user@short-host>  ---  <usage>  ---
  <session prefix>`, written with
  `ui.setWidget("herd", [line], { placement: "aboveEditor" })`. Empty parts are
  omitted. The host label and each bracketed `[¥…]` amount, brackets included,
  use `ui.theme.fg("accent", text)`; everything else, including the `---`
  separators, uses `ui.theme.fg("dim", text)`.
- Text: `Δ: <input> × <cache-read%> → <output> [¥<cost>]; Σ: <same over all
  sessions>;`, with `k` and one-decimal percentages, cost to three decimals in
  mathematical bold digits.
- Snapshot aliases: `input|input_tokens|inputTokens|prompt_tokens|promptTokens`,
  `cacheRead|cache_read|cache_read_input_tokens|cacheReadInputTokens`,
  `cacheWrite|cache_write|cache_creation_input_tokens|cacheCreationInputTokens`,
  `output|output_tokens|outputTokens|completion_tokens|completionTokens`;
  cost from a number, `cost.total`, or `total_cost|totalCost|cost_total`.
- Totals accumulate per session. `session_start` also replays assistant and
  `model_usage` entries from `getBranchView()` / `getBranch()`.
- The line joins the non-empty parts: usage text, the session prefix
  (`name NN` from `^(\S+) ([A-Z0-9]{1,6}): .*$`, else the raw name), and
  `"user@short-host"` from `node:os`.
- Every write is event-driven: `session_start`, `message_start`, `message_end`,
  `message_update`, `before_agent_start`, `tool_execution_start`,
  `tool_execution_update`, `tool_execution_end`. No timer, no polling, no
  interval; identical text is not re-sent.
- Subagents (`agent.kind` `sub`/`subagent`, or `agent.depth > 0`) never write
  the main widget. The latest non-zero subagent snapshot becomes the active
  `Δ` on the main line.
- Absent `ctx.hasUI` or `ui.setWidget` is a silent no-op. No exception crosses
  a hook.

## Non-goals

No cljs, no sandbox, no S1–S5, no board, no worktrees, no UFSS, no native-tool
capture requirement. No changes to the host system prompt beyond the retained
repo-aware block. No regex extraction of data from chat text.
