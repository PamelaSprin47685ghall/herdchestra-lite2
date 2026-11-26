/**
 * The wire contract of host-omp-ui, mirrored from
 * `host-omp-ui/src/station/domain/protocol-codec.mjs` and the skill's
 * mapping-artistry.md. Two shapes are accepted on purpose:
 *
 * - flattened: `{ type, ...fields }` — what the current station dispatches;
 * - enveloped: `{ type, payload: { ...fields } }` — the documented contract.
 *
 * The store normalizes both before reducing, so the renderer never has to
 * guess which transport revision it is talking to.
 */

import type { MessageLog } from "./message-log";

export type MessageRole =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "toolResult"
  | "custom"
  | "branchSummary"
  | "compactionSummary"
  | "bashExecution"
  | "pythonExecution"
  | "developer"
  | "fileMention";

export type TextBlock = { type: "text"; text: string };
export type ThinkingBlock = { type: "thinking"; text: string };
export type ToolCallBlock = {
  type: "toolCall";
  id: string;
  toolCallId?: string;
  name: string;
  args?: unknown;
  argsText?: string;
  result?: unknown;
  resultText?: string;
  /** `js` inner calls: `{ innerCalls: [{ name, args, resultText, isError }] }`. */
  details?: unknown;
  isError?: boolean;
  status?: ToolStatus;
};
/** Locally streamed tool block. Canonical snapshots use `toolCall` instead. */
export type ToolBlock = {
  type: "tool";
  toolCallId: string;
  name: string;
  status?: ToolStatus;
  args?: unknown;
  result?: unknown;
  details?: unknown;
};
export type ImageBlock = { type: "image"; url?: string; alt?: string };
export type MessageBlock =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | ToolBlock
  | ImageBlock;

export type UiMessage = {
  id: string;
  role: MessageRole;
  blocks?: MessageBlock[];
  text?: string;
  streaming?: boolean;
  attribution?: string | null;
  /** Station receipt: a host reminder, never a real user turn. */
  herdSkill?: boolean;
  timestamp?: number;
  /** toolResult identity */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** bash/python execution */
  command?: string;
  output?: string;
  exitCode?: number;
  code?: string;
  /** custom / fileMention / summaries */
  customType?: string;
  excludeFromContext?: boolean;
  path?: string;
  content?: string;
  summary?: string;
};

export type ToolStatus = "running" | "completed" | "failed" | "error";

export type TodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked"
  | "waiting"
  | "abandoned"
  | "skipped";

export type TodoItem = {
  content?: string;
  status?: TodoStatus | string;
  description?: string;
};

export type TodoPhase = {
  name?: string;
  tasks: TodoItem[];
};

export type SessionSummary = {
  id: string;
  title?: string | null;
  cwd?: string | null;
  path?: string | null;
  modified?: string | null;
  messageCount?: number;
};

export type ArtifactItem = {
  id: string;
  name?: string;
  path?: string;
  kind?: string;
  language?: string;
  content?: string;
  /** Previous text for an edit artifact, used by the big Diff view. */
  previous?: string;
  diff?: DiffStat | string | null;
  isError?: boolean;
};

export type DiffStat = {
  added?: number;
  removed?: number;
  hunks?: unknown[];
};

export type ModelRef = {
  provider: string;
  id: string;
  name?: string;
  [key: string]: unknown;
};

export type DraftState = {
  rev: number;
  text: string;
  cursor?: number | { line: number; col: number };
  origin?: "tui" | "web";
  images?: unknown[];
  texts?: unknown[];
  composer?: Record<string, unknown>;
};

export type CompletionItem = {
  value: string;
  label: string;
  description?: string;
  hint?: string;
  disabled?: boolean;
};

/**
 * The TUI editor's live slash-completion projection. The TUI owns the
 * matching and selection state machine; the web renders this mirror and
 * forwards navigation keys, never computing candidates itself.
 */
export type CompletionState = {
  open: boolean;
  prefix: string;
  items: CompletionItem[];
  selectedIndex: number;
  enterAccepts: boolean;
};

export type InteractionRequest = {
  id: string;
  kind: string;
  payload?: unknown;
};

export type InteractionError = {
  code?: string;
  message?: string;
  errors?: Record<string, string> | null;
};

export type OverlaySummary = {
  id: string;
  kind?: string;
  title?: string;
};

/** Normalized native node from a real TspNode (k/p/c) or a legacy kind/props node. */
export type SurfaceNode = {
  id: string;
  kind: string;
  text?: string;
  props?: Record<string, unknown>;
  children: SurfaceNode[];
};

export type SurfaceDocument = {
  root: SurfaceNode;
  focus: string | null;
  settled: string[];
  sf: string | null;
  seq: number;
};

/** Flat legacy view, kept for tests and quick lookups. */
export type TspNode = {
  id: string;
  kind: string;
  text?: string;
  props?: Record<string, unknown>;
  parentId?: string | null;
};

export type WidgetEntry = {
  key: string;
  lines: string[];
};

export type UsageState = {
  tokens?: number | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  contextWindow?: number;
  percent?: number;
  cost?: number | { total?: number };
  context?: { tokens?: number; token_count?: number; contextWindow?: number; max_context_tokens?: number; percent?: number } | null;
  total?: number;
  [key: string]: unknown;
};

export type SessionModeState = {
  plan?: { status?: string; planFilePath?: string };
  vibe?: { status?: string };
  goal?: { status?: string; objective?: string; tokenBudget?: number };
  loop?: { status?: string; [key: string]: unknown };
  [key: string]: unknown;
};

export type MetaState = {
  model?: ModelRef | null;
  thinkingLevel?: string | null;
  thinkingLevels?: string[];
  modes?: SessionModeState | Record<string, unknown> | null;
  busy?: boolean;
  title?: string | null;
  setStatus?: string | null;
  setWorkingMessage?: string | null;
  fence?: Record<string, unknown> | null;
  [key: string]: unknown;
};

export type Notification = {
  id: string;
  level?: string;
  message: string;
};

export type CommandEntry = {
  command: string;
  status: "pending" | "ok" | "error";
  sessionId?: string;
  code?: string;
  message?: string;
  value?: unknown;
};

export type LiveHistory = {
  hasMore: boolean;
  oldestId: string | null;
};

export type LiveSessionState = {
  /**
   * The message history as a persistent vector.
   *
   * A stream frame replaces one message. Holding the history as a plain array
   * made that replacement copy one reference per message on every tick, so the
   * price of a frame grew with the session. `MessageLog` shares structure
   * instead: a replacement copies one path through a 32-way trie, and the type
   * carries positional access so consumers keep reading `messages[i]`.
   */
  messages: MessageLog;
  session: SessionSummary | null;
  history?: LiveHistory;
};

export type WebState = {
  transcriptSeq: number;
  /**
   * Bumped whenever a streaming frame replaces the in-flight text.
   *
   * The message array is copied on such a frame, so its identity already
   * changes; this counter is the explicit signal consumers can depend on
   * instead of inferring "something moved" from array identity alone. It never
   * stands in for immutability: a frame must not write into the state it was
   * given, or the previous state would change under its readers.
   */
  streamRev: number;
  /**
   * The smallest index that differs between `messages` and the message list
   * the previous state held.
   *
   * A frame that only rewrites the tail of the conversation records the exact
   * index it touched, so a consumer that has grouped a prefix can ask whether
   * that prefix is still valid in constant time. It replaces comparing the two
   * lists element by element, which cost the length of the prefix on every
   * tick — the cost this field exists to remove.
   *
   * It is only meaningful together with `streamRev`, and only because
   * `liveCommit` advances `streamRev` on every transition that replaces the
   * message sequence — including the ones that do not report an index, such as
   * a snapshot or a prepended history page. That is what makes "exactly one
   * behind" mean "exactly one transition behind": without it, a replacement
   * could slip in without consuming a version and the next stream frame would
   * arrive at `cached + 1` while the list underneath had already been swapped.
   * Every transition that does not report an index sets this to 0, which claims
   * the whole list moved and is always safe to act on.
   */
  streamDirtyFrom: number;
  commands: Record<string, CommandEntry>;
  session: SessionSummary | null;
  liveSession: LiveSessionState;
  /**
   * The same sequence `liveSession.messages` holds, published on the state for
   * consumers that read it without unwrapping the session. It is the same value,
   * so a positional read and an identity comparison agree.
   */
  messages: MessageLog;
  streaming: boolean;
  todos: TodoItem[];
  todoPhases: TodoPhase[];
  queue: { steering: string[]; followUp: string[] };
  models: ModelRef[];
  model: ModelRef | null;
  thinkingLevel: string | null;
  thinkingLevels: string[];
  modes: SessionModeState | Record<string, unknown>;
  meta: MetaState;
  usage: UsageState | null;
  draft: DraftState;
  completion: CompletionState;
  openInteractions: InteractionRequest[];
  resolvedInteractions: Record<string, string>;
  interactionErrors: Record<string, InteractionError>;
  surfaceDoc: Record<string, TspNode>;
  surface: SurfaceDocument;
  overlays: OverlaySummary[];
  hasLiveOverlay: boolean;
  notifications: Notification[];
  fenceStatus: string | null;
  sessions: SessionSummary[];
  artifacts: ArtifactItem[];
  toolExecutions: Record<string, ToolExecution>;
  widgets: Record<string, string[] | null>;
};

export type ToolExecution = {
  id: string;
  name: string;
  status: ToolStatus;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  argsText?: string;
  partialResult?: unknown;
  result?: unknown;
  /** `js` inner calls, copied from the paired block on a rebuilt history. */
  details?: unknown;
  isError?: boolean;
  messageId?: string;
};

export type ServerFrame = {
  type: string;
  kind?: string;
  seq?: number;
  ts?: number;
  payload?: unknown;
  [key: string]: unknown;
};

export type DisplayGroup = {
  kind: "user" | "processing" | "assistant" | "terminal" | "boundary" | "other";
  id: string;
  messages: UiMessage[];
};
