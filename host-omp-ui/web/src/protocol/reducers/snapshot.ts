import type {
  MetaState,
  OverlaySummary,
  ServerFrame,
  SurfaceDocument,
  WebState,
} from "../types";
import {
  applySurfaceOps,
  flattenSurface,
  normalizeOverlays,
  normalizeSurfaceDocument,
  overlaysFromDocument,
} from "../surface";
import { isRecord } from "../guards";
import { normalizeWidgets } from "./widgets";
import {
  mergeSessions,
  metaFromSnapshot,
  normalizeArtifacts,
  normalizeDraft,
  normalizeInteractions,
  normalizeMessages,
  normalizeModel,
  normalizeModels,
  normalizeModes,
  normalizeNotifications,
  normalizeQueue,
  normalizeSession,
  normalizeTodos,
  normalizeToolMap,
  normalizeUsage,
  pickSnapshot,
} from "./normalize";
import { liveCommit } from "./live";
import type { LiveHistory, LiveSessionWithHistory } from "./live";

export function surfacePatch(
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

export function reduceSnapshot(state: WebState, frame: ServerFrame): WebState {
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
