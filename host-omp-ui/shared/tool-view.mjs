/**
 * Tool-card primitives shared by the extension mapper
 * (`src/station/domain/tool-artistry.mjs`) and the browser mapper
 * (`web/src/protocol/tool-view.ts`).
 *
 * Each mapper used to keep its own copy, and the copies drifted: the transcript
 * renderer lost OSC stripping while the card mappers kept it. A copy cannot
 * drift from itself, so the shared facts live here once and each side
 * re-exports them under the name its callers already import.
 *
 * Pure ESM: no Node built-ins, no DOM. `package.json` ships `shared/`, so the
 * extension imports it at run time and the web bundle inlines it.
 */

export const MAX_OUTPUT = 12_000;

/** First line of a `js` result: a fixed echo of the invocation. */
export const JS_ECHO_PREFIX = "> await AsyncFunction(";

/** Drop ANSI/VT controls, OSC payloads (titles, hyperlinks) included. */
export function stripAnsi(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "");
}

/** The code already travelled in the call's arguments, so the card hides the echo. */
export function stripReplEcho(text) {
  if (!text.startsWith(JS_ECHO_PREFIX)) return text;
  const at = text.indexOf("\n");
  return at === -1 ? "" : text.slice(at + 1);
}

// The extension map and the browser map differed by eighteen extensions. One
// table holds both: `extended` picks the browser's wider set, so neither side
// loses a language it used to name.
const BASE_LANGUAGES = {
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

const EXTENDED_LANGUAGES = {
  ...BASE_LANGUAGES,
  scss: "scss",
  htm: "html",
  bash: "bash",
  zsh: "bash",
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

/** Extension to syntax-highlighting language, defaulting to plain text. */
export function languageFor(path, extended = false) {
  const extension = String(path ?? "").split(".").pop()?.toLowerCase();
  const table = extended ? EXTENDED_LANGUAGES : BASE_LANGUAGES;
  return table[extension ?? ""] ?? "text";
}

/**
 * One view for the scope control plane, or null for every other tool.
 *
 * Both mappers described these five calls with the same titles, summaries and
 * plan words; the parity test pinned them one by one. Keeping the strings here
 * makes the two views agree by construction, not by two copies agreeing.
 */
export function describeScopeCall(name, args, output) {
  const spec = args ?? {};

  if (name === "scope_request") {
    const target = String(spec.target ?? "");
    const message = String(spec.message ?? "");
    const interrupt = spec.interrupt === true ? " · interrupt" : "";
    return {
      kind: "ask",
      title: `scope_request → ${target || "?"}`,
      summary: [`→ ${target}${interrupt}: ${message}`, output && `← ${output}`]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (name === "scope_reply") {
    const reply = String(spec.text ?? spec.reply ?? spec.message ?? output);
    return { kind: "ask", title: "scope_reply", summary: `← ${reply}` };
  }

  if (name === "scope_fork") {
    const forks = Array.isArray(spec.forks) ? spec.forks : [];
    const requested = forks.map((fork) => {
      const entry = fork ?? {};
      const id = String(entry.path ?? entry.scopeId ?? entry.name ?? "?");
      const fsm = String(entry.fsm ?? "").slice(0, 80);
      return fsm ? `${id} — ${fsm}` : id;
    });
    const described = typeof spec.description === "string" && spec.description !== "" ? spec.description : "";
    return {
      kind: "task",
      title: described || `scope_fork (${forks.length})`,
      agent: "scope_fork",
      prompt: requested.join("\n"),
      result: output,
    };
  }

  if (name === "scope_abandon") {
    const target = String(spec.target ?? "");
    const reason = typeof spec.reason === "string" && spec.reason !== "" ? ` (${spec.reason})` : "";
    return {
      kind: "task",
      title: `scope_abandon ${target || "?"}`,
      agent: "scope_abandon",
      prompt: `${target || "?"}${reason}`,
      result: output,
    };
  }

  if (name === "scope_join" || name === "scope_return") {
    const scope = String(spec.scope ?? "");
    const oath = spec.signed_sealed_hands_off_nothing_left_on_the_table;
    const plan =
      name === "scope_return"
        ? oath === "a_ferocious_audacious_master_would_change_nothing"
          ? "seal"
          : oath === "unfinished"
            ? "continue"
            : "rewind"
        : "";
    return {
      kind: "task",
      title: scope ? `${name} ${scope}` : name,
      agent: name,
      prompt: plan,
      result: output,
    };
  }

  return null;
}
