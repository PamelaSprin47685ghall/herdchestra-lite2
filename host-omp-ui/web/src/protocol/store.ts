import type { ServerFrame, SurfaceDocument, WebState } from "./types";
import {
  applySurfaceOps,
  createSurfaceDocument,
  normalizeOverlays,
  overlaysFromDocument,
} from "./surface";
import { asNumber, asString, isRecord } from "./guards";
export {
  selectDisplayGroups,
  selectActiveArtifact,
  selectUsage,
  selectModelKey,
  selectModeStatus,
  selectWorkingText,
  selectWidgetList,
} from "./selectors";
export type { UsageView } from "./selectors";
import {
  normalizeDraft,
  normalizeFrame,
  normalizeSession,
  normalizeSessions,
} from "./reducers/normalize";
import { liveCommit } from "./reducers/live";
import { applyDelta } from "./reducers/transcript";
import { reduceSnapshot, surfacePatch } from "./reducers/snapshot";
import { reduceFrame } from "./reducers/frames";
export { normalizeInteraction } from "./reducers/normalize";
export { renderIndexes } from "./reducers/live";
export type { RenderIndexes } from "./reducers/live";

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

export function reduceWebState(state: WebState, rawFrame: ServerFrame): WebState {
  const frame = normalizeFrame(rawFrame);
  const next = reduceWebStateInner(state, frame);
  if (frame.type === "snapshot") {
    const seq = asNumber(frame.seq);
    if (seq !== undefined) return { ...next, transcriptSeq: seq };
  }
  return next;
}

function reduceWebStateInner(state: WebState, frame: ServerFrame): WebState {
  const activeId = state.liveSession.session?.id;
  if (frame.type !== "session.select" && typeof frame.sessionId === "string" && activeId && frame.sessionId !== activeId) return state;
  const pure = reduceFrame(state, frame);
  if (pure !== undefined) return pure;
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
    case "snapshot":
      return reduceSnapshot(state, frame);

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

    default:
      return state;
  }
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

