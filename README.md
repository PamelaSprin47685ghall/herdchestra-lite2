# Herdchestra Lite 2.0

A minimal omp extension that puts every tool call inside a budgeted scope.

No ClojureScript. No sandbox. No stage machine. No board. Three tools and four
host hooks, in plain ESM.

## What it does

- `scope({ begin: { intent, budget } })` opens a scope. `intent` describes one
  task of moderate scope: if the whole user request needs about n tool calls,
  a moderate scope covers about sqrt(n) of them. `budget` maps exact tool names
  to their call limits; its total across tools is roughly sqrt(n). Several
  calls to the same tool in one assistant message are one simultaneous batch
  and consume one unit of that tool's budget. Budget and spend by batches, not
  individual calls.
- Every tool call outside `scope`, `regret`, and `defer` must happen inside a
  scope. It consumes one unit from the innermost scope's budget for that tool;
  same-tool calls in one assistant message share that unit. A tool not listed
  in the budget has zero calls.
- `scope({ end: { return_markdown } })` closes the innermost scope.
  `return_markdown` is the report you leave for your future self: it replaces
  the scope's begin receipt when the scope is collapsed and records what was
  accomplished, the evidence, what remains, and the lesson. It is not the
  user-facing answer; write that answer as ordinary assistant text, and only
  when you are outside all scopes. When a scope closes, its immediately elder
  sibling at the same level is collapsed: that sibling's begin receipt becomes
  its `return_markdown` and its internal turns disappear. The scope that just
  closed stays visible until a younger sibling closes. A parent close does not
  collapse its children; an enclosing scope's later collapse removes their
  receipts, so summarize durable child results in the enclosing report.
- `scope({ end: { return_markdown }, begin: { intent, budget } })` closes the
  current scope and then opens the next one in the same call.
- `regret({ reflection })` undoes the most recent completed beat inside the
  current scope. Its assistant message and tool results disappear from the next
  request, and its budget is refunded. A reflection records the lesson.
- `defer({ intent })` records a finding to handle later without spending
  budget. When the scope ends, all deferred findings are delivered as one
  steering user message.

- If the assistant stops inside a scope without a tool call, the runtime sends
  a steering nudge: do not give the user-facing conclusion yet; continue the
  task or close the scope. Only outside all scopes may the final answer be
  written as ordinary assistant text.

Scopes nest. Only the innermost scope's budget is used. Finishing the whole task
is not a tool call: close every scope first, then write the user-facing final
report as a normal assistant message and end the turn. `return_markdown` is a
self-delivery report, not the user-facing answer.

Outside every scope, every request ends with:

```text
<additional-system-instructions><skill version="1.0">You are not in a scope. Before using any tool, start a scope; otherwise finish the task. You are outside all scopes: write the final user-facing answer as ordinary assistant text. return_markdown is your self-delivery report, not the user-facing answer. Finishing is not a tool call, and there is no finish tool.</skill></additional-system-instructions>

<system-reminder><skill version="1.0">…language discipline…</skill></system-reminder>
```

Inside a scope, the same wrapper shows the current level, intent, and remaining
budget, and forbids the final user-facing conclusion. A natural stop inside a
scope triggers the nudge.

## Retained from Lite

- The large English repo-aware prompt is injected once as a managed system
  prompt block. It contains the eleven repo-aware paragraphs but not the old
  sandbox/UFSS notes, which do not apply here. Scope rules are not added to it;
  they live in the tool descriptions.
- The vibe-mode outbound rewrite is preserved for
  `role: "custom", customType: "vibe-mode-context"`.
- The registered `scope`, `regret`, and `defer` tools remain available in
  vibe mode, without changing its restrictions on other tools.

## Install

The package declares the extension entry in `package.json`:

```json
{
  "omp": { "extensions": ["./src/main.mjs"] },
  "pi": { "extensions": ["./src/main.mjs"] }
}
```

Run omp with the directory as the working tree, or load the entry explicitly.
Disable extension discovery in the explicit case so the same entry is not
loaded twice:

```sh
omp --no-extensions -e ./src/main.mjs
```

## Files

| File | Responsibility |
|---|---|
| `src/main.mjs` | Extension entry: capture, hooks, tool registration. |
| `src/runtime.mjs` | Per-session scope state, budget gate, control processing, fork, outbound transform. |
| `src/engine.mjs` | Pure scope accounting: begin, charge, defer, regret refund, close, serialize. |
| `src/transcript.mjs` | Pure beat/regret/collapse/vibe helpers over omp message shapes. |
| `src/descriptions.mjs` | Tool descriptions and JSON schemas. |
| `src/prompts.mjs` | Retained repo-aware prompt, language skill, vibe rewrite, prompt injection. |
| `src/runner-capture.mjs` | Optional capture of the live AgentSession for agent-state rebase. |
| `DESIGN.md` | The implementation contract. |

## Test

```sh
bun test tests
```

The suite is pure and uses a fake host session manager. It covers budget
enforcement, nested scopes, regret refunds and outbound filtering, defer steer,
scope-end fork/collapse, vibe rewrite, and prompt injection. For a live check:

```sh
omp -p --no-session --no-extensions --no-rules --no-context-files \
  --auto-approve -e ./src/main.mjs \
  "Call scope begin with a one-read budget, read package.json, then call scope end with return_markdown 'read package.json'. Then reply DONE."
```
