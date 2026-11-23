// The synchronous aggregate root. Every mutation computes the next value,
// commits it, and only then calls the injected ticket capability at the tail.
// A ticket's synchronous prefix therefore sees the committed snapshot, never a
// half-updated one. No async, no await, no in-flight ledger.

import {
  createInteractionLedger,
  openInteraction,
  resolveInteraction,
  closeInteraction,
  listOpenInteractions,
} from "./domain/interaction-race.mjs";
import {
  reconstructTranscriptFromEntries,
  applyAgentEvent,
  groupTranscriptForDisplay,
  isRealUser,
} from "./domain/transcript-model.mjs";
import { extractArtifacts } from "./domain/tool-artistry.mjs";
import { applyTspOpsToDocument, createEmptyDocument } from "./domain/surface-fence.mjs";
import { parseClientCommand } from "./domain/protocol-codec.mjs";

const MAX_SNAPSHOT_CHARS = 8 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 128 * 1024;
const MAX_TOOL_CHARS = 128 * 1024;
const MAX_ARGS_CHARS = 64 * 1024;
const MAX_ARTIFACT_CHARS = 128 * 1024;
const MAX_HISTORY_LIMIT = 200;

function cappedText(value, limit) {
  if (typeof value !== "string" || value.length <= limit) return { text: value, truncated: false };
  return { text: `${value.slice(0, limit)}\n… [truncated]`, truncated: true };
}

function capValue(value, limit) {
  if (typeof value === "string") return cappedText(value, limit).text;
  if (Array.isArray(value)) return value.map((item) => capValue(item, limit));
  if (value && typeof value === "object") {
    const next = {};
    for (const [key, item] of Object.entries(value)) next[key] = capValue(item, limit);
    return next;
  }
  return value;
}

function capBlock(block) {
  if (!block || typeof block !== "object") return block;
  const next = { ...block };
  if (typeof next.text === "string") {
    const capped = cappedText(next.text, MAX_MESSAGE_CHARS);
    next.text = capped.text;
    if (capped.truncated) next.truncated = true;
  }
  if (Array.isArray(next.result)) next.result = next.result.map(capBlock);
  if (typeof next.resultText === "string") next.resultText = capValue(next.resultText, MAX_TOOL_CHARS);
  if (next.args && typeof next.args === "object") {
    const args = JSON.stringify(next.args);
    if (args.length > MAX_ARGS_CHARS) {
      next.args = { truncated: true, preview: args.slice(0, MAX_ARGS_CHARS) };
      next.truncated = true;
    }
  }
  return next;
}

function capMessage(message) {
  if (!message || typeof message !== "object") return message;
  const next = { ...message };
  if (Array.isArray(next.blocks)) next.blocks = next.blocks.map(capBlock);
  for (const key of ["text", "output", "content", "summary", "command"]) {
    if (typeof next[key] === "string") {
      const capped = cappedText(next[key], MAX_MESSAGE_CHARS);
      next[key] = capped.text;
      if (capped.truncated) next.truncated = true;
    }
  }
  if (Array.isArray(next.result)) next.result = next.result.map(capBlock);
  return next;
}

function capTool(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const next = { ...entry };
  for (const key of ["result", "partialResult"]) {
    if (typeof next[key] === "string") {
      const capped = cappedText(next[key], MAX_TOOL_CHARS);
      next[key] = capped.text;
      if (capped.truncated) next.truncated = true;
    } else if (next[key] && typeof next[key] === "object") {
      next[key] = capValue(next[key], MAX_TOOL_CHARS);
    }
  }
  if (next.args && typeof next.args === "object") {
    const args = JSON.stringify(next.args);
    if (args.length > MAX_ARGS_CHARS) {
      next.args = { truncated: true, preview: args.slice(0, MAX_ARGS_CHARS) };
      next.truncated = true;
    }
  }
  return next;
}

function capArtifact(artifact) {
  if (!artifact || typeof artifact !== "object") return artifact;
  const next = { ...artifact };
  if (typeof next.content === "string") {
    const capped = cappedText(next.content, MAX_ARTIFACT_CHARS);
    next.content = capped.text;
    if (capped.truncated) next.truncated = true;
  }
  return next;
}

function sizeOf(value) {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((total, item) => total + sizeOf(item), 0);
  if (value && typeof value === "object") return Object.values(value).reduce((total, item) => total + sizeOf(item), 0);
  return 0;
}

function fitSnapshot(doc) {
  const requestedHasMore = doc.history?.hasMore === true;
  const initialMessageCount = doc.messages.length;
  let messageLimit = doc.messages.length;
  let toolLimit = Object.keys(doc.toolExecutions).length;
  let artifactLimit = doc.artifacts.length;
  while (
    sizeOf(doc) > MAX_SNAPSHOT_CHARS &&
    (messageLimit > 1 || toolLimit > 1 || artifactLimit > 1)
  ) {
    messageLimit = Math.max(1, Math.floor(messageLimit / 2));
    toolLimit = Math.max(1, Math.floor(toolLimit / 2));
    artifactLimit = Math.max(1, Math.floor(artifactLimit / 2));
    doc.messages = doc.messages.slice(-messageLimit);
    doc.toolExecutions = Object.fromEntries(Object.entries(doc.toolExecutions).slice(-toolLimit));
    doc.artifacts = doc.artifacts.slice(-artifactLimit);
  }
  if (sizeOf(doc) > MAX_SNAPSHOT_CHARS) {
    doc.surface = capValue(doc.surface, MAX_MESSAGE_CHARS);
    doc.sessions = Array.isArray(doc.sessions) ? doc.sessions.slice(-50) : doc.sessions;
    doc.widgets = Array.isArray(doc.widgets)
      ? doc.widgets.slice(-50).map((widget) => ({
          ...widget,
          lines: Array.isArray(widget.lines)
            ? widget.lines.slice(-50).map((line) => capValue(line, MAX_MESSAGE_CHARS))
            : widget.lines,
        }))
      : doc.widgets;
  }
  doc.displayGroups = groupTranscriptForDisplay(doc.messages);
  doc.history = {
    hasMore: requestedHasMore || doc.messages.length < initialMessageCount,
    oldestId: doc.messages[0]?.id ?? null,
  };
  return doc;
}

// A page must not start in the middle of a turn. When the first message is not
// a real user, walk back to the nearest real user and include it. Legacy
// transcripts without attribution have no real-user boundary, so they keep the
// requested window instead of backtracking to the beginning.
const TURN_ALIGN_LIMIT = 400;

function alignToTurnStart(messages, start) {
  if (start <= 0) return start;
  if (isRealUser(messages[start])) return start;
  const floor = Math.max(0, start - TURN_ALIGN_LIMIT);
  for (let index = start - 1; index >= floor; index -= 1) {
    if (isRealUser(messages[index])) return index;
  }
  return start;
}

export function createDeltaMerger(dispatch, schedule = (run) => setTimeout(run, 16)) {
  let pending = null;
  let timer = null;
  let scheduled = false;
  const cancel = () => {
    if (timer != null && typeof clearTimeout === "function") clearTimeout(timer);
    timer = null;
    scheduled = false;
  };
  const flush = () => {
    cancel();
    if (!pending) return;
    const frame = pending;
    pending = null;
    dispatch(frame);
  };
  const push = (frame) => {
    const payload = frame?.payload;
    const mergeable =
      frame?.type === "transcript.delta" &&
      (payload?.kind === "text_delta" || payload?.kind === "thinking_delta");
    if (!mergeable) {
      flush();
      dispatch(frame);
      return;
    }
    if (
      pending &&
      pending.payload.kind === payload.kind &&
      pending.payload.messageId === payload.messageId &&
      pending.payload.blockIndex === payload.blockIndex
    ) {
      pending.payload.delta += payload.delta ?? "";
      if (typeof frame.seq === "number") pending.seq = Math.max(pending.seq ?? 0, frame.seq);
    } else {
      flush();
      pending = { type: "transcript.delta", seq: frame.seq, payload: { ...payload } };
    }
    if (!scheduled) {
      scheduled = true;
      timer = schedule(flush);
    }
  };
  return { push, flush };
}

const deltaMergers = new WeakMap();

function deltaMergerFor(dispatch) {
  let merger = deltaMergers.get(dispatch);
  if (!merger) {
    merger = createDeltaMerger(dispatch);
    deltaMergers.set(dispatch, merger);
  }
  return merger;
}

function wireDelta(event, next) {
  const update = event.assistantMessageEvent;
  if (event.type === "message_start") {
    return { type: "transcript.delta", payload: { kind: "message_start", message: next.streaming } };
  }
  if (event.type === "message_update" && update) {
    if (update.type === "text_delta" || update.type === "thinking_delta") {
      return {
        type: "transcript.delta",
        payload: {
          kind: update.type,
          messageId: next.streaming?.id ?? event.message?.id,
          blockIndex: next.blockIndex ?? 0,
          delta: update.delta ?? "",
        },
      };
    }
    if (update.type === "toolcall_start" || update.type === "toolcall_delta" || update.type === "toolcall_end") {
      const block = update.type === "toolcall_end"
        ? next.streaming?.blocks?.find((item) => item.type === "toolCall" && item.id === update.toolCallId)
        : null;
      return {
        type: "transcript.delta",
        payload: {
          kind: update.type,
          messageId: next.streaming?.id ?? event.message?.id,
          toolCallId: update.toolCallId,
          toolName: update.toolName,
          argsText: update.argumentsDelta ?? "",
          args: block?.args,
          delta: update.argumentsDelta ?? "",
        },
      };
    }
  }
  if (event.type === "message_end") {
    return { type: "transcript.delta", payload: { kind: "message_end", messageId: next.streaming?.id ?? event.message?.id } };
  }
  if (event.type.startsWith("tool_execution_")) {
    return {
      type: "transcript.delta",
      payload: {
        kind:
          event.type === "tool_execution_start"
            ? "tool_start"
            : event.type === "tool_execution_update"
              ? "tool_update"
              : "tool_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        partialResult: event.partialResult,
        result: event.result,
        isError: Boolean(event.isError),
      },
    };
  }
  return null;
}

export function createUiBridgeStation(options) {
  const capabilities = options?.capabilities ?? {};
  const ledger = createInteractionLedger();

  const state = {
    session: { id: null, file: null, title: null, cwd: options?.cwd ?? null },
    messages: [],
    displayGroups: [],
    artifacts: [],
    todos: [],
    usage: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: { total: 0 }, context: null },
    meta: { model: null, thinkingLevel: null, modes: null, busy: false, title: null, setStatus: null, setWorkingMessage: null, fence: null },
    draft: { rev: 0, origin: "tui", text: "", cursor: { line: 0, col: 0 }, images: [], texts: [], composer: {} },
    // Cross-origin draft trail. A remote write echoed back by the editor is
    // indistinguishable from typing once it reaches this layer; an A->B->A
    // alternation is the one shape real editing does not produce.
    draftTrail: [],
    // Latest autocomplete projection from the TUI editor. The TUI owns the
    // slash state machine; this is a mirror, never a second engine.
    completion: { open: false, prefix: "", items: [], selectedIndex: -1, enterAccepts: false },
    completionSig: "",
    streaming: null,
    toolExecutions: {},
    widgets: {},
    surface: createEmptyDocument(),
    toasts: [],
    models: [],
    sessions: [],
    queue: { steering: [], followUp: [] },
    activeArtifactId: null,
    fenceStatus: null,
  };

  function dispatch(event) {
    if (typeof capabilities.dispatch === "function") capabilities.dispatch(event);
  }

  function pendingInteractions() {
    return listOpenInteractions(ledger).map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      payload: entry.payload,
    }));
  }

  function snapshot(limit = 80) {
    const size = Math.min(Number.isInteger(limit) && limit > 0 ? limit : 80, 64);
    const rawStart = Math.max(0, state.messages.length - size);
    const start = alignToTurnStart(state.messages, rawStart);
    const messages = state.messages.slice(start).slice(-64).map(capMessage);
    const tools = Object.values(state.toolExecutions).slice(-32).map(capTool);
    const doc = {
      seq: state.seq ?? 0,
      session: { ...state.session },
      messages,
      displayGroups: groupTranscriptForDisplay(messages),
      history: { hasMore: start > 0 || state.messages.length > 64, oldestId: messages[0]?.id ?? null },
      artifacts: state.artifacts.slice(-16).map(capArtifact),
      todos: Array.isArray(state.todos) ? state.todos.map((todo) => ({ ...todo })) : state.todos,
      usage: state.usage
        ? {
            ...state.usage,
            tokens: state.usage.tokens ? { ...state.usage.tokens } : state.usage.tokens,
            cost: state.usage.cost ? { ...state.usage.cost } : state.usage.cost,
          }
        : state.usage,
      meta: { ...state.meta },
      draft: {
        ...state.draft,
        images: Array.isArray(state.draft?.images) ? [...state.draft.images] : state.draft?.images,
        texts: Array.isArray(state.draft?.texts) ? [...state.draft.texts] : state.draft?.texts,
        composer: state.draft?.composer && typeof state.draft.composer === "object"
          ? { ...state.draft.composer }
          : state.draft?.composer,
      },
      completion: {
        ...state.completion,
        items: Array.isArray(state.completion?.items)
          ? state.completion.items.map((item) => ({ ...item }))
          : state.completion?.items,
      },
      pendingInteractions: pendingInteractions(),
      widgets: Object.entries(state.widgets).map(([key, lines]) => ({
        key,
        lines: Array.isArray(lines) ? [...lines] : lines,
      })),
      surface: state.surface ? { ...state.surface } : state.surface,
      toasts: Array.isArray(state.toasts) ? state.toasts.map((toast) => ({ ...toast })) : state.toasts,
      streaming: Boolean(state.meta.busy),
      models: Array.isArray(state.models) ? [...state.models] : state.models,
      thinkingLevel: state.meta.thinkingLevel,
      thinkingLevels: state.meta.thinkingLevels,
      modes: state.meta.modes,
      sessions: Array.isArray(state.sessions) ? state.sessions.map((session) => ({ ...session })) : state.sessions,
      queue: {
        steering: Array.isArray(state.queue?.steering) ? [...state.queue.steering] : state.queue?.steering,
        followUp: Array.isArray(state.queue?.followUp) ? [...state.queue.followUp] : state.queue?.followUp,
      },
      activeArtifactId: state.activeArtifactId,
      fence: state.meta.fence && typeof state.meta.fence === "object"
        ? { ...state.meta.fence }
        : state.meta.fence,
      fenceStatus: state.fenceStatus && typeof state.fenceStatus === "object"
        ? { ...state.fenceStatus }
        : state.fenceStatus,
      toolExecutions: Object.fromEntries(tools.map((entry) => [entry.toolCallId, entry])),
    };
    return fitSnapshot(doc);
  }

  const station = {
    snapshot,

    historyPage(input) {
      const limit = Math.min(Number(input?.limit), MAX_HISTORY_LIMIT);
      if (!Number.isInteger(limit) || limit <= 0) {
        return { ok: false, code: "invalid_limit" };
      }
      const before = String(input?.before ?? "");
      const index = state.messages.findIndex((message) => message.id === before);
      if (index < 0) return { ok: false, code: "stale_cursor" };
      const rawStart = Math.max(0, index - limit);
      const start = alignToTurnStart(state.messages, rawStart);
      const messages = state.messages.slice(start, index).map(capMessage);
      return {
        ok: true,
        messages,
        history: {
          hasMore: start > 0,
          oldestId: messages[0]?.id ?? null,
        },
      };
    },

    openInteraction(request) {
      const result = openInteraction(ledger, request);
      if (!result.ok) return result;
      dispatch({ type: "interaction.open", payload: request });
      return result;
    },

    resolveInteraction(id, source, value) {
      const result = resolveInteraction(ledger, id, source, value);
      if (!result.accepted) return result;
      dispatch({ type: "interaction.close", payload: { requestId: id, resolvedBy: source } });
      return result;
    },

    closeInteraction(id) {
      const closed = closeInteraction(ledger, id);
      if (closed) dispatch({ type: "interaction.close", payload: { requestId: id, resolvedBy: "abort" } });
      return { ok: closed };
    },

    onTuiCompletionChanged(input) {
      const items = Array.isArray(input?.items)
        ? input.items.slice(0, 50).map((item) => ({
            value: String(item?.value ?? ""),
            label: String(item?.label ?? item?.value ?? ""),
            description: typeof item?.description === "string" ? item.description : undefined,
            hint: typeof item?.hint === "string" ? item.hint : undefined,
            disabled: item?.disabled === true,
          }))
        : [];
      const completion = {
        open: input?.open === true,
        prefix: String(input?.prefix ?? ""),
        items,
        selectedIndex: Number.isInteger(input?.selectedIndex) ? input.selectedIndex : -1,
        enterAccepts: input?.enterAccepts === true,
      };
      const sig = JSON.stringify(completion);
      if (sig === state.completionSig) return { open: completion.open };
      state.completionSig = sig;
      state.completion = completion;
      dispatch({ type: "completion.state", payload: completion });
      return { open: completion.open };
    },

    applyDraft(input) {
      const text = String(input?.text ?? "");
      const origin = input?.source === "web" ? "web" : "tui";
      const clientId = input?.clientId;
      const requestId = input?.requestId;
      if (text === state.draft.text) {
        if (origin === "web" && clientId && requestId) {
          dispatch({
            type: "sendClientFrame",
            payload: { clientId, frame: { type: "command.result", requestId, ok: true } },
          });
        }
        return { rev: state.draft.rev };
      }
      const trail = state.draftTrail;
      const last = trail.at(-1);
      const beforeLast = trail.at(-2);
      if (
        last && beforeLast &&
        last.origin !== origin &&
        beforeLast.origin === origin &&
        beforeLast.text === text &&
        last.text !== text
      ) {
        // A -> B -> A across origins is an echo, not an edit. Drop it before it
        // becomes a new revision the other side will mirror back again.
        trail.length = 0;
        return { rev: state.draft.rev };
      }
      trail.push({ text, origin });
      if (trail.length > 8) trail.shift();
      const rev = state.draft.rev + 1;
      state.draft = {
        ...state.draft,
        rev,
        origin,
        text,
        cursor: input?.cursor ?? state.draft.cursor,
        images: input?.images ?? state.draft.images,
        texts: input?.texts ?? state.draft.texts,
        composer: input?.composer ?? state.draft.composer,
      };
      dispatch({
        type: origin === "tui" ? "draft.sync" : "syncEditorDraft",
        payload: { rev, origin, text, cursor: state.draft.cursor, clientId, requestId },
      });
      return { rev };
    },

    submitComposer(input) {
      const payload = { text: String(input?.text ?? ""), mode: input?.mode ?? "default", attachments: input?.attachments ?? [], requestId: input?.requestId, clientId: input?.clientId };
      dispatch({ type: "submitComposer", payload });
      return { ok: true };
    },

    abort(input) {
      dispatch({ type: "abort", payload: { clientId: input?.clientId, requestId: input?.requestId } });
      return { ok: true };
    },

    setModel(input) {
      const payload = { provider: input?.provider, modelId: input?.modelId, clientId: input?.clientId, requestId: input?.requestId };
      dispatch({ type: "setModel", payload });
      return { ok: true };
    },

    setThinking(input) {
      const payload = { level: input?.level, clientId: input?.clientId, requestId: input?.requestId };
      dispatch({ type: "setThinking", payload });
      return { ok: true };
    },

    setMode(input) {
      const payload = {
        mode: input?.mode,
        action: input?.action,
        objective: input?.objective,
        tokenBudget: input?.tokenBudget,
        prompt: input?.prompt,
        clientId: input?.clientId,
        requestId: input?.requestId,
      };
      dispatch({ type: "setMode", payload });
      return { ok: true };
    },

    applySurfaceEvent(event) {
      dispatch({ type: "surfaceEvent", payload: event });
      return { ok: true };
    },

    applySurfaceKeys(input) {
      dispatch({ type: "surfaceKeys", payload: { data: String(input?.data ?? "") } });
      return { ok: true };
    },

    onSessionHydrate(session, entries) {
      state.session = { ...state.session, ...session };
      state.messages = reconstructTranscriptFromEntries(entries ?? []);
      state.displayGroups = groupTranscriptForDisplay(state.messages);
      state.artifacts = extractArtifacts(
        state.messages.map((message) => ({
          toolCall: message.blocks?.find((block) => block.type === "toolCall"),
          toolResult: message.role === "toolResult" ? message : undefined,
        })),
      );
      dispatch({ type: "snapshot", seq: state.seq ?? 0, payload: snapshot() });
      return { ok: true };
    },

    onSessionSwitch(ctx) {
      const manager = ctx?.sessionManager;
      state.session = {
        id: manager?.getSessionId?.() ?? null,
        file: manager?.getSessionFile?.() ?? null,
        title: manager?.getSessionName?.() ?? null,
        cwd: ctx?.cwd ?? state.session.cwd,
      };
      state.messages = reconstructTranscriptFromEntries(manager?.getBranch?.() ?? []);
      state.displayGroups = groupTranscriptForDisplay(state.messages);
      state.artifacts = [];
      state.streaming = null;
      state.toolExecutions = {};
      state.queue = { steering: [], followUp: [] };
      dispatch({ type: "session.switched", seq: state.seq ?? 0, payload: { snapshot: snapshot() } });
      return { ok: true };
    },

    onSessionClear(ctx) {
      return station.onSessionSwitch(ctx);
    },

    onSessionBranch(ctx) {
      return station.onSessionSwitch(ctx);
    },

    onAgentEvent(event) {
      const next = applyAgentEvent(
        {
          messages: state.messages,
          streaming: state.streaming,
          toolExecutions: state.toolExecutions,
        },
        event,
      );
      state.messages = next.messages;
      state.streaming = next.streaming;
      state.toolExecutions = next.toolExecutions;
      if (Object.keys(state.toolExecutions).length > 256) {
        state.toolExecutions = Object.fromEntries(Object.entries(state.toolExecutions).slice(-256));
      }
      state.displayGroups = groupTranscriptForDisplay(state.messages);
      state.meta = { ...state.meta, busy: event?.type !== "agent_end" };
      const delta = wireDelta(event, next);
      if (delta) {
        state.seq = (state.seq ?? 0) + 1;
        delta.seq = state.seq;
        deltaMergerFor(dispatch).push(delta);
      }
      if (event?.type === "message_end" || event?.type === "agent_end") {
        deltaMergerFor(dispatch).flush();
        dispatch({ type: "snapshot", seq: state.seq ?? 0, payload: snapshot() });
      }
      return { ok: true };
    },

    onTodoUpdate(phases) {
      state.todos = Array.isArray(phases) ? phases : [];
      dispatch({ type: "todo.update", payload: { phases: state.todos } });
      return { ok: true };
    },

    onUsageUpdate(usage) {
      state.usage = { ...state.usage, ...(usage ?? {}) };
      dispatch({ type: "usage.update", payload: state.usage });
      return { ok: true };
    },

    onMetaUpdate(patch) {
      const next = { ...(patch ?? {}) };
      // Normalize model payloads at the Station boundary so both `model_change`
      // events (string or { model }) and host readbacks share one shape.
      if (next.model !== undefined) {
        const raw = next.model;
        const text = typeof raw === "string"
          ? raw
          : typeof raw?.model === "string"
            ? raw.model
            : null;
        if (text) {
          const slash = text.indexOf("/");
          next.model = slash > 0
            ? { provider: text.slice(0, slash), id: text.slice(slash + 1) }
            : { provider: raw?.provider ?? "", id: text };
        } else if (raw && typeof raw === "object") {
          const id = typeof raw.id === "string" ? raw.id : typeof raw.modelId === "string" ? raw.modelId : null;
          if (id) next.model = { provider: raw.provider ?? "", id };
        }
      }
      if (next.thinkingLevel === undefined && next.level !== undefined) next.thinkingLevel = next.level;
      if (next.thinkingLevel !== undefined) delete next.level;
      state.meta = { ...state.meta, ...next };
      dispatch({ type: "meta.update", payload: next });
      return { ok: true };
    },

    onModelsUpdate(models) {
      state.models = Array.isArray(models) ? models : [];
      dispatch({ type: "meta.update", payload: { models: state.models } });
      return { ok: true };
    },

    onSessionsUpdate(sessions) {
      state.sessions = Array.isArray(sessions) ? sessions : [];
      dispatch({ type: "meta.update", payload: { sessions: state.sessions } });
      return { ok: true };
    },

    onQueueUpdate(queue) {
      state.queue = {
        steering: Array.isArray(queue?.steering) ? queue.steering : [],
        followUp: Array.isArray(queue?.followUp) ? queue.followUp : [],
      };
      dispatch({ type: "meta.update", payload: { queue: state.queue } });
      return { ok: true };
    },

    onWidgetUpdate(key, lines) {
      const stripWidgetAnsi = (line) => String(line)
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/\x1b[@-_]/g, "");
      if (lines === null || lines === undefined) delete state.widgets[key];
      else state.widgets[key] = (Array.isArray(lines) ? lines : [String(lines)]).map(stripWidgetAnsi);
      dispatch({ type: "widget.update", payload: { key, lines: state.widgets[key] ?? null } });
      return { ok: true };
    },

    onNotify(message, level) {
      const toast = { level: level ?? "info", message: String(message ?? "") };
      state.toasts = [...state.toasts.slice(-19), toast];
      dispatch({ type: "toast", payload: toast });
      return { ok: true };
    },

    onSurfaceFrame(frame) {
      state.surface = applyTspOpsToDocument(state.surface, frame?.ops ?? []);
      dispatch({ type: "surface.frame", payload: frame });
      return { ok: true };
    },

    onClientConnected(clientId) {
      dispatch({ type: "client.connected", payload: { clientId } });
      return { ok: true };
    },

    onClientDisconnected(clientId) {
      dispatch({ type: "client.disconnected", payload: { clientId } });
      return { ok: true };
    },

    onClientCommand(clientId, raw) {
      const parsed = parseClientCommand(raw);
      if (!parsed.ok) {
        const command = raw && typeof raw === "object" ? raw : null;
        const requestId = command?.requestId ?? command?.payload?.requestId;
        if (typeof requestId === "string" && requestId) {
          dispatch({ type: "sendClientFrame", payload: { clientId, frame: { type: "command.result", requestId, ok: false, code: parsed.code } } });
        } else {
          dispatch({ type: "client.error", payload: { clientId, ...parsed } });
        }
        return parsed;
      }
      const { type, payload } = parsed;
      if (type === "composer.draft") station.applyDraft({ source: "web", ...payload, clientId });
      if (type === "manager.history") {
        const page = station.historyPage({ before: payload.before, limit: payload.limit });
        dispatch({
          type: "sendClientFrame",
          payload: {
            clientId,
            frame: {
              type: "history.page",
              requestId: payload.requestId,
              ...page,
            },
          },
        });
        return;
      }
      else if (type === "composer.submit") station.submitComposer({ ...payload, clientId });
      else if (type === "session.abort") station.abort({ ...payload, clientId });
      else if (type === "session.set_model") station.setModel({ ...payload, clientId });
      else if (type === "session.set_thinking") station.setThinking({ ...payload, clientId });
      else if (type === "session.set_mode") station.setMode({ ...payload, clientId });
      else if (type === "interaction.respond") {
        station.resolveInteraction(payload.requestId, "web", payload);
      } else if (type === "surface.event") station.applySurfaceEvent(payload);
      else if (type === "surface.keys") station.applySurfaceKeys(payload);
      return { ok: true, type };
    },

    onTuiDraftChanged(draft) {
      return station.applyDraft({ source: "tui", ...draft });
    },

    onPlanReviewRequested(review) {
      return station.openInteraction({
        id: review?.reviewId ?? review?.id,
        kind: "plan_review",
        payload: review,
      });
    },

    onPlanReviewResolved(review) {
      return station.resolveInteraction(review?.reviewId ?? review?.id, "tui", review);
    },
  };

  return station;
}

