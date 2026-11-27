// Maps an omp tool call and its result into the small set of view shapes the
// DeerFlow cards render. The mapper is intentionally pure: no ANSI reaches the
// browser, and no tool result is shown as raw JSON unless it is a generic tool.

import {
  MAX_OUTPUT,
  describeScopeCall,
  languageFor,
  stripAnsi,
  stripReplEcho,
} from "../../../shared/tool-view.mjs";

export { stripAnsi };

function resultText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (typeof result.content === "string") return result.content;
  if (!Array.isArray(result.content)) return "";
  return result.content
    .filter((block) => block && block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

export function computeLineDiff(oldText, newText) {
  const before = String(oldText ?? "").split("\n");
  const after = String(newText ?? "").split("\n");
  if (before.length === 1 && before[0] === "") before.length = 0;
  if (after.length === 1 && after[0] === "") after.length = 0;

  const rows = before.length;
  const cols = after.length;
  let lcs = 0;
  if (rows > 0 && cols > 0 && rows * cols <= 4_000_000) {
    let previous = new Array(cols + 1).fill(0);
    for (let i = 1; i <= rows; i += 1) {
      const current = new Array(cols + 1).fill(0);
      for (let j = 1; j <= cols; j += 1) {
        current[j] =
          before[i - 1] === after[j - 1]
            ? previous[j - 1] + 1
            : Math.max(previous[j], current[j - 1]);
      }
      previous = current;
    }
    lcs = previous[cols];
  }

  const added = cols - lcs;
  const removed = rows - lcs;
  const hunks = [];
  if (added > 0 || removed > 0) {
    hunks.push({ added, removed });
  }
  return { added, removed, hunks };
}

function artifactFor(path, content, language) {
  const text = typeof content === "string" ? content : "";
  const limit = 128 * 1024;
  return text.length <= limit
    ? { path, content: text, language }
    : { path, content: `${text.slice(0, limit)}\n… [truncated]`, language, truncated: true };
}

// Line numbers reach the mapper as JSON straight from the model, so a string
// like "x" is possible even though the tool itself rejects it. The card must
// never render a fabricated range such as "NaN-": an unusable number means the
// range is unknown, and an empty range renders as nothing.
function lineNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function readRange(args) {
  const offset = lineNumber(args.offset, 1);
  const limit = lineNumber(args.limit, 0);
  if (offset === null || limit === null) return "";
  // `limit` counts lines, so the range ends at offset + limit - 1.
  return limit > 0 ? `${offset}-${offset + limit - 1}` : `${offset}-`;
}

/**
 * One view per `await api.*` the script dispatched, in call order. Mapping each
 * entry back through `describeToolCall` is what keeps a `write` inside js
 * rendering as a write card — and what lets the artifact collector see it.
 * Depth-limited to one level: a js call cannot contain another js call.
 */
function innerCallViews(toolResult) {
  const details = toolResult?.details;
  const innerCalls = Array.isArray(details?.innerCalls) ? details.innerCalls : [];
  return innerCalls
    .filter((call) => call && typeof call.name === "string" && call.name !== "")
    .map((call) =>
      describeToolCall(
        { name: call.name, args: call.args ?? {} },
        {
          content: [
            { type: "text", text: typeof call.resultText === "string" ? call.resultText : "" },
          ],
          isError: call.isError === true,
        },
      ),
    );
}

export function describeToolCall(toolCall, toolResult) {
  const name = toolCall?.name ?? "unknown";
  const args = toolCall?.args ?? {};
  const output = stripAnsi(resultText(toolResult));
  const isError = Boolean(toolResult?.isError);

  if (name === "read") {
    const range = readRange(args);
    return {
      kind: "read",
      title: args.description ?? `Read ${args.path ?? ""}`,
      path: args.path,
      range,
      preview: output.slice(0, MAX_OUTPUT),
      language: languageFor(args.path),
      artifact: artifactFor(args.path, output, languageFor(args.path)),
      isError,
    };
  }

  if (name === "write" || name === "edit" || name === "apply_patch") {
    const before = name === "edit" ? args.old_string ?? "" : "";
    const after =
      name === "write" ? args.content ?? "" : name === "edit" ? args.new_string ?? "" : args.patch ?? "";
    const diff = computeLineDiff(before, after);
    return {
      kind: name === "write" ? "write" : "edit",
      title: args.description ?? `${name} ${args.path ?? ""}`,
      path: args.path,
      diff,
      artifact: artifactFor(args.path, after, languageFor(args.path)),
      isError,
    };
  }

  if (name === "bash") {
    const truncated = output.length > MAX_OUTPUT;
    return {
      kind: "bash",
      title: args.description ?? String(args.command ?? "bash"),
      command: args.command ?? "",
      language: "bash",
      output: truncated ? output.slice(0, MAX_OUTPUT) : output,
      truncated,
      isError,
    };
  }

  // The single `js` tool: the script is the code, the REPL text is the output,
  // and the real work is in `details.innerCalls` — one card per inner call.
  if (name === "js") {
    return {
      kind: "eval",
      title: args.title ?? "js",
      language: "javascript",
      code: typeof args.code === "string" ? args.code : "",
      output: stripReplEcho(output),
      children: innerCallViews(toolResult),
      isError,
    };
  }

  if (name === "eval") {
    return {
      kind: "eval",
      title: args.title ?? args.description ?? "eval",
      language: args.language ?? "javascript",
      output,
      isError,
    };
  }

  if (["grep", "glob", "find", "ast_grep"].includes(name)) {
    return {
      kind: "search",
      title: args.description ?? `${name} ${args.pattern ?? ""}`,
      pattern: args.pattern ?? args.query ?? "",
      path: args.path ?? "",
      summary: output,
      isError,
    };
  }

  if (name === "web_search" || name === "web_fetch") {
    const links = Array.from(output.matchAll(/https?:\/\/[^\s"'<>]+/g), (match) => match[0]);
    return {
      kind: "web",
      title: args.description ?? name,
      query: args.query ?? "",
      url: args.url ?? "",
      links,
      isError,
    };
  }

  // The scope control plane is the orchestration surface once every native tool
  // hides behind `js`; its exact titles and plan words live in the shared mapper
  // so this copy and the browser copy cannot disagree.
  const scopeView = describeScopeCall(name, args, output);
  if (scopeView) return { ...scopeView, isError };

  if (name === "todo") {
    const phases = Array.isArray(args.phases) ? args.phases : [];
    const summary = phases.length
      ? phases.map((phase) => `${phase.name} (${phase.tasks?.length ?? 0})`).join(", ")
      : output || "todo updated";
    return { kind: "todo", title: "Todo", summary, isError };
  }

  if (name === "task") {
    return {
      kind: "task",
      title: args.description ?? "Subtask",
      agent: args.subagent_type ?? args.agent ?? "task",
      description: args.description ?? "",
      prompt: args.prompt ?? "",
      status: isError ? "failed" : "completed",
      result: output,
      isError,
    };
  }

  if (name === "ask") {
    return {
      kind: "ask",
      title: "Ask",
      summary: output || "Awaiting your answer",
      isError,
    };
  }

  return {
    kind: "generic",
    title: args.description ?? `Use tool ${name}`,
    name,
    description: args.description ?? `Use tool ${name}`,
    argsText: JSON.stringify(args, null, 2),
    resultText: output,
    isError,
  };
}

/**
 * The artifact list, fed one batch at a time.
 *
 * The rule is about order, not about holding the input: one path is listed once,
 * and the first call that names it wins — a file written and then read later is
 * still the write. A caller that cannot hold a whole transcript at once feeds
 * this a chunk at a time and gets the same list, in the same order.
 */
export function createArtifactCollector() {
  const artifacts = [];
  const seen = new Set();
  // First call that names a path wins — including a call nested inside `js`:
  // a file written by a script must list exactly as a direct write would.
  const collect = (view) => {
    if (
      view?.path &&
      !seen.has(view.path) &&
      ["read", "write", "edit"].includes(view.kind)
    ) {
      seen.add(view.path);
      artifacts.push({
        path: view.path,
        kind: view.kind,
        language: view.language ?? "text",
        content: view.artifact?.content ?? view.preview ?? "",
        diff: view.diff ?? null,
      });
    }
    for (const child of view?.children ?? []) collect(child);
  };
  return {
    add(items) {
      for (const item of items ?? []) {
        if (!item?.toolCall) continue;
        collect(describeToolCall(item.toolCall, item.toolResult));
      }
    },
    list() {
      return artifacts;
    },
  };
}

export function extractArtifacts(items) {
  const collector = createArtifactCollector();
  collector.add(items);
  return collector.list();
}
