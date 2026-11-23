import type { UiMessage, WebState } from "../types";
import {
  stableModel,
  stableModels,
  stableMeta,
  stableModes,
  stableStringArray,
  stableText,
} from "./stable";

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

export type LiveHistory = {
  hasMore: boolean;
  oldestId?: string | null;
};
export type LiveSessionWithHistory = WebState["liveSession"] & {
  history?: LiveHistory;
};

export function liveCommit(
  state: WebState,
  live: {
    messages?: UiMessage[];
    session?: WebState["liveSession"]["session"];
    history?: LiveHistory;
  },
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
  return {
    ...next,
    messages: liveSession.messages,
    session: liveSession.session,
  };
}
