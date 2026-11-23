import type {
  ArtifactItem,
  DiffStat,
  DisplayGroup,
  DraftState,
  InteractionError,
  InteractionRequest,
  MessageBlock,
  MessageRole,
  MetaState,
  ModelRef,
  Notification,
  OverlaySummary,
  ServerFrame,
  SessionModeState,
  SessionSummary,
  SurfaceDocument,
  TodoItem,
  TodoPhase,
  ToolExecution,
  ToolStatus,
  UiMessage,
  UsageState,
  WebState,
  WidgetEntry,
} from "./types";
import {
  applySurfaceOps,
  createSurfaceDocument,
  flattenSurface,
  normalizeOverlays,
  normalizeSurfaceDocument,
  overlaysFromDocument,
} from "./surface";
import { argsOf, basename, languageFor, resultText } from "./tool-view";
import { asNumber, asString, isRecord } from "./guards";

export function createInitialWebState(): WebState {
  return {
    transcriptSeq: 0,
    commands: {},
    session: null,
    liveSession: { messages: [], session: null },
    messages: [],
    streaming: false,
    todos: [],
    todoPhases: [],
    queue: { steering: [], followUp: [] },
    models: [],
    model: null,
    thinkingLevel: null,
    thinkingLevels: [],
    modes: {},
    meta: {},
    usage: null,
    draft: { rev: 0, text: "", origin: "tui" },
    completion: { open: false, prefix: "", items: [], selectedIndex: -1, enterAccepts: false },
    openInteractions: [],
    resolvedInteractions: {},
    interactionErrors: {},
    surfaceDoc: {},
    surface: createSurfaceDocument(),
    overlays: [],
    hasLiveOverlay: false,
    notifications: [],
    fenceStatus: null,
    sessions: [],
    artifacts: [],
    activeArtifactId: null,
    toolExecutions: {},
    widgets: {},
  };
}

function cloneMessages(messages: UiMessage[]): UiMessage[] {
  // Structural sharing: only the message currently being streamed can change
  // in this pass. Historical messages keep their identity so memoized
  // derivations (buildSteps) do not recompute the whole transcript.
  return messages.map((message) =>
    message.streaming
      ? { ...message, blocks: message.blocks?.map((block) => ({ ...block })) }
      : message,
  );
}

function normalizeFrame(frame: ServerFrame): ServerFrame {
  if (!frame || typeof frame !== "object") return { type: "unknown" };
  const payload = isRecord(frame.payload) ? frame.payload : undefined;
  // `{type, payload:{...}}` and `{type, ...fields}` both end up flat. Explicit
  // outer fields win so a future envelope cannot hide the discriminator.
  return payload ? { ...payload, ...frame } : frame;
}

/* ------------------------------------------------------------------ *
 * Snapshot hydration
 * ------------------------------------------------------------------ */

function normalizeModel(raw: unknown): ModelRef | null {
  if (!isRecord(raw)) return null;
  const provider = asString(raw.provider);
  const id = asString(raw.id ?? raw.modelId ?? raw.model);
  if (!provider && !id) return null;
  return {
    ...raw,
    provider,
    id,
    name: typeof raw.name === "string" ? raw.name : undefined,
  };
}

function normalizeModels(raw: unknown): ModelRef[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeModel)
    .filter((model): model is ModelRef => model !== null);
}

function normalizeSession(raw: unknown): SessionSummary | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id ?? raw.sessionId);
  if (!id) return null;
  return {
    id,
    title: typeof raw.title === "string" ? raw.title : null,
    cwd: typeof raw.cwd === "string" ? raw.cwd : null,
    path: typeof raw.path === "string" ? raw.path : null,
    modified: typeof raw.modified === "string" ? raw.modified : typeof raw.modified === "number" && Number.isFinite(raw.modified) && Math.abs(raw.modified) <= 8.64e15 ? new Date(raw.modified).toISOString() : null,
    messageCount: asNumber(raw.messageCount),
  };
}

function normalizeSessions(raw: unknown): SessionSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeSession)
    .filter((session): session is SessionSummary => session !== null);
}

function mergeSessions(previous: SessionSummary[], incoming: unknown): SessionSummary[] {
  const merged = new Map(previous.map((item) => [item.id, item]));
  for (const item of normalizeSessions(incoming)) {
    const old = merged.get(item.id);
    const currentTime = Date.parse(item.modified ?? "") || 0;
    const oldTime = Date.parse(old?.modified ?? "") || 0;
    if (!old || currentTime > oldTime) merged.set(item.id, item);
  }
  return [...merged.values()];
}

function normalizeBlock(raw: unknown): MessageBlock | null {
  if (!isRecord(raw)) return null;
  const type = asString(raw.type);
  if (type === "text") {
    return { type: "text", text: asString(raw.text) };
  }
  if (type === "thinking") {
    return { type: "thinking", text: asString(raw.text ?? raw.thinking) };
  }
  if (type === "toolCall") {
    const id = asString(raw.id ?? raw.toolCallId);
    if (!id) return null;
    return {
      type: "toolCall",
      id,
      toolCallId: id,
      name: asString(raw.name ?? raw.toolName, "tool"),
      args: raw.args ?? raw.arguments,
      argsText: typeof raw.argsText === "string" ? raw.argsText : undefined,
      result: raw.result,
      resultText: typeof raw.resultText === "string" ? raw.resultText : undefined,
      isError: Boolean(raw.isError),
      status: raw.isError
        ? "failed"
        : raw.status
          ? normalizeToolStatus(raw.status)
          : raw.result !== undefined
            ? "completed"
            : "running",
    };
  }
  if (type === "tool") {
    const id = asString(raw.toolCallId ?? raw.id);
    if (!id) return null;
    return {
      type: "tool",
      toolCallId: id,
      name: asString(raw.name ?? raw.toolName, "tool"),
      status: raw.isError
        ? "failed"
        : raw.status
          ? normalizeToolStatus(raw.status)
          : raw.result !== undefined
            ? "completed"
            : "running",
      args: raw.args,
      result: raw.result,
    };
  }
  if (type === "image") {
    return {
      type: "image",
      url: typeof raw.url === "string" ? raw.url : undefined,
      alt: typeof raw.alt === "string" ? raw.alt : undefined,
    };
  }
  if (typeof raw.text === "string") {
    return { type: "text", text: raw.text };
  }
  return null;
}

function normalizeMessage(raw: unknown, index = 0): UiMessage | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id, `message-${index}`);
  const role = asString(raw.role, "assistant") as MessageRole;
  const blocks = Array.isArray(raw.blocks)
    ? raw.blocks
        .map(normalizeBlock)
        .filter((block): block is MessageBlock => block !== null)
    : [];
  if (!blocks.length && typeof raw.text === "string" && raw.text.length > 0) {
    blocks.push({ type: "text", text: raw.text });
  }
  return {
    id,
    role,
    attribution: typeof raw.attribution === "string" ? raw.attribution : undefined,
    blocks,
    streaming: Boolean(raw.streaming),
    timestamp: asNumber(raw.timestamp),
    toolCallId: typeof raw.toolCallId === "string" ? raw.toolCallId : undefined,
    toolName: typeof raw.toolName === "string" ? raw.toolName : undefined,
    isError: Boolean(raw.isError),
    command: typeof raw.command === "string" ? raw.command : undefined,
    output: typeof raw.output === "string" ? raw.output : undefined,
    exitCode: asNumber(raw.exitCode),
    code: typeof raw.code === "string" ? raw.code : undefined,
    customType: typeof raw.customType === "string" ? raw.customType : undefined,
    excludeFromContext: Boolean(raw.excludeFromContext),
    path: typeof raw.path === "string" ? raw.path : undefined,
    content: typeof raw.content === "string" ? raw.content : undefined,
    summary: typeof raw.summary === "string" ? raw.summary : undefined,
  };
}

function normalizeMessages(raw: unknown): UiMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((message, index) => normalizeMessage(message, index))
    .filter((message): message is UiMessage => message !== null);
}

function normalizeToolStatus(raw: unknown, isError = false): ToolStatus {
  if (isError) return "failed";
  if (raw === "completed" || raw === "failed" || raw === "error") return raw;
  if (raw === "running") return "running";
  return "running";
}

function normalizeToolExecution(raw: unknown, fallbackId: string): ToolExecution | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id ?? raw.toolCallId, fallbackId);
  if (!id) return null;
  const isError = Boolean(raw.isError);
  const hasResult = raw.result !== undefined;
  const status = raw.status
    ? normalizeToolStatus(raw.status, isError)
    : isError
      ? "failed"
      : hasResult
        ? "completed"
        : "running";
  return {
    id,
    name: asString(raw.name ?? raw.toolName, "tool"),
    status,
    toolCallId: asString(raw.toolCallId ?? raw.id, id),
    toolName: asString(raw.toolName ?? raw.name, "tool"),
    args: raw.args,
    argsText: typeof raw.argsText === "string" ? raw.argsText : undefined,
    partialResult: raw.partialResult,
    result: raw.result,
    isError,
    messageId: typeof raw.messageId === "string" ? raw.messageId : undefined,
  };
}

function normalizeToolMap(raw: unknown): Record<string, ToolExecution> | null {
  if (!isRecord(raw)) return null;
  const tools: Record<string, ToolExecution> = {};
  for (const [key, value] of Object.entries(raw)) {
    const tool = normalizeToolExecution(value, key);
    if (tool) tools[tool.id] = tool;
  }
  return tools;
}

function normalizeUsage(raw: unknown): UsageState | null {
  if (!isRecord(raw)) return null;
  return raw as UsageState;
}

function normalizeQueue(raw: unknown): { steering: string[]; followUp: string[] } {
  const value = isRecord(raw) ? raw : {};
  const strings = (input: unknown) =>
    Array.isArray(input)
      ? input.map((item) => String(item)).filter((item) => item.length > 0)
      : [];
  return { steering: strings(value.steering), followUp: strings(value.followUp) };
}

function normalizeTodos(raw: unknown): { phases: TodoPhase[]; tasks: TodoItem[] } {
  const source = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.phases)
      ? raw.phases
      : isRecord(raw) && Array.isArray(raw.tasks)
        ? [raw]
        : [];
  const phases: TodoPhase[] = [];
  for (const entry of source) {
    if (!isRecord(entry)) continue;
    if (Array.isArray(entry.tasks)) {
      phases.push({
        name: asString(entry.name ?? entry.title, "Todo"),
        tasks: entry.tasks
          .map((task) => normalizeTodoTask(task))
          .filter((task): task is TodoItem => task !== null),
      });
    } else if (entry.content || entry.status) {
      const task = normalizeTodoTask(entry);
      if (task) {
        const last = phases[phases.length - 1];
        if (last && last.name === "Todo") last.tasks.push(task);
        else phases.push({ name: "Todo", tasks: [task] });
      }
    }
  }
  return { phases, tasks: phases.flatMap((phase) => phase.tasks) };
}

function normalizeTodoTask(raw: unknown): TodoItem | null {
  if (!isRecord(raw)) return null;
  const content = asString(raw.content ?? raw.task ?? raw.title);
  if (!content) return null;
  return {
    content,
    status: asString(raw.status, "pending"),
    description: typeof raw.description === "string" ? raw.description : undefined,
  };
}

function normalizeModes(raw: unknown): SessionModeState | Record<string, unknown> {
  return isRecord(raw) ? (raw as SessionModeState) : {};
}

function normalizeDraft(raw: unknown, current?: DraftState): DraftState {
  if (!isRecord(raw)) return current ?? { rev: 0, text: "", origin: "tui" };
  const cursor = raw.cursor;
  return {
    rev: asNumber(raw.rev) ?? 0,
    text: asString(raw.text),
    cursor:
      typeof cursor === "number" || isRecord(cursor)
        ? (cursor as DraftState["cursor"])
        : undefined,
    origin: raw.origin === "web" ? "web" : "tui",
    images: Array.isArray(raw.images) ? raw.images : [],
    texts: Array.isArray(raw.texts) ? raw.texts : [],
    composer: isRecord(raw.composer) ? raw.composer : {},
  };
}

function normalizeWidgets(raw: unknown): Record<string, string[] | null> | null {
  if (Array.isArray(raw)) {
    const widgets: Record<string, string[]> = {};
    for (const entry of raw) {
      if (!isRecord(entry)) continue;
      const key = asString(entry.key);
      if (!key) continue;
      widgets[key] = Array.isArray(entry.lines)
        ? entry.lines.map(String)
        : typeof entry.lines === "string"
          ? [entry.lines]
          : [];
    }
    return widgets;
  }
  if (isRecord(raw)) {
    const widgets: Record<string, string[] | null> = {};
    for (const [key, value] of Object.entries(raw)) {
      widgets[key] = value === null
        ? null
        : Array.isArray(value)
          ? value.map(String)
          : typeof value === "string"
            ? [value]
            : null;
    }
    return widgets;
  }
  return null;
}

function normalizeWidgetEntries(raw: unknown): WidgetEntry[] {
  const map = normalizeWidgets(raw) ?? {};
  return Object.entries(map)
    .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]))
    .map(([key, lines]) => ({ key, lines }));
}

function normalizeArtifacts(raw: unknown): ArtifactItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry, index): ArtifactItem | null => {
      if (!isRecord(entry)) return null;
      const path = asString(entry.path ?? entry.file ?? entry.name);
      const id = asString(entry.id ?? path, `artifact-${index}`);
      if (!id) return null;
      const diff = entry.diff;
      return {
        id,
        path: path || undefined,
        name: asString(entry.name ?? basename(path), id),
        kind: asString(entry.kind, "file"),
        language: asString(entry.language, "text"),
        content: typeof entry.content === "string" ? entry.content : undefined,
        diff:
          isRecord(diff) || typeof diff === "string" ? (diff as DiffStat | string) : null,
        isError: Boolean(entry.isError),
      };
    })
    .filter((artifact): artifact is ArtifactItem => artifact !== null);
}

function normalizeNotifications(raw: unknown): Notification[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry, index): Notification | null => {
      if (typeof entry === "string") {
        return { id: `notice-${index}`, level: "info", message: entry };
      }
      if (!isRecord(entry)) return null;
      const message = asString(entry.message);
      if (!message) return null;
      return {
        id: asString(entry.id, `notice-${index}`),
        level: asString(entry.level, "info"),
        message,
      };
    })
    .filter((entry): entry is Notification => entry !== null);
}

function normalizeInteractionError(raw: unknown): InteractionError | null {
  if (!isRecord(raw)) return null;
  const errors = isRecord(raw.errors)
    ? Object.fromEntries(
        Object.entries(raw.errors).map(([key, value]) => [key, String(value)]),
      )
    : null;
  return {
    code: typeof raw.code === "string" ? raw.code : undefined,
    message: typeof raw.message === "string" ? raw.message : undefined,
    errors,
  };
}

export function normalizeInteraction(raw: unknown): InteractionRequest | null {
  if (!isRecord(raw)) return null;
  const request = isRecord(raw.request) ? raw.request : raw;
  const payload = request.payload;
  const payloadRecord = isRecord(payload) ? payload : undefined;
  const id = asString(
    request.id ??
      request.requestId ??
      (isRecord(raw) ? raw.requestId : undefined) ??
      payloadRecord?.id ??
      payloadRecord?.requestId ??
      payloadRecord?.reviewId,
  );
  if (!id) return null;
  return {
    id,
    kind: asString(request.kind ?? request.type, "confirm"),
    payload,
  };
}

function normalizeInteractions(raw: unknown): InteractionRequest[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeInteraction)
    .filter((entry): entry is InteractionRequest => entry !== null);
}

function pickSnapshot(frame: ServerFrame): ServerFrame {
  if (isRecord(frame.snapshot)) {
    return {
      ...frame.snapshot,
      models: frame.models ?? frame.snapshot.models,
      modes: frame.modes ?? frame.snapshot.modes,
      sessions: frame.sessions ?? frame.snapshot.sessions,
    };
  }
  return frame;
}

function metaFromSnapshot(
  snap: ServerFrame,
  previous: MetaState,
): MetaState {
  const raw = isRecord(snap.meta) ? snap.meta : {};
  return {
    ...previous,
    ...raw,
    model:
      normalizeModel(raw.model) ??
      normalizeModel(snap.model) ??
      previous.model ??
      null,
    thinkingLevel:
      typeof raw.thinkingLevel === "string"
        ? raw.thinkingLevel
        : typeof snap.thinkingLevel === "string"
          ? snap.thinkingLevel
          : previous.thinkingLevel ?? null,
    thinkingLevels: Array.isArray(raw.thinkingLevels)
      ? raw.thinkingLevels.map(String)
      : previous.thinkingLevels,
    modes: isRecord(raw.modes)
      ? normalizeModes(raw.modes)
      : snap.modes !== undefined
        ? normalizeModes(snap.modes)
        : previous.modes ?? {},
    busy:
      typeof raw.busy === "boolean"
        ? raw.busy
        : typeof snap.streaming === "boolean"
          ? snap.streaming
          : previous.busy,
    title:
      typeof raw.title === "string"
        ? raw.title
        : typeof snap.session === "object" && isRecord(snap.session)
          ? (typeof snap.session.title === "string" ? snap.session.title : previous.title)
          : previous.title,
    fence:
      isRecord(raw.fence)
        ? raw.fence
        : isRecord(snap.fence)
          ? snap.fence
          : previous.fence ?? null,
  };
}

export interface RenderIndexes {
  attachedToolIds: ReadonlySet<string>;
  activeStreamingId: string | null;
}

const renderIndexCache = new WeakMap<UiMessage[], RenderIndexes>();

/**
 * Derived indexes for ConversationView. Computed once per messages array in
 * liveCommit and cached by reference, so the renderer reads them in O(1)
 * instead of rescanning every message on every stream frame.
 */
export function renderIndexes(messages: UiMessage[]): RenderIndexes {
  const cached = renderIndexCache.get(messages);
  if (cached) return cached;
  return computeRenderIndexes(messages);
}

function computeRenderIndexes(messages: UiMessage[]): RenderIndexes {
  const attachedToolIds = new Set<string>();
  let activeStreamingId: string | null = null;
  for (const message of messages) {
    if (message.streaming) activeStreamingId = message.id;
    for (const block of message.blocks ?? []) {
      if (block.type === "toolCall") attachedToolIds.add(block.id);
      else if (block.type === "tool") attachedToolIds.add(block.toolCallId);
    }
  }
  const indexes = { attachedToolIds, activeStreamingId };
  renderIndexCache.set(messages, indexes);
  return indexes;
}

type LiveHistory = { hasMore: boolean; oldestId?: string | null };
type LiveSessionWithHistory = WebState["liveSession"] & { history?: LiveHistory };

function sameModel(
  a: ModelRef | null | undefined,
  b: ModelRef | null | undefined,
): boolean {
  if (!a || !b || a.provider !== b.provider) return false;
  if (a.id === b.id) return true;
  // The host reports the current model with a flattened id while the catalog
  // keeps the full id (`kw92/deepseek-…` vs `kw92/mistral/deepseek-…`). They
  // are the same model; treating them as different lets a one-model snapshot
  // clobber the full catalog and lose every nickname.
  const aTail = a.id.split("/").filter(Boolean).pop() ?? a.id;
  const bTail = b.id.split("/").filter(Boolean).pop() ?? b.id;
  return Boolean(a.id && b.id && aTail === bTail);
}

function sameStringArray(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function sameModes(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

// A snapshot or meta.update may omit capabilities that the host has not
// re-sent yet. Empty values must never erase the last known good selection,
// and equal values must keep their reference so message-only frames cannot
// re-render the model and thinking controls.
function stableModels(
  next: ModelRef[] | undefined,
  previous: ModelRef[],
): ModelRef[] {
  if (!Array.isArray(next) || next.length === 0) return previous;
  const normalized = normalizeModels(next);
  if (normalized.length === 0) return previous;
  // Some snapshot paths synthesize a one-element list from the selected
  // model. A strict subset of the known list is not a real capability
  // update; keep the full list so the controls do not lose choices.
  if (
    normalized.length < previous.length &&
    normalized.every((entry) =>
      previous.some((known) => sameModel(entry, known)),
    )
  ) {
    return previous;
  }
  if (
    normalized.length === previous.length &&
    normalized.every((entry, index) => sameModel(entry, previous[index]))
  ) {
    return previous;
  }
  return normalized;
}

function stableModel(
  next: ModelRef | null | undefined,
  previous: ModelRef | null,
): ModelRef | null {
  const normalized = normalizeModel(next);
  if (!normalized) return previous;
  return sameModel(normalized, previous) ? previous : normalized;
}

function stableText(
  next: string | null | undefined,
  previous: string | null,
): string | null {
  if (typeof next !== "string" || next.trim().length === 0) return previous;
  return next === previous ? previous : next;
}

function stableStringArray(
  next: string[] | undefined,
  previous: string[] | undefined,
): string[] {
  const before = previous ?? [];
  if (!Array.isArray(next)) return before;
  const normalized = next.map(String);
  if (normalized.length === 0) {
    return before.length === 0 ? before : [];
  }
  return sameStringArray(normalized, before) ? before : normalized;
}

function stableModes(
  next: Record<string, string> | undefined,
  previous: Record<string, string>,
): Record<string, string> {
  if (!isRecord(next)) return previous;
  const normalized = normalizeModes(next);
  if (Object.keys(normalized).length === 0) return previous;
  return sameModes(normalized, previous) ? previous : normalized;
}

function stableMeta(
  next: MetaState | undefined,
  previous: MetaState,
): MetaState {
  if (!next) return previous;
  const merged: MetaState = {
    ...previous,
    ...next,
    model: stableModel(next.model, previous.model ?? null),
    thinkingLevel: stableText(next.thinkingLevel, previous.thinkingLevel),
    thinkingLevels: stableStringArray(
      next.thinkingLevels,
      previous.thinkingLevels,
    ),
    modes: stableModes(next.modes, previous.modes),
  };
  const unchanged =
    merged.busy === previous.busy &&
    merged.title === previous.title &&
    merged.fence === previous.fence &&
    merged.model === previous.model &&
    merged.thinkingLevel === previous.thinkingLevel &&
    merged.thinkingLevels === previous.thinkingLevels &&
    merged.modes === previous.modes;
  return unchanged ? previous : merged;
}

function liveCommit(
  state: WebState,
  live: { messages?: UiMessage[]; session?: SessionSummary | null; history?: LiveHistory },
  patch: Partial<WebState> = {},
): WebState {
  const liveSession = {
    messages: live.messages ?? state.liveSession.messages,
    session:
      live.session !== undefined ? live.session : state.liveSession.session,
    history:
      live.history !== undefined
        ? live.history
        : (state.liveSession as LiveSessionWithHistory).history,
  } as LiveSessionWithHistory;
  computeRenderIndexes(liveSession.messages);
  const safePatch: Partial<WebState> = {
    ...patch,
    models: stableModels(patch.models, state.models),
    model: stableModel(patch.model, state.model ?? null) ?? state.model,
    thinkingLevel: stableText(patch.thinkingLevel, state.thinkingLevel),
    thinkingLevels: stableStringArray(
      patch.thinkingLevels,
      state.thinkingLevels,
    ),
    modes: stableModes(patch.modes, state.modes),
    meta: stableMeta(patch.meta, state.meta),
  };
  const next: WebState = { ...state, ...safePatch, liveSession };
  return { ...next, messages: liveSession.messages, session: liveSession.session };
}

/* ------------------------------------------------------------------ *
 * Streaming deltas
 * ------------------------------------------------------------------ */

function ensureAssistant(
  messages: UiMessage[],
  id: string | undefined,
): UiMessage {
  if (id) {
    const found = messages.find((message) => message.id === id);
    if (found) {
      const updated = { ...found, blocks: (found.blocks ?? []).map((block) => ({ ...block })), streaming: true };
      messages[messages.indexOf(found)] = updated;
      return updated;
    }
  }
  const streaming = [...messages].reverse().find(
    (message) => message.role === "assistant" && message.streaming,
  );
  const fallback = streaming ?? [...messages].reverse().find((message) => message.role === "assistant");
  if (fallback) {
    const updated = { ...fallback, blocks: (fallback.blocks ?? []).map((block) => ({ ...block })) };
    messages[messages.indexOf(fallback)] = updated;
    return updated;
  }
  const created: UiMessage = {
    id: id ?? `stream-${messages.length}`,
    role: "assistant",
    blocks: [],
    streaming: true,
  };
  messages.push(created);
  return created;
}

const MAX_BLOCK_CHARS = 1_000_000;
function capBlockText(value: string): string {
  return value.length > MAX_BLOCK_CHARS
    ? `${value.slice(0, MAX_BLOCK_CHARS)}\n… [truncated]`
    : value;
}

function appendTextBlock(
  message: UiMessage,
  index: number,
  type: "text" | "thinking",
  delta: string,
): void {
  message.blocks ??= [];
  const current = message.blocks[index];
  if (current && current.type === type) {
    current.text = capBlockText(current.text + delta);
    return;
  }
  // A reconciler may reuse blockIndex after finishing a tool call. Appending
  // preserves the earlier text instead of overwriting it.
  const last = message.blocks[message.blocks.length - 1];
  if (last && last.type === type && index >= message.blocks.length) {
    last.text += delta;
    return;
  }
  message.blocks.push({ type, text: delta });
}

function attachToolBlock(
  message: UiMessage,
  id: string,
  name: string,
  status: ToolStatus,
): UiMessage {
  const blocks = (message.blocks ?? []).map((block) => {
    if (block.type === "toolCall" && block.id === id) {
      return { ...block, name: block.name || name, status };
    }
    if (block.type === "tool" && block.toolCallId === id) {
      return { ...block, name: block.name || name, status };
    }
    return block;
  });
  const found = blocks.some(
    (block) =>
      (block.type === "toolCall" && block.id === id) ||
      (block.type === "tool" && block.toolCallId === id),
  );
  if (!found) blocks.push({ type: "tool", toolCallId: id, name, status });
  return { ...message, blocks };
}

function findToolMessage(messages: UiMessage[], id: string): UiMessage | undefined {
  for (const message of messages) {
    if (
      message.blocks?.some((block) =>
        block.type === "toolCall"
          ? block.id === id
          : block.type === "tool"
            ? block.toolCallId === id
            : false,
      )
    ) {
      return message;
    }
  }
  return undefined;
}

function updateBlockResult(
  messages: UiMessage[],
  id: string,
  result: unknown,
  isError: boolean,
): void {
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    let changed = false;
    const blocks = (message.blocks ?? []).map((block) => {
      if (block.type === "toolCall" && block.id === id) {
        changed = true;
        return {
          ...block,
          result,
          isError,
          status: isError ? ("failed" as const) : ("completed" as const),
        };
      }
      if (block.type === "tool" && block.toolCallId === id) {
        changed = true;
        return {
          ...block,
          result,
          status: isError ? ("failed" as const) : ("completed" as const),
        };
      }
      return block;
    });
    if (changed) messages[messageIndex] = { ...message, blocks };
  }
}

function applyDelta(state: WebState, frame: ServerFrame): WebState {
  const seq = asNumber(frame.seq);
  if (seq !== undefined && seq <= state.transcriptSeq) return state;
  const next = applyDeltaInner(state, frame);
  return seq !== undefined ? { ...next, transcriptSeq: Math.max(next.transcriptSeq, seq) } : next;
}

function applyDeltaInner(state: WebState, frame: ServerFrame): WebState {
  const deltaKind =
    asString(frame.kind) ||
    (frame.type === "transcript.delta" ? "" : frame.type);
  const messageId = asString(
    frame.messageId ?? (isRecord(frame.message) ? frame.message.id : undefined),
  );

  if (
    (deltaKind === "text_delta" || deltaKind === "thinking_delta") &&
    messageId
  ) {
    const index = state.liveSession.messages.findIndex(
      (message) => message.id === messageId,
    );
    if (index >= 0) {
      const previous = state.liveSession.messages[index];
      const blockIndex =
        asNumber(frame.blockIndex ?? frame.index) ??
        previous.blocks?.length ??
        0;
      // Copy only the block that this delta will mutate; history stays shared.
      const blocks = (previous.blocks ?? []).slice();
      if (blockIndex < blocks.length) {
        blocks[blockIndex] = { ...blocks[blockIndex] };
      } else if (blocks.length > 0) {
        blocks[blocks.length - 1] = { ...blocks[blocks.length - 1] };
      }
      const message: UiMessage = {
        ...previous,
        blocks,
        streaming: true,
      };
      appendTextBlock(
        message,
        blockIndex,
        deltaKind === "thinking_delta" ? "thinking" : "text",
        asString(frame.delta ?? frame.text),
      );
      const messages = state.liveSession.messages.map((item, itemIndex) => {
        if (itemIndex === index) return message;
        return item.streaming ? { ...item, streaming: false } : item;
      });
      return liveCommit(
        state,
        { messages },
        { toolExecutions: { ...state.toolExecutions }, streaming: true },
      );
    }
  }

  const messages = cloneMessages(state.liveSession.messages);
  const tools = { ...state.toolExecutions };

  if (deltaKind === "message_start" || deltaKind === "message") {
    const incoming = normalizeMessage(frame.message, messages.length);
    if (incoming) {
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (message.streaming) messages[index] = { ...message, streaming: false };
      }
      const index = messages.findIndex((message) => message.id === incoming.id);
      const next = { ...incoming, streaming: true };
      if (index >= 0) messages[index] = next;
      else messages.push(next);
    }
  } else if (deltaKind === "text_delta" || deltaKind === "thinking_delta") {
    const message = ensureAssistant(messages, messageId || undefined);
    const index = asNumber(frame.blockIndex ?? frame.index) ?? message.blocks?.length ?? 0;
    appendTextBlock(
      message,
      index,
      deltaKind === "thinking_delta" ? "thinking" : "text",
      asString(frame.delta ?? frame.text),
    );
    for (let i = 0; i < messages.length; i += 1) {
      const item = messages[i];
      const streaming = item.id === message.id;
      if (Boolean(item.streaming) !== streaming) messages[i] = { ...item, streaming };
    }
  } else if (
    deltaKind === "toolcall_start" ||
    deltaKind === "toolcall_delta" ||
    deltaKind === "toolcall_end"
  ) {
    const id = asString(frame.toolCallId ?? frame.id);
    if (id) {
      const name = asString(frame.toolName ?? frame.name, "tool");
      const previous = tools[id];
      const argsDelta = asString(frame.delta ?? frame.argsDelta);
      const joinedArgs =
        deltaKind === "toolcall_delta"
          ? `${previous?.argsText ?? ""}${argsDelta}`
          : previous?.argsText;
      const argsText =
        joinedArgs && joinedArgs.length > 64 * 1024
          ? `${joinedArgs.slice(0, 64 * 1024)}\n… [truncated]`
          : joinedArgs;
      const next: ToolExecution = {
        ...(previous ?? {
          id,
          name,
          status: "running" as const,
          toolCallId: id,
          toolName: name,
        }),
        id,
        name: name === "tool" && previous?.name ? previous.name : name,
        status: "running",
        argsText: deltaKind === "toolcall_end" ? undefined : argsText,
        args:
          deltaKind === "toolcall_end"
            ? frame.args ?? previous?.args
            : previous?.args ?? frame.args,
        messageId: messageId || previous?.messageId,
      };
      if (deltaKind === "toolcall_end" && next.args === undefined) {
        const rawArgs = argsText ?? "";
        if (rawArgs) {
          try {
            next.args = JSON.parse(rawArgs);
          } catch {
            // The streamed arguments may be incomplete or truncated.
          }
        }
      }
      tools[id] = next;
      const target =
        (messageId ? messages.find((message) => message.id === messageId) : undefined) ??
        findToolMessage(messages, id) ??
        ensureAssistant(messages, undefined);
      messages[messages.indexOf(target)] = attachToolBlock(target, id, next.name, "running");
    }
  } else if (
    deltaKind === "tool_start" ||
    deltaKind === "tool_update" ||
    deltaKind === "tool_end"
  ) {
    const id = asString(frame.toolCallId ?? frame.id);
    if (id) {
      const name = asString(frame.toolName ?? frame.name, "tool");
      const previous = tools[id];
      const isError = Boolean(frame.isError);
      const status = isError
        ? "failed"
        : deltaKind === "tool_end"
          ? "completed"
          : "running";
      tools[id] = {
        ...(previous ?? { id, name }),
        id,
        name: previous?.name && previous.name !== "tool" ? previous.name : name,
        status,
        isError,
        args: frame.args ?? previous?.args,
        partialResult:
          deltaKind === "tool_update" ? frame.partialResult : previous?.partialResult,
        result:
          deltaKind === "tool_end" ? frame.result : previous?.result,
        messageId: messageId || previous?.messageId,
      };
      const target =
        (messageId ? messages.find((message) => message.id === messageId) : undefined) ??
        findToolMessage(messages, id) ??
        ensureAssistant(messages, undefined);
      messages[messages.indexOf(target)] = attachToolBlock(target, id, tools[id].name, status);
      if (deltaKind === "tool_end") {
        updateBlockResult(messages, id, frame.result, isError);
      }
    }
  } else if (deltaKind === "message_end") {
    const index = messages.findIndex((item) => item.id === messageId);
    if (index >= 0) {
      const message = messages[index];
      const incoming = normalizeMessage(frame.message, messages.length);
      messages[index] = {
        ...message,
        streaming: false,
        ...(incoming && incoming.id === message.id && incoming.blocks?.length
          ? { blocks: incoming.blocks }
          : {}),
      };
    }
  } else if (deltaKind === "agent_end") {
    if (Array.isArray(frame.messages)) {
      for (const raw of frame.messages) {
        const incoming = normalizeMessage(raw, messages.length);
        if (!incoming) continue;
        const index = messages.findIndex((item) => item.id === incoming.id);
        if (index >= 0) messages[index] = { ...messages[index], ...incoming };
        else messages.push(incoming);
      }
    }
    for (let index = 0; index < messages.length; index += 1) {
      if (messages[index].streaming) {
        messages[index] = { ...messages[index], streaming: false };
      }
    }
  }

  // Agent lifetime is bounded by agent_start/agent_end, not by a single
  // message. A message_end (or an intermediate snapshot) must never make the
  // UI look idle while the turn is still running.
  const streaming =
    deltaKind === "agent_end"
      ? false
      : deltaKind === "message_end"
        ? Boolean(state.streaming) || Boolean(state.meta.busy)
        : true;

  return liveCommit(
    state,
    { messages },
    {
      toolExecutions: tools,
      streaming,
      // Agent turn state is independent from individual message streaming.
      // Only agent_end closes the turn; any other agent event keeps it busy.
      meta: { ...state.meta, busy: deltaKind !== "agent_end" },
    },
  );
}

/* ------------------------------------------------------------------ *
 * Surface rendering state
 * ------------------------------------------------------------------ */

function surfacePatch(
  document: SurfaceDocument,
  overlays: OverlaySummary[],
): Pick<WebState, "surface" | "surfaceDoc" | "overlays" | "hasLiveOverlay"> {
  return {
    surface: document,
    surfaceDoc: flattenSurface(document),
    overlays,
    hasLiveOverlay: overlays.length > 0,
  };
}

function normalizeSurfaceForSnapshot(raw: unknown): SurfaceDocument {
  const document = normalizeSurfaceDocument(raw);
  if (isRecord(raw) && Array.isArray(raw.ops) && !raw.root) {
    return applySurfaceOps(document, raw.ops);
  }
  return document;
}

/* ------------------------------------------------------------------ *
 * Reducer
 * ------------------------------------------------------------------ */

export function reduceWebState(state: WebState, rawFrame: ServerFrame): WebState {
  const frame = normalizeFrame(rawFrame);
  const next = reduceWebStateInner(state, frame);
  if (frame.type === "snapshot") {
    const seq = asNumber(frame.seq);
    if (seq !== undefined) return { ...next, transcriptSeq: seq };
  }
  return next;
}

function reduceWebStateInner(state: WebState, rawFrame: ServerFrame): WebState {
  const frame = normalizeFrame(rawFrame);
  const activeId = state.liveSession.session?.id;
  if (frame.type !== "session.select" && typeof frame.sessionId === "string" && activeId && frame.sessionId !== activeId) return state;
  switch (frame.type) {
    case "manager.sessions":
      return Array.isArray(frame.sessions) ? { ...state, sessions: normalizeSessions(frame.sessions) } : state;
    case "session.select": {
      const id = asString(frame.sessionId);
      if (!id) return state;
      const session = { id, title: typeof frame.title === "string" ? frame.title : null };
      const fresh = createInitialWebState();
      return { ...fresh, models: state.models, sessions: state.sessions, notifications: state.notifications,
        session, liveSession: { session, messages: [] } };
    }
    case "command.pending": {
      const id = asString(frame.requestId);
      const command = asString(frame.command);
      if (!id || !command || state.commands[id]) return state;
      const sessionId = typeof frame.sessionId === "string" ? frame.sessionId : activeId;
      return { ...state, commands: { ...state.commands, [id]: { command, status: "pending", sessionId } } };
    }
    case "command.result": {
      const id = asString(frame.requestId);
      const entry = state.commands[id];
      if (!entry || entry.status !== "pending" || typeof frame.ok !== "boolean") return state;
      const code = typeof frame.code === "string" ? frame.code : undefined;
      const message = typeof frame.message === "string" ? frame.message : undefined;
      return { ...state, commands: { ...state.commands, [id]: { ...entry, status: frame.ok ? "ok" : "error", code, message, value: frame.value } },
        notifications: frame.ok ? state.notifications : appendNotification(state, "error", `${code ?? "failed"}${message ? `: ${message}` : ""}`) };
    }
    case "history.page": {
      if (frame.ok === false || !Array.isArray(frame.messages)) return state;
      const page = isRecord(frame.history) ? frame.history : frame;
      const incoming = normalizeMessages(frame.messages);
      const seen = new Set(state.liveSession.messages.map((message) => message.id));
      const older = incoming.filter((message) => {
        if (seen.has(message.id)) return false;
        seen.add(message.id);
        return true;
      });
      const nextHistory = {
        hasMore: page.hasMore === true && incoming.length > 0,
        oldestId:
          older[0]?.id ?? state.liveSession.messages[0]?.id ?? null,
      };
      if (older.length === 0) {
        return liveCommit(state, { history: nextHistory });
      }
      return liveCommit(state, {
        messages: [...older, ...state.liveSession.messages],
        history: nextHistory,
      });
    }
    case "snapshot": {
      const snap = pickSnapshot(frame);
      const meta = metaFromSnapshot(snap, state.meta);
      const session = normalizeSession(snap.session);
      const tail = normalizeMessages(snap.messages).map((message, index, all) => ({
        ...message,
        // A stale flag on a historical message must not render as "正在生成".
        // Only the final message can still be streaming in a snapshot.
        streaming: Boolean(message.streaming) && index === all.length - 1,
      }));
      const previous = state.liveSession.messages;
      const previousHistory = (state.liveSession as LiveSessionWithHistory).history;
      const sameSession = Boolean(session?.id && session.id === state.liveSession.session?.id);
      const snapHistory = isRecord(snap.history) ? snap.history : null;
      const nextHistory: LiveHistory | undefined = snapHistory
        ? {
            hasMore: snapHistory.hasMore === true,
            oldestId:
              typeof snapHistory.oldestId === "string" ? snapHistory.oldestId : null,
          }
        : undefined;
      const history = nextHistory ?? (sameSession ? previousHistory : undefined);
      const hasMore = history?.hasMore === true;
      let anchor = -1;
      for (const candidate of tail) {
        const index = previous.findIndex((message) => message.id === candidate.id);
        if (index >= 0) {
          anchor = index;
          break;
        }
      }
      const tailIds = new Set(tail.map((message) => message.id));
      let messages = tail;
      if (sameSession && previous.length > 0) {
        if (anchor >= 0) {
          messages = [
            ...previous.slice(0, anchor).filter((message) => !tailIds.has(message.id)),
            ...tail,
          ];
        } else if (hasMore) {
          messages = [
            ...previous.filter((message) => !tailIds.has(message.id)),
            ...tail,
          ];
        }
      }
      const todos = normalizeTodos(snap.todos ?? snap.todoPhases);
      const models =
        snap.models !== undefined ? normalizeModels(snap.models) : state.models;
      const model =
        normalizeModel(meta.model) ??
        (models.length === 1 ? models[0] : state.model);
      const surface = normalizeSurfaceForSnapshot(
        snap.surface ?? snap.surfaceDoc ?? null,
      );
      const overlays = normalizeOverlays(snap.overlays);
      const derivedOverlays = overlays.length
        ? overlays
        : overlaysFromDocument(surface);
      const draft = normalizeDraft(snap.draft, state.draft);
      const interactions = normalizeInteractions(
        snap.pendingInteractions ?? snap.interactions,
      );
      const notifications = Array.isArray(snap.notifications ?? snap.toasts)
        ? normalizeNotifications(snap.notifications ?? snap.toasts)
        : state.notifications;
      const widgets = normalizeWidgets(snap.widgets);
      const tools = normalizeToolMap(snap.toolExecutions);
      const usage = snap.usage !== undefined ? normalizeUsage(snap.usage) : state.usage;
      const nextMeta: MetaState = {
        ...meta,
        model,
        thinkingLevel:
          typeof meta.thinkingLevel === "string"
            ? meta.thinkingLevel
            : typeof snap.thinkingLevel === "string"
              ? snap.thinkingLevel
              : state.thinkingLevel,
        modes: normalizeModes(meta.modes ?? snap.modes ?? state.modes),
        busy:
          typeof meta.busy === "boolean"
            ? meta.busy
            : typeof snap.streaming === "boolean"
              ? Boolean(snap.streaming)
              : state.streaming,
      };
      return liveCommit(
        state,
        { messages, session, history },
        {
          todos: todos.tasks,
          todoPhases: todos.phases,
          queue: normalizeQueue(snap.queue),
          models,
          model,
          thinkingLevel: nextMeta.thinkingLevel ?? null,
          thinkingLevels: Array.isArray(meta.thinkingLevels)
            ? meta.thinkingLevels
            : state.thinkingLevels,
          modes: nextMeta.modes ?? {},
          meta: nextMeta,
          usage,
          draft,
          openInteractions: interactions,
          sessions:
            snap.sessions !== undefined
              ? mergeSessions(state.sessions, snap.sessions)
              : state.sessions,
          artifacts:
            snap.artifacts !== undefined
              ? normalizeArtifacts(snap.artifacts)
              : state.artifacts,
          activeArtifactId:
            snap.activeArtifactId === undefined
              ? state.activeArtifactId
              : typeof snap.activeArtifactId === "string"
                ? snap.activeArtifactId
                : null,
          toolExecutions: tools ?? state.toolExecutions,
          widgets: widgets ?? state.widgets,
          notifications,
          fenceStatus:
            typeof snap.fenceStatus === "string"
              ? snap.fenceStatus
              : typeof (isRecord(snap.fence) ? snap.fence.status : undefined) === "string"
                ? String((snap.fence as Record<string, unknown>).status)
                : state.fenceStatus,
          // The authoritative turn state comes from meta.busy, which only
          // agent_start/agent_end may flip. Intermediate snapshots broadcast
          // after message_end legitimately contain no streaming message yet
          // the agent is still working; never derive idle from messages alone.
          streaming: Boolean(nextMeta.busy) || messages.some((message) => message.streaming),
          ...surfacePatch(surface, derivedOverlays),
        },
      );
    }

    case "transcript.delta":
      return applyDelta(state, frame);

    case "completion.state": {
      const raw = isRecord(frame) ? frame : {};
      const items = Array.isArray(raw.items)
        ? raw.items.filter(isRecord).slice(0, 50).map((item) => ({
            value: asString(item.value),
            label: asString(item.label ?? item.value),
            description: typeof item.description === "string" ? item.description : undefined,
            hint: typeof item.hint === "string" ? item.hint : undefined,
            disabled: item.disabled === true,
          }))
        : [];
      const selectedIndex = asNumber(raw.selectedIndex);
      return {
        ...state,
        completion: {
          open: raw.open === true,
          prefix: asString(raw.prefix),
          items,
          selectedIndex:
            typeof selectedIndex === "number" && selectedIndex >= 0 && selectedIndex < items.length
              ? selectedIndex
              : -1,
          enterAccepts: raw.enterAccepts === true,
        },
      };
    }

    case "draft.sync": {
      const rev = asNumber(frame.rev) ?? 0;
      if (rev <= state.draft.rev) return state;
      return { ...state, draft: normalizeDraft(frame, state.draft) };
    }

    case "interaction.open": {
      const request = normalizeInteraction(frame);
      if (!request) return state;
      const interactionErrors = { ...state.interactionErrors };
      delete interactionErrors[request.id];
      return {
        ...state,
        openInteractions: [
          ...state.openInteractions.filter((item) => item.id !== request.id),
          request,
        ],
        interactionErrors,
      };
    }

    case "interaction.close": {
      const id = asString(
        frame.requestId ??
          (isRecord(frame.request) ? frame.request.id : undefined) ??
          frame.id,
      );
      if (!id) return state;
      const resolved = { ...state.resolvedInteractions };
      resolved[id] = asString(frame.resolvedBy, "web");
      const interactionErrors = { ...state.interactionErrors };
      delete interactionErrors[id];
      return {
        ...state,
        openInteractions: state.openInteractions.filter((item) => item.id !== id),
        resolvedInteractions: resolved,
        interactionErrors,
      };
    }

    case "interaction.error": {
      const id = asString(frame.requestId);
      if (!id) {
        return {
          ...state,
          notifications: appendNotification(state, "error", asString(frame.code, "交互校验失败")),
        };
      }
      const error = normalizeInteractionError(frame);
      return {
        ...state,
        interactionErrors: error
          ? { ...state.interactionErrors, [id]: error }
          : state.interactionErrors,
      };
    }

    case "surface.frame": {
      const nextSf = typeof frame.sf === "string" ? frame.sf : state.surface.sf;
      const nextS = asNumber(frame.s);
      if (
        nextS !== undefined &&
        (nextSf ?? null) === (state.surface.sf ?? null) &&
        nextS <= (state.surface.seq ?? 0)
      ) {
        return state;
      }
      const ops = Array.isArray(frame.ops)
        ? frame.ops
        : isRecord(frame.surface) && Array.isArray(frame.surface.ops)
          ? frame.surface.ops
          : [];
      const surface = applySurfaceOps(state.surface, ops);
      const nextSurface: SurfaceDocument = {
        ...surface,
        sf: typeof frame.sf === "string" ? frame.sf : surface.sf,
        seq: asNumber(frame.s) ?? surface.seq,
      };
      const overlays = normalizeOverlays(frame.overlays);
      const derived = overlays.length ? overlays : overlaysFromDocument(nextSurface);
      return { ...state, ...surfacePatch(nextSurface, derived) };
    }

    case "todo.update": {
      const todos = normalizeTodos(frame.phases ?? frame.todos ?? frame);
      return { ...state, todos: todos.tasks, todoPhases: todos.phases };
    }

    case "usage.update":
      return { ...state, usage: normalizeUsage(frame) };

    case "meta.update": {
      const raw = isRecord(frame.meta) ? { ...frame.meta, ...frame } : frame;
      const meta: MetaState = {
        ...state.meta,
        ...raw,
        model:
          normalizeModel(raw.model) ?? state.meta.model ?? state.model,
        thinkingLevel:
          typeof raw.thinkingLevel === "string"
            ? raw.thinkingLevel
            : state.thinkingLevel,
        modes: isRecord(raw.modes) ? normalizeModes(raw.modes) : state.modes,
        busy: typeof raw.busy === "boolean" ? raw.busy : state.meta.busy,
        fence: isRecord(raw.fence) ? raw.fence : state.meta.fence,
      };
      const model = normalizeModel(raw.model) ?? state.model;
      const models = Array.isArray(raw.models)
        ? normalizeModels(raw.models)
        : state.models;
      const mergedModels =
        model && !models.some((entry) => sameModel(entry, model))
          ? [model, ...models]
          : models;
      const title =
        typeof raw.title === "string"
          ? raw.title
          : state.liveSession.session?.title ?? null;
      const session =
        raw.title !== undefined
          ? { ...(state.liveSession.session ?? { id: "live" }), title }
          : undefined;
      return liveCommit(
        state,
        session ? { session } : {},
        {
          meta,
          model,
          thinkingLevel:
            typeof raw.thinkingLevel === "string"
              ? raw.thinkingLevel
              : state.thinkingLevel,
          modes: meta.modes ?? {},
          streaming:
            typeof raw.busy === "boolean" ? raw.busy : state.streaming,
          queue: isRecord(raw.queue) ? normalizeQueue(raw.queue) : state.queue,
          models: mergedModels,
          sessions: Array.isArray(raw.sessions)
            ? mergeSessions(state.sessions, raw.sessions)
            : state.sessions,
          thinkingLevels: Array.isArray(raw.thinkingLevels)
            ? raw.thinkingLevels.map(String)
            : state.thinkingLevels,
        },
      );
    }

    case "toast": {
      const message = asString(frame.message);
      if (!message) return state;
      return {
        ...state,
        notifications: appendNotification(
          state,
          asString(frame.level, "info"),
          message,
        ),
      };
    }

    case "widget.update": {
      const key = asString(frame.key);
      if (!key) return state;
      const widgets = { ...state.widgets };
      if (frame.lines === null || frame.lines === undefined) {
        delete widgets[key];
      } else {
        widgets[key] = Array.isArray(frame.lines)
          ? frame.lines.map(String)
          : [String(frame.lines)];
      }
      return { ...state, widgets };
    }

    case "artifact.select": {
      const id = asString(frame.id);
      return { ...state, activeArtifactId: id || null };
    }

    case "session.switched": {
      if (isRecord(frame.snapshot)) {
        return reduceWebState(state, {
          type: "snapshot",
          ...frame.snapshot,
        } as ServerFrame);
      }
      const session = normalizeSession(frame.session);
      return liveCommit(state, session ? { session } : {});
    }

    case "client.error": {
      return {
        ...state,
        notifications: appendNotification(
          state,
          "warning",
          `命令被拒绝：${asString(frame.code, "unknown")}`,
        ),
      };
    }

    default:
      return state;
  }
}

function appendNotification(
  state: WebState,
  level: string,
  message: string,
): Notification[] {
  return [
    ...state.notifications.slice(-19),
    {
      id: `toast-${state.notifications.length}-${Date.now()}`,
      level,
      message,
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Selectors
 * ------------------------------------------------------------------ */

export function selectDisplayGroups(state: WebState): DisplayGroup[] {
  const groups: DisplayGroup[] = [];
  for (const message of state.messages) {
    if (message.role === "user") {
      groups.push({ kind: "user", id: message.id, messages: [message] });
      continue;
    }
    if (message.role === "bashExecution" || message.role === "pythonExecution") {
      groups.push({ kind: "terminal", id: message.id, messages: [message] });
      continue;
    }
    if (
      message.role === "compactionSummary" ||
      message.role === "branchSummary"
    ) {
      groups.push({ kind: "boundary", id: message.id, messages: [message] });
      continue;
    }
    const blocks = message.blocks ?? [];
    const hasTool = blocks.some(
      (block) => block.type === "tool" || block.type === "toolCall",
    );
    const hasText = blocks.some(
      (block) => block.type === "text" && block.text.length > 0,
    );
    if (hasTool && !hasText) {
      groups.push({ kind: "processing", id: message.id, messages: [message] });
    } else if (hasText) {
      groups.push({ kind: "assistant", id: message.id, messages: [message] });
    } else {
      groups.push({ kind: "other", id: message.id, messages: [message] });
    }
  }
  return groups;
}

/**
 * Snapshot artifacts are only rebuilt on session hydrate. During a live turn
 * they are stale, so merge file tools from the transcript with the snapshot
 * list. Path is the stable identity the tool cards already use.
 */
export function selectArtifacts(state: WebState): ArtifactItem[] {
  const byPath = new Map<string, ArtifactItem>();
  for (const artifact of state.artifacts) {
    byPath.set(artifact.path ?? artifact.id, artifact);
  }
  for (const message of state.liveSession.messages.length
    ? state.liveSession.messages
    : state.messages) {
    for (const block of message.blocks ?? []) {
      if (block.type !== "tool" && block.type !== "toolCall") continue;
      const id = block.type === "toolCall" ? block.id : block.toolCallId;
      const execution = state.toolExecutions[id];
      const name = execution?.name ?? block.name;
      if (
        name !== "read" &&
        name !== "write" &&
        name !== "edit" &&
        name !== "apply_patch"
      ) {
        continue;
      }
      const args = argsOf({
        args: execution?.args ?? block.args,
        argsText:
          execution?.argsText ??
          (block.type === "toolCall" ? block.argsText : undefined),
      });
      const path = typeof args.path === "string" ? args.path : "";
      if (!path) continue;
      const content =
        name === "read"
          ? resultText(
              execution?.result ?? execution?.partialResult ?? block.result,
            )
          : name === "write"
            ? String(args.content ?? "")
            : name === "apply_patch"
              ? String(args.patch ?? "")
              : String(args.new_string ?? args.newText ?? "");
      const previous =
        name === "edit"
          ? String(args.old_string ?? args.oldText ?? "")
          : undefined;
      const existing = byPath.get(path);
      const blockError = block.type === "toolCall" ? block.isError : false;
      byPath.set(path, {
        id: existing?.id ?? path,
        path,
        name: existing?.name ?? basename(path),
        kind: name === "apply_patch" ? "edit" : name,
        language: languageFor(path),
        content: content || existing?.content || "",
        previous: previous ?? existing?.previous,
        diff: existing?.diff ?? null,
        isError: Boolean(execution?.isError || blockError || existing?.isError),
      });
    }
  }
  return Array.from(byPath.values());
}

export function selectActiveArtifact(state: WebState): ArtifactItem | null {
  if (!state.activeArtifactId) return null;
  const artifacts = selectArtifacts(state);
  return (
    artifacts.find((item) => item.id === state.activeArtifactId) ??
    artifacts.find((item) => item.path === state.activeArtifactId) ??
    null
  );
}

export function selectArtifactById(
  state: WebState,
  id: string | null,
): ArtifactItem | null {
  if (!id) return null;
  const artifacts = selectArtifacts(state);
  return (
    artifacts.find((item) => item.id === id) ??
    artifacts.find((item) => item.path === id) ??
    null
  );
}

export type UsageView = {
  percent: number;
  tokens: number | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  contextWindow: number | null;
  cost: number | null;
};

export function selectUsage(state: WebState): UsageView {
  const usage = state.usage;
  const tokenValue = usage?.tokens;
  const tokenRecord = isRecord(tokenValue) ? tokenValue : undefined;
  const context = usage?.context;
  const input = asNumber(tokenRecord?.input) ?? 0;
  const output = asNumber(tokenRecord?.output) ?? 0;
  const cacheRead = asNumber(tokenRecord?.cacheRead) ?? 0;
  const cacheWrite = asNumber(tokenRecord?.cacheWrite) ?? 0;
  const summed = input + output + cacheRead + cacheWrite;
  const total =
    typeof tokenValue === "number"
      ? tokenValue
      : asNumber(tokenRecord?.total) ?? (summed > 0 ? summed : null);
  const contextTokens =
    asNumber(context?.tokens) ?? asNumber(context?.token_count) ?? 0;
  const contextWindow =
    asNumber(usage?.contextWindow) ??
    asNumber(context?.contextWindow) ??
    asNumber(context?.max_context_tokens) ??
    null;
  const percentFromContext =
    contextTokens > 0 && contextWindow
      ? (contextTokens / contextWindow) * 100
      : 0;
  const cost = isRecord(usage?.cost)
    ? asNumber(usage.cost.total)
    : asNumber(usage?.cost);
  return {
    percent: Math.max(
      0,
      Math.min(
        100,
        Math.round(
          asNumber(usage?.percent) ??
            asNumber(context?.percent) ??
            percentFromContext,
        ),
      ),
    ),
    tokens: total ?? (contextTokens || null),
    input,
    output,
    cacheRead,
    cacheWrite,
    contextWindow,
    cost: cost ?? null,
  };
}

export function selectModelKey(model: ModelRef | null): string {
  return model ? `${model.provider}/${model.id}` : "";
}

export function selectModeStatus(
  modes: WebState["modes"] | null | undefined,
  mode: "plan" | "vibe" | "goal" | "loop",
): string {
  const entry = isRecord(modes) ? modes[mode] : undefined;
  if (isRecord(entry) && typeof entry.status === "string") return entry.status;
  if (typeof entry === "string") return entry;
  return "inactive";
}

export function selectWorkingText(state: WebState): string | null {
  const working = state.meta.setWorkingMessage;
  if (typeof working === "string" && working.trim()) return working.trim();
  const status = state.meta.setStatus;
  return typeof status === "string" && status.trim() ? status.trim() : null;
}

export function selectWidgetList(state: WebState): WidgetEntry[] {
  return normalizeWidgetEntries(state.widgets);
}

export function frameToast(frame: ServerFrame): { level: string; message: string } | null {
  const normalized = normalizeFrame(frame);
  if (normalized.type !== "toast") return null;
  const message = asString(normalized.message);
  return message
    ? { level: asString(normalized.level, "info"), message }
    : null;
}

export function frameType(frame: ServerFrame): string {
  const normalized = normalizeFrame(frame);
  return typeof normalized.type === "string" ? normalized.type : "unknown";
}

