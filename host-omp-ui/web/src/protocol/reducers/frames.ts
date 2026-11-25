import type {
  MetaState,
  Notification,
  ServerFrame,
  WebState,
} from "../types";
import { asString, isRecord } from "../guards";
import {
  mergeSessions,
  normalizeInteraction,
  normalizeInteractionError,
  normalizeMessages,
  normalizeModel,
  normalizeModels,
  normalizeModes,
  normalizeQueue,
  normalizeTodos,
  normalizeUsage,
} from "./normalize";
import { sameModel } from "./stable";
import { liveCommit } from "./live";
import { MessageLog } from "../message-log";

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

function reduceCommandPending(state: WebState, frame: ServerFrame): WebState {
  const id = asString(frame.requestId);
  const command = asString(frame.command);
  if (!id || !command || state.commands[id]) return state;
  const sessionId = typeof frame.sessionId === "string" ? frame.sessionId : state.liveSession.session?.id;
  return { ...state, commands: { ...state.commands, [id]: { command, status: "pending", sessionId } } };
}

function reduceCommandResult(state: WebState, frame: ServerFrame): WebState {
  const id = asString(frame.requestId);
  const entry = state.commands[id];
  if (!entry || entry.status !== "pending" || typeof frame.ok !== "boolean") return state;
  const code = typeof frame.code === "string" ? frame.code : undefined;
  const message = typeof frame.message === "string" ? frame.message : undefined;
  return { ...state, commands: { ...state.commands, [id]: { ...entry, status: frame.ok ? "ok" : "error", code, message, value: frame.value } },
    notifications: frame.ok ? state.notifications : appendNotification(state, "error", `${code ?? "failed"}${message ? `: ${message}` : ""}`) };
}

function reduceHistoryPage(state: WebState, frame: ServerFrame): WebState {
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
    // Prepending shifts every position, so the result carries no provenance of
    // its own: a consumer regroups rather than reusing a prefix whose indices
    // all moved. The log is still structure-shared, so this costs one build of
    // the page plus the trie, not a copy per frame.
    messages: MessageLog.from([
      ...older,
      ...state.liveSession.messages,
    ]),
    history: nextHistory,
  });
}

function reduceInteractionOpen(state: WebState, frame: ServerFrame): WebState {
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

function reduceInteractionClose(state: WebState, frame: ServerFrame): WebState {
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

function reduceInteractionError(state: WebState, frame: ServerFrame): WebState {
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

function reduceTodoUpdate(state: WebState, frame: ServerFrame): WebState {
  const todos = normalizeTodos(frame.phases ?? frame.todos ?? frame);
  return { ...state, todos: todos.tasks, todoPhases: todos.phases };
}

function reduceUsageUpdate(state: WebState, frame: ServerFrame): WebState {
  return { ...state, usage: normalizeUsage(frame) };
}

function reduceMetaUpdate(state: WebState, frame: ServerFrame): WebState {
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

function reduceToast(state: WebState, frame: ServerFrame): WebState {
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

function reduceWidgetUpdate(state: WebState, frame: ServerFrame): WebState {
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

function reduceClientError(state: WebState, frame: ServerFrame): WebState {
  return {
    ...state,
    notifications: appendNotification(
      state,
      "warning",
      `命令被拒绝：${asString(frame.code, "unknown")}`,
    ),
  };
}

/**
 * Pure frame domains. Returns `undefined` for frame types that need the
 * dispatch surface in store.ts (snapshot, transcript deltas, surface frames,
 * completion/draft, session lifecycle). `reduceWebState` calls this after the
 * session guard, so ordering and the guard stay identical.
 */
export function reduceFrame(state: WebState, frame: ServerFrame): WebState | undefined {
  switch (frame.type) {
    case "command.pending":
      return reduceCommandPending(state, frame);
    case "command.result":
      return reduceCommandResult(state, frame);
    case "history.page":
      return reduceHistoryPage(state, frame);
    case "interaction.open":
      return reduceInteractionOpen(state, frame);
    case "interaction.close":
      return reduceInteractionClose(state, frame);
    case "interaction.error":
      return reduceInteractionError(state, frame);
    case "todo.update":
      return reduceTodoUpdate(state, frame);
    case "usage.update":
      return reduceUsageUpdate(state, frame);
    case "meta.update":
      return reduceMetaUpdate(state, frame);
    case "toast":
      return reduceToast(state, frame);
    case "widget.update":
      return reduceWidgetUpdate(state, frame);
    case "client.error":
      return reduceClientError(state, frame);
    default:
      return undefined;
  }
}
