// Maps an omp tool call and its result into the small set of view shapes the
// DeerFlow cards render. The mapper is intentionally pure: no ANSI reaches the
// browser, and no tool result is shown as raw JSON unless it is a generic tool.

const MAX_OUTPUT = 12_000;

export function stripAnsi(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "");
}

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

function languageFor(path) {
  const extension = String(path ?? "").split(".").pop()?.toLowerCase();
  const map = {
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    ts: "typescript",
    tsx: "tsx",
    jsx: "jsx",
    py: "python",
    rs: "rust",
    go: "go",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    sh: "bash",
    yml: "yaml",
    yaml: "yaml",
  };
  return map[extension] ?? "text";
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

export function describeToolCall(toolCall, toolResult) {
  const name = toolCall?.name ?? "unknown";
  const args = toolCall?.args ?? {};
  const output = stripAnsi(resultText(toolResult));
  const isError = Boolean(toolResult?.isError);

  if (name === "read") {
    const offset = Number(args.offset ?? 1);
    const limit = Number(args.limit ?? 0);
    const range = limit > 0 ? `${offset}-${limit}` : `${offset}-`;
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

export function extractArtifacts(items) {
  const artifacts = [];
  const seen = new Set();
  for (const item of items ?? []) {
    if (!item?.toolCall) continue;
    const view = describeToolCall(item.toolCall, item.toolResult);
    if (!view.path || seen.has(view.path)) continue;
    if (!["read", "write", "edit"].includes(view.kind)) continue;
    seen.add(view.path);
    artifacts.push({
      path: view.path,
      kind: view.kind,
      language: view.language ?? "text",
      content: view.artifact?.content ?? view.preview ?? "",
      diff: view.diff ?? null,
    });
  }
  return artifacts;
}
