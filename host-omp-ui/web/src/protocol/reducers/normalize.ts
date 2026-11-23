import type {
  ArtifactItem,
  DiffStat,
  DraftState,
  InteractionError,
  InteractionRequest,
  MessageBlock,
  MessageRole,
  MetaState,
  ModelRef,
  Notification,
  ServerFrame,
  SessionModeState,
  SessionSummary,
  TodoItem,
  TodoPhase,
  ToolExecution,
  ToolStatus,
  UiMessage,
  UsageState,
} from "../types";
import { asNumber, asString, asStringArray, isRecord } from "../guards";
import { basename } from "../tool-view";

export function cloneMessages(messages: UiMessage[]): UiMessage[] {
  // Structural sharing: only the message currently being streamed can change
  // in this pass. Historical messages keep their identity so memoized
  // derivations (buildSteps) do not recompute the whole transcript.
  return messages.map((message) =>
    message.streaming
      ? { ...message, blocks: message.blocks?.map((block) => ({ ...block })) }
      : message,
  );
}

export function normalizeFrame(frame: ServerFrame): ServerFrame {
  if (!frame || typeof frame !== "object") return { type: "unknown" };
  const payload = isRecord(frame.payload) ? frame.payload : undefined;
  // `{type, payload:{...}}` and `{type, ...fields}` both end up flat. Explicit
  // outer fields win so a future envelope cannot hide the discriminator.
  return payload ? { ...payload, ...frame } : frame;
}

export function normalizeModel(raw: unknown): ModelRef | null {
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

export function normalizeModels(raw: unknown): ModelRef[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeModel)
    .filter((model): model is ModelRef => model !== null);
}

export function normalizeSession(raw: unknown): SessionSummary | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id ?? raw.sessionId);
  if (!id) return null;
  return {
    id,
    title: typeof raw.title === "string" ? raw.title : null,
    cwd: typeof raw.cwd === "string" ? raw.cwd : null,
    path: typeof raw.path === "string" ? raw.path : null,
    modified:
      typeof raw.modified === "string"
        ? raw.modified
        : typeof raw.modified === "number" &&
            Number.isFinite(raw.modified) &&
            Math.abs(raw.modified) <= 8.64e15
          ? new Date(raw.modified).toISOString()
          : null,
    messageCount: asNumber(raw.messageCount),
  };
}

export function normalizeSessions(raw: unknown): SessionSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeSession)
    .filter((session): session is SessionSummary => session !== null);
}

export function mergeSessions(
  previous: SessionSummary[],
  incoming: unknown,
): SessionSummary[] {
  const merged = new Map(previous.map((item) => [item.id, item]));
  for (const item of normalizeSessions(incoming)) {
    const old = merged.get(item.id);
    const currentTime = Date.parse(item.modified ?? "") || 0;
    const oldTime = Date.parse(old?.modified ?? "") || 0;
    if (!old || currentTime > oldTime) merged.set(item.id, item);
  }
  return [...merged.values()];
}

export function normalizeBlock(raw: unknown): MessageBlock | null {
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
      resultText:
        typeof raw.resultText === "string" ? raw.resultText : undefined,
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

export function normalizeMessage(
  raw: unknown,
  index = 0,
): UiMessage | null {
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
    attribution:
      typeof raw.attribution === "string" ? raw.attribution : undefined,
    blocks,
    streaming: Boolean(raw.streaming),
    timestamp: asNumber(raw.timestamp),
    toolCallId:
      typeof raw.toolCallId === "string" ? raw.toolCallId : undefined,
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

export function normalizeMessages(raw: unknown): UiMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((message, index) => normalizeMessage(message, index))
    .filter((message): message is UiMessage => message !== null);
}

export function normalizeToolStatus(
  raw: unknown,
  isError = false,
): ToolStatus {
  if (isError) return "failed";
  if (raw === "completed" || raw === "failed" || raw === "error") return raw;
  if (raw === "running") return "running";
  return "running";
}

export function normalizeToolExecution(
  raw: unknown,
  fallbackId: string,
): ToolExecution | null {
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

export function normalizeToolMap(
  raw: unknown,
): Record<string, ToolExecution> | null {
  if (!isRecord(raw)) return null;
  const tools: Record<string, ToolExecution> = {};
  for (const [key, value] of Object.entries(raw)) {
    const tool = normalizeToolExecution(value, key);
    if (tool) tools[tool.id] = tool;
  }
  return tools;
}

export function normalizeUsage(raw: unknown): UsageState | null {
  if (!isRecord(raw)) return null;
  return raw as UsageState;
}

export function normalizeQueue(raw: unknown): {
  steering: string[];
  followUp: string[];
} {
  const value = isRecord(raw) ? raw : {};
  return {
    steering: asStringArray(value.steering),
    followUp: asStringArray(value.followUp),
  };
}

export function normalizeTodos(raw: unknown): {
  phases: TodoPhase[];
  tasks: TodoItem[];
} {
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

export function normalizeTodoTask(raw: unknown): TodoItem | null {
  if (!isRecord(raw)) return null;
  const content = asString(raw.content ?? raw.task ?? raw.title);
  if (!content) return null;
  return {
    content,
    status: asString(raw.status, "pending"),
    description:
      typeof raw.description === "string" ? raw.description : undefined,
  };
}

export function normalizeModes(
  raw: unknown,
): SessionModeState | Record<string, unknown> {
  return isRecord(raw) ? (raw as SessionModeState) : {};
}

export function normalizeDraft(
  raw: unknown,
  current?: DraftState,
): DraftState {
  if (!isRecord(raw))
    return current ?? { rev: 0, text: "", origin: "tui" };
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

export function normalizeArtifacts(raw: unknown): ArtifactItem[] {
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
        content:
          typeof entry.content === "string" ? entry.content : undefined,
        diff:
          isRecord(diff) || typeof diff === "string"
            ? (diff as DiffStat | string)
            : null,
        isError: Boolean(entry.isError),
      };
    })
    .filter((artifact): artifact is ArtifactItem => artifact !== null);
}

export function normalizeNotifications(raw: unknown): Notification[] {
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

export function normalizeInteractionError(
  raw: unknown,
): InteractionError | null {
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

export function normalizeInteraction(
  raw: unknown,
): InteractionRequest | null {
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

export function normalizeInteractions(raw: unknown): InteractionRequest[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeInteraction)
    .filter((entry): entry is InteractionRequest => entry !== null);
}

export function pickSnapshot(frame: ServerFrame): ServerFrame {
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

export function metaFromSnapshot(
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
          ? typeof snap.session.title === "string"
            ? snap.session.title
            : previous.title
          : previous.title,
    fence: isRecord(raw.fence)
      ? raw.fence
      : isRecord(snap.fence)
        ? snap.fence
        : previous.fence ?? null,
  };
}
