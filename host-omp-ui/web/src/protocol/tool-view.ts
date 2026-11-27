/**
 * Pure tool-card mapping for the browser. Mirrors the intent of
 * `host-omp-ui/src/station/domain/tool-artistry.mjs` without importing it:
 * the web bundle must stay independent of the extension process.
 */

import type { MessageBlock, ToolExecution, ToolStatus } from "./types";
import { asRecord } from "./guards";

const MAX_OUTPUT = 12_000;

export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "");
}

export type AnsiSegment = { text: string; color?: string; backgroundColor?: string; bold?: boolean; underline?: boolean };

// Parse SGR only. React renders text as text, never as HTML; other terminal
// controls (including OSC links) are discarded rather than executed.
export function ansiSegments(text: string): AnsiSegment[] {
  const palette = ["#333333", "#cc5555", "#55aa55", "#c5a64a", "#628bd1", "#ad6ac2", "#4caaaa", "#cccccc", "#777777", "#ff7777", "#77dd77", "#ffdd77", "#88aaff", "#dd88ee", "#77dddd", "#ffffff"];
  const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
  const color = (n: number) => n < 8 ? `var(--ansi-${names[n]}, ${palette[n]})` : palette[n];
  const indexedColor = (n: number): string | undefined => {
    if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
    if (n < 16) return color(n);
    if (n >= 232) {
      const gray = 8 + (n - 232) * 10;
      return `rgb(${gray}, ${gray}, ${gray})`;
    }
    const value = n - 16;
    const level = (component: number) => component === 0 ? 0 : 55 + 40 * component;
    return `rgb(${level(Math.floor(value / 36))}, ${level(Math.floor(value / 6) % 6)}, ${level(value % 6)})`;
  };
  let style: Omit<AnsiSegment, "text"> = {};
  const lines: AnsiSegment[][] = [[]];
  let row = 0;
  let col = 0;
  const maxColumn = 16384;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const write = (value: string) => {
    for (const { segment: char } of segmenter.segment(value)) {
      if (char === "\n") { row++; col = 0; lines[row] ??= []; continue; }
      if (char === "\r") { col = 0; continue; }
      if (char === "\b") { col = Math.max(0, col - 1); continue; }
      if (char < " " && char !== "\t") continue;
      if (col >= maxColumn) continue;
      const line = lines[row];
      while (line.length < col) line.push({ text: " " });
      const code = char.codePointAt(0) ?? 0;
      const wide = /\p{Extended_Pictographic}/u.test(char) || (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe6f) || (code >= 0xff01 && code <= 0xff60) || (code >= 0x20000 && code <= 0x3fffd)));
      if (line[col]?.text === "" && col > 0) line[col - 1] = { text: " " };
      if (line[col + 1]?.text === "") line[col + 1] = { text: " " };
      line[col++] = { text: char, ...style };
      if (wide && col < maxColumn) line[col++] = { text: "", ...style };
    }
  };
  const clean = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  const re = /\x1b\[([0-9;]*)m|\x1b\[([0-9;]*)([ABCDGKHf])|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]/g;
  let pos = 0;
  for (const match of clean.matchAll(re)) {
    const index = match.index;
    if (index > pos) write(clean.slice(pos, index));
    pos = index + match[0].length;
    if (match[2] !== undefined) {
      const amount = Math.min(maxColumn, Number(match[2].split(";")[0]) || 1);
      if (match[3] === "A") row = Math.max(0, row - amount);
      else if (match[3] === "B") { row = Math.min(4095, row + amount); while (lines.length <= row) lines.push([]); }
      else if (match[3] === "H" || match[3] === "f") {
        const [r, c] = match[2].split(";").map(Number);
        row = Math.min(4095, Math.max(0, (r || 1) - 1));
        col = Math.min(maxColumn, Math.max(0, (c || 1) - 1));
        while (lines.length <= row) lines.push([]);
      }
      else if (match[3] === "C") col = Math.min(maxColumn, col + amount);
      else if (match[3] === "D") col = Math.max(0, col - amount);
      else if (match[3] === "G") col = Math.min(maxColumn, amount - 1);
      else if (match[3] === "K") {
        const mode = Number(match[2]) || 0;
        if (mode === 2) lines[row] = [];
        else if (mode === 1) for (let i = 0; i <= col && i < lines[row].length; i++) lines[row][i] = { text: " " };
        else {
          if (lines[row][col]?.text === "" && col > 0) lines[row][col - 1] = { text: " " };
          lines[row].length = Math.min(col, lines[row].length);
        }
      }
      continue;
    }
    if (match[1] === undefined) continue;
    const codes = (match[1] || "0").split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) style = {};
      else if (c === 1) style.bold = true;
      else if (c === 22) delete style.bold;
      else if (c === 4) style.underline = true;
      else if (c === 24) delete style.underline;
      else if (c === 39) delete style.color;
      else if (c === 49) delete style.backgroundColor;
      else if (c >= 30 && c <= 37) style.color = color(c - 30);
      else if (c >= 90 && c <= 97) style.color = color(c - 90 + 8);
      else if (c >= 40 && c <= 47) style.backgroundColor = color(c - 40);
      else if (c >= 100 && c <= 107) style.backgroundColor = color(c - 100 + 8);
      else if ((c === 38 || c === 48) && codes[i + 1] === 5 && codes.length > i + 2) {
        const selected = indexedColor(codes[i + 2]);
        if (selected) style[c === 38 ? "color" : "backgroundColor"] = selected;
        i += 2;
      }
      else if ((c === 38 || c === 48) && codes[i + 1] === 2 && codes.length > i + 4) {
        const rgb = codes.slice(i + 2, i + 5).map((v) => Math.max(0, Math.min(255, v)));
        style[c === 38 ? "color" : "backgroundColor"] = `rgb(${rgb.join(", ")})`;
        i += 4;
      }
    }
  }
  if (pos < clean.length) write(clean.slice(pos));
  const result: AnsiSegment[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i) result.push({ text: "\n" });
    for (const cell of lines[i]) {
      const last = result[result.length - 1];
      if (last && last.color === cell.color && last.backgroundColor === cell.backgroundColor && last.bold === cell.bold && last.underline === cell.underline) last.text += cell.text;
      else result.push({ ...cell });
    }
  }
  return result;
}

export function resultText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return stripAnsi(value);
  if (Array.isArray(value)) {
    return value.map((item) => resultText(item)).filter(Boolean).join("\n");
  }
  const entry = asRecord(value);
  if (!entry) return stripAnsi(String(value));
  if (entry.content !== undefined) return resultText(entry.content);
  if (typeof entry.text === "string") return stripAnsi(entry.text);
  if (typeof entry.output === "string") return stripAnsi(entry.output);
  if (typeof entry.stdout === "string" || typeof entry.stderr === "string") {
    return [entry.stdout, entry.stderr]
      .filter((item): item is string => typeof item === "string" && item.length > 0)
      .map(stripAnsi)
      .join("\n");
  }
  if (entry.details !== undefined) {
    const details = asRecord(entry.details);
    if (details?.output && typeof details.output === "string") {
      return stripAnsi(details.output);
    }
  }
  try {
    return JSON.stringify(entry, null, 2);
  } catch {
    return "";
  }
}

export function argsOf(tool: { args?: unknown; argsText?: string }): Record<string, unknown> {
  const direct = asRecord(tool.args);
  if (direct) return direct;
  if (typeof tool.args === "string") {
    try {
      return asRecord(JSON.parse(tool.args)) ?? {};
    } catch {
      return {};
    }
  }
  if (tool.argsText) {
    try {
      return asRecord(JSON.parse(tool.argsText)) ?? {};
    } catch {
      // A tool call still streaming has half-written JSON arguments.
    }
  }
  return {};
}

export function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

export function languageFor(path: string | undefined): string {
  const extension = String(path ?? "").split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
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
    scss: "scss",
    html: "html",
    htm: "html",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    sql: "sql",
    diff: "diff",
    xml: "xml",
    java: "java",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    rb: "ruby",
    php: "php",
    swift: "swift",
    kt: "kotlin",
    lua: "lua",
  };
  return map[extension ?? ""] ?? "text";
}

export type DiffLine = {
  kind: "same" | "add" | "remove";
  text: string;
};

export type LineDiff = {
  lines: DiffLine[];
  added: number;
  removed: number;
  truncated: boolean;
};

/**
 * Line diff with an LCS table capped at 4M cells. A very large edit falls back
 * to "whole old block removed, whole new block added" instead of hanging the
 * browser; the artifact drawer still has the complete new content.
 */
export function lineDiff(oldText: string, newText: string): LineDiff {
  const before = oldText.length ? oldText.split("\n") : [];
  const after = newText.length ? newText.split("\n") : [];
  if (before.length * after.length > 4_000_000) {
    return {
      lines: [
        ...before.map((text) => ({ kind: "remove" as const, text })),
        ...after.map((text) => ({ kind: "add" as const, text })),
      ],
      added: after.length,
      removed: before.length,
      truncated: true,
    };
  }
  const rows = before.length;
  const cols = after.length;
  const table: Uint32Array[] = Array.from(
    { length: rows + 1 },
    () => new Uint32Array(cols + 1),
  );
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] =
        before[i] === after[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (before[i] === after[j]) {
      lines.push({ kind: "same", text: before[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ kind: "remove", text: before[i] });
      removed += 1;
      i += 1;
    } else {
      lines.push({ kind: "add", text: after[j] });
      added += 1;
      j += 1;
    }
  }
  while (i < rows) {
    lines.push({ kind: "remove", text: before[i] });
    removed += 1;
    i += 1;
  }
  while (j < cols) {
    lines.push({ kind: "add", text: after[j] });
    added += 1;
    j += 1;
  }
  return { lines, added, removed, truncated: false };
}

export type ToolViewBase = {
  id: string;
  name: string;
  status: ToolStatus;
  isError: boolean;
  title: string;
  path?: string;
  description?: string;
};

export type ReadView = ToolViewBase & {
  kind: "read";
  language: string;
  preview: string;
};
export type WriteView = ToolViewBase & {
  kind: "write";
  language: string;
  content: string;
};
export type EditView = ToolViewBase & {
  kind: "edit";
  language: string;
  oldText: string;
  newText: string;
  diff: LineDiff;
};
export type BashView = ToolViewBase & {
  kind: "bash";
  command: string;
  output: string;
  exitCode?: number;
  truncated: boolean;
};
export type EvalView = ToolViewBase & {
  kind: "eval";
  language: string;
  code: string;
  output: string;
  /**
   * The inner tool calls a `js` script dispatched, already described. One
   * level only: a js call cannot nest another js call.
   */
  children?: ToolView[];
};
export type SearchView = ToolViewBase & {
  kind: "search";
  pattern: string;
  path: string;
  matches: string[];
};
export type WebView = ToolViewBase & {
  kind: "web";
  query: string;
  links: string[];
};
export type TodoView = ToolViewBase & { kind: "todo"; summary: string };
export type TaskView = ToolViewBase & {
  kind: "task";
  agent: string;
  prompt: string;
  result: string;
};
export type AskView = ToolViewBase & { kind: "ask"; summary: string };
export type GenericView = ToolViewBase & {
  kind: "generic";
  argsText: string;
  resultText: string;
};

export type ToolView =
  | ReadView
  | WriteView
  | EditView
  | BashView
  | EvalView
  | SearchView
  | WebView
  | TodoView
  | TaskView
  | AskView
  | GenericView;

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT) return { text, truncated: false };
  return {
    text: `${text.slice(0, MAX_OUTPUT)}\n… (输出已截断)`,
    truncated: true,
  };
}

function safeLinks(text: string, extra?: string): string[] {
  const links = Array.from(text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g), (match) => match[0]);
  if (extra && /^https?:\/\//.test(extra)) links.unshift(extra);
  return Array.from(new Set(links)).slice(0, 20);
}

function searchMatches(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 30);
}

function titleOf(name: string, args: Record<string, unknown>, fallback: string): string {
  const description = typeof args.description === "string" ? args.description : "";
  const path = typeof args.path === "string" ? args.path : "";
  const command = typeof args.command === "string" ? args.command.split("\n")[0] : "";
  return description || path || command || fallback || name;
}

// The js result's first line is a fixed echo of the invocation; the code itself
// already travelled in the call's arguments, so the card shows the output only.
const REPL_ECHO_PREFIX = "> await AsyncFunction(";

function stripReplEcho(text: string): string {
  if (!text.startsWith(REPL_ECHO_PREFIX)) return text;
  const at = text.indexOf("\n");
  return at === -1 ? "" : text.slice(at + 1);
}

/**
 * The inner tool calls a `js` script dispatched, read from
 * `result.details.innerCalls`. Each entry is described by this same function so
 * a `write` inside js renders as a write card, not a JSON blob. One level only:
 * a js call cannot nest another.
 */
function innerCallViews(
  result: unknown,
  detailsField: unknown,
  depth: number,
): ToolView[] | undefined {
  if (depth > 0) return undefined;
  // Live frames carry the details on the result; a rebuilt history carries them
  // on the block, which `mergeToolBlock` copies onto the execution.
  const details =
    asRecord(asRecord(result)?.details) ?? asRecord(detailsField);
  const calls = Array.isArray(details?.innerCalls) ? details.innerCalls : [];
  const views: ToolView[] = [];
  for (const raw of calls) {
    const call = asRecord(raw);
    const name = typeof call?.name === "string" ? call.name : "";
    if (!name) continue;
    views.push(
      describeTool(
        {
          id: `${name}:${views.length}`,
          name,
          status: call?.isError === true ? ("failed" as const) : ("completed" as const),
          args: call?.args,
          result: {
            content: [
              {
                type: "text",
                text: typeof call?.resultText === "string" ? call.resultText : "",
              },
            ],
          },
          isError: call?.isError === true,
        },
        depth + 1,
      ),
    );
  }
  return views.length > 0 ? views : undefined;
}

export function describeTool(tool: ToolExecution, depth = 0): ToolView {
  const name = tool.name || "tool";
  const args = argsOf(tool);
  const output = truncate(resultText(tool.result ?? tool.partialResult));
  const path = typeof args.path === "string" ? args.path : undefined;
  const isError = Boolean(tool.isError) || tool.status === "error";
  const status = isError ? "failed" : tool.status;
  const base: ToolViewBase = {
    id: tool.id,
    name,
    status,
    isError,
    title: titleOf(name, args, name),
    path,
    description: typeof args.description === "string" ? args.description : undefined,
  };

  if (name === "read") {
    return {
      ...base,
      kind: "read",
      title: titleOf(name, args, "read"),
      language: languageFor(path),
      preview: output.text,
    };
  }

  if (name === "write" || name === "apply_patch") {
    const content =
      name === "write"
        ? String(args.content ?? "")
        : String(args.patch ?? "");
    return {
      ...base,
      kind: "write",
      title: titleOf(name, args, name),
      language: languageFor(path),
      content: content || output.text,
    };
  }

  if (name === "edit") {
    const oldText = String(args.old_string ?? args.oldText ?? "");
    const newText = String(args.new_string ?? args.newText ?? "");
    return {
      ...base,
      kind: "edit",
      title: titleOf(name, args, "edit"),
      language: languageFor(path),
      oldText,
      newText,
      diff: lineDiff(oldText, newText),
    };
  }

  if (name === "bash" || name === "shell") {
    const exitCode = pickExitCode(tool.result);
    return {
      ...base,
      kind: "bash",
      title: titleOf(name, args, "bash"),
      command: String(args.command ?? ""),
      output: output.text,
      exitCode,
      truncated: output.truncated,
    };
  }

  // The single `js` tool: the script is the code, the REPL text is the output,
  // and the real work is in `details.innerCalls` — one card per inner call.
  if (name === "js") {
    return {
      ...base,
      kind: "eval",
      title: titleOf(name, args, "js"),
      language: "javascript",
      code: String(args.code ?? ""),
      output: stripReplEcho(output.text),
      children: innerCallViews(tool.result, tool.details, depth),
    };
  }

  if (name === "eval") {
    return {
      ...base,
      kind: "eval",
      title: titleOf(name, args, "eval"),
      language: String(args.language ?? "javascript"),
      code: String(args.code ?? args.source ?? ""),
      output: output.text,
    };
  }

  if (["grep", "glob", "find", "ast_grep", "search"].includes(name)) {
    return {
      ...base,
      kind: "search",
      title: titleOf(name, args, name),
      pattern: String(args.pattern ?? args.query ?? ""),
      path: String(args.path ?? ""),
      matches: searchMatches(output.text),
    };
  }

  if (name === "web_search" || name === "web_fetch") {
    return {
      ...base,
      kind: "web",
      title: titleOf(name, args, name),
      query: String(args.query ?? ""),
      links: safeLinks(output.text, typeof args.url === "string" ? args.url : undefined),
    };
  }

  // Mirrors the Node mapper: the scope control plane is the orchestration
  // surface once every native tool hides behind `js`, so its calls get a card
  // instead of a JSON blob.
  if (name === "scope_request") {
    const target = String(args.target ?? "");
    const message = String(args.message ?? "");
    const interrupt = args.interrupt === true ? " · interrupt" : "";
    return {
      ...base,
      kind: "ask",
      title: `scope_request → ${target || "?"}`,
      summary: [`→ ${target}${interrupt}: ${message}`, output.text && `← ${output.text}`]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (name === "scope_reply") {
    const reply = String(args.text ?? args.reply ?? args.message ?? output.text);
    return {
      ...base,
      kind: "ask",
      title: "scope_reply",
      summary: `← ${reply}`,
    };
  }

  if (name === "scope_fork") {
    const forks = Array.isArray(args.forks) ? args.forks : [];
    const requested = forks.map((fork) => {
      const spec: Record<string, unknown> = asRecord(fork) ?? {};
      const id = String(spec.scopeId ?? spec.name ?? "?");
      const fsm = String(spec.fsm ?? "").slice(0, 80);
      return fsm ? `${id} — ${fsm}` : id;
    });
    return {
      ...base,
      kind: "task",
      title: titleOf(name, args, `scope_fork (${forks.length})`),
      agent: "scope_fork",
      prompt: requested.join("\n"),
      result: output.text,
    };
  }

  if (name === "scope_join" || name === "scope_return") {
    const scope = String(args.scope ?? "");
    const oath = args.signed_sealed_hands_off_nothing_left_on_the_table;
    const plan =
      name === "scope_return"
        ? oath === "a_ferocious_audacious_master_would_change_nothing"
          ? "seal"
          : oath === "unfinished"
            ? "continue"
            : "rewind"
        : "";
    return {
      ...base,
      kind: "task",
      title: scope ? `${name} ${scope}` : name,
      agent: name,
      prompt: plan,
      result: output.text,
    };
  }

  if (name === "todo") {
    const phases = Array.isArray(args.phases) ? args.phases : [];
    const summary = phases.length
      ? phases
          .map((phase) => {
            const entry = asRecord(phase);
            const tasks = Array.isArray(entry?.tasks) ? entry.tasks.length : 0;
            return `${String(entry?.name ?? "todo")} (${tasks})`;
          })
          .join(" · ")
      : output.text || "todo updated";
    return { ...base, kind: "todo", title: "Todo", summary };
  }

  if (name === "task") {
    return {
      ...base,
      kind: "task",
      title: titleOf(name, args, "Subtask"),
      agent: String(args.subagent_type ?? args.agent ?? "task"),
      prompt: String(args.prompt ?? args.description ?? ""),
      result: output.text,
    };
  }

  if (name === "ask") {
    return {
      ...base,
      kind: "ask",
      title: "ask",
      summary: output.text || "等待你的回答",
    };
  }

  return {
    ...base,
    kind: "generic",
    title: titleOf(name, args, `Use tool ${name}`),
    argsText: Object.keys(args).length ? JSON.stringify(args, null, 2) : String(tool.argsText ?? ""),
    resultText: output.text,
  };
}

function pickExitCode(result: unknown): number | undefined {
  const entry = asRecord(result);
  if (!entry) return undefined;
  const direct = entry.exitCode ?? entry.exit_code;
  if (typeof direct === "number") return direct;
  const details = asRecord(entry.details);
  const nested = details?.exitCode ?? details?.exit_code;
  return typeof nested === "number" ? nested : undefined;
}

export function mergeToolBlock(
  block: MessageBlock,
  execution: Partial<ToolExecution> | undefined,
): ToolExecution {
  const fromBlock: ToolExecution =
    block.type === "toolCall"
      ? {
          id: block.id,
          name: block.name,
          status: block.isError ? "failed" : (block.status ?? "completed"),
          args: block.args,
          argsText: block.argsText,
          result: block.result,
          details: block.details,
          isError: block.isError,
          toolCallId: block.id,
          toolName: block.name,
        }
      : block.type === "tool"
        ? {
            id: block.toolCallId,
            name: block.name,
            status: block.status ?? "running",
            args: block.args,
            result: block.result,
            details: block.details,
            toolCallId: block.toolCallId,
            toolName: block.name,
          }
        : { id: "", name: "tool", status: "completed" };
  if (!execution) return fromBlock;
  return {
    ...fromBlock,
    ...execution,
    id: execution.id || fromBlock.id,
    name: execution.name || fromBlock.name,
    args: execution.args ?? fromBlock.args,
    result: execution.result ?? fromBlock.result,
    // A live execution may arrive without details while the rebuilt block has
    // them (or the reverse); either side may supply them.
    details: execution.details ?? fromBlock.details,
    isError: Boolean(execution.isError ?? fromBlock.isError),
    status: execution.isError
      ? "failed"
      : execution.status === "running" && fromBlock.status !== "running"
        ? fromBlock.status
        : (execution.status ?? fromBlock.status),
  };
}

export function toolBlockId(block: MessageBlock): string | undefined {
  if (block.type === "toolCall") return block.id;
  if (block.type === "tool") return block.toolCallId;
  return undefined;
}

export function isToolBlock(block: MessageBlock): boolean {
  return block.type === "toolCall" || block.type === "tool";
}
