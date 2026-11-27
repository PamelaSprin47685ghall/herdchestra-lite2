// Pure snapshot projection: read the station's committed state and produce the
// wire document. No station, no dispatch, no timers. The caller hands in the
// state plus the two reads it needs, and gets a finished document back.

import { alignToTurnStart, TURN_ALIGN_LIMIT } from "./history-page.mjs";
import { capArtifact, capMessage, capTool, fitSnapshot } from "./snapshot-fit.mjs";

const clonePlainObject = (value) => ({ ...value });

function mapIfArray(value) {
  return Array.isArray(value) ? value.map(clonePlainObject) : value;
}

function copyIfArray(value) {
  return Array.isArray(value) ? [...value] : value;
}

/**
 * Project one snapshot document.
 *
 * `total` is the history length, `range(from, to)` returns the messages in that
 * span, and `interactions` is a freshly built list, never a cached array. The
 * turn-aligned window is rebuilt from the requested size: the alignment walk
 * reaches back at most TURN_ALIGN_LIMIT messages, and a trailing slice here
 * would undo the alignment and can push the current turn's user message out.
 *
 * `fitSnapshot` stays the final pass because it derives displayGroups from the
 * already-trimmed window; grouping here too would group the same window twice.
 */
export function projectSnapshot({ state, total, range, interactions, limit = 80 }) {
  const requested = Number.isInteger(limit) && limit > 0 ? limit : 80;
  const size = Math.min(requested, total);
  const rawStart = Math.max(0, total - size);
  const floor = Math.max(0, rawStart - TURN_ALIGN_LIMIT);
  const window = range(floor, total);
  const start = floor + alignToTurnStart(window, rawStart - floor);
  const messages = window.slice(start - floor).map(capMessage);
  const tools = Object.values(state.toolExecutions).slice(-32).map(capTool);
  const doc = {
    seq: state.seq ?? 0,
    session: { ...state.session },
    messages,
    history: { hasMore: start > 0, oldestId: messages[0]?.id ?? null },
    artifacts: state.artifacts.slice(-16).map(capArtifact),
    todos: mapIfArray(state.todos),
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
      images: copyIfArray(state.draft?.images),
      texts: copyIfArray(state.draft?.texts),
      composer: state.draft?.composer && typeof state.draft.composer === "object"
        ? { ...state.draft.composer }
        : state.draft?.composer,
    },
    completion: {
      ...state.completion,
      items: mapIfArray(state.completion?.items),
    },
    pendingInteractions: interactions,
    widgets: Object.entries(state.widgets).map(([key, lines]) => ({
      key,
      lines: copyIfArray(lines),
    })),
    surface: state.surface ? { ...state.surface } : state.surface,
    toasts: mapIfArray(state.toasts),
    streaming: Boolean(state.meta.busy),
    models: copyIfArray(state.models),
    thinkingLevel: state.meta.thinkingLevel,
    thinkingLevels: state.meta.thinkingLevels,
    modes: state.meta.modes,
    sessions: mapIfArray(state.sessions),
    queue: {
      steering: copyIfArray(state.queue?.steering),
      followUp: copyIfArray(state.queue?.followUp),
    },
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
