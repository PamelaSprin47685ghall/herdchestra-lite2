import type { LiveHistory, UiMessage, WebState } from "../types";
import { MessageLog } from "../message-log";
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
  /**
   * Message id to array position. A stream frame needs the position of one
   * message; without this it searched the array for it on every tick, so the
   * cost of a delta grew with the session's history.
   */
  positions: ReadonlyMap<string, number>;
  /**
   * Array positions of every message that claims to be streaming. A frame that
   * moves the stream must clear the others, and "the last streaming message is
   * the target" does not imply "no other message is streaming".
   *
   * Positions, not ids: `normalizeMessages` does not deduplicate, so two
   * messages can carry the same id. An id-keyed set would then count them as
   * one, skip the clear, and leave a message stuck on "generating" where the
   * old unconditional pass cleared it.
   */
  streamingAt: ReadonlySet<number>;
  /**
   * Ids that more than one message carries. `normalizeMessages` does not
   * deduplicate, so this can happen, and the two paths disagree about what it
   * means: the whole-history path marks every message with the target's id as
   * streaming, while the positional path can only reach one position. A frame
   * that would have to choose is sent down the whole-history path, where the
   * answer is the one this predicate reports.
   */
  duplicateIds: ReadonlySet<string>;
}

const renderIndexCache = new WeakMap<object, RenderIndexes>();

/**
 * Derived indexes for ConversationView. Cached by the identity of whatever
 * sequence is passed — an array from the legacy paths, a `MessageLog` from the
 * streaming path — so the renderer reads them in O(1) instead of rescanning
 * every message on every frame.
 */
export function renderIndexes(
  messages: MessageLog | readonly UiMessage[],
): RenderIndexes {
  const cached = renderIndexCache.get(messages);
  if (cached) return cached;
  return computeRenderIndexes(messages);
}

function computeRenderIndexes(
  messages: MessageLog | readonly UiMessage[],
): RenderIndexes {
  const attachedToolIds = new Set<string>();
  const positions = new Map<string, number>();
  const streamingAt = new Set<number>();
  const duplicateIds = new Set<string>();
  let activeStreamingId: string | null = null;
  const read =
    messages instanceof MessageLog
      ? (index: number) => messages.at(index)
      : (index: number) => messages[index];
  for (let index = 0; index < messages.length; index += 1) {
    const message = read(index);
    if (message === undefined) continue;
    if (message.streaming) {
      activeStreamingId = message.id;
      streamingAt.add(index);
    }
    // First occurrence wins, matching `findIndex` on the same sequence.
    if (!positions.has(message.id)) positions.set(message.id, index);
    else duplicateIds.add(message.id);
    for (const block of message.blocks ?? []) {
      if (block.type === "toolCall") attachedToolIds.add(block.id);
      else if (block.type === "tool") attachedToolIds.add(block.toolCallId);
    }
  }
  const indexes = { attachedToolIds, activeStreamingId, positions, streamingAt, duplicateIds };
  renderIndexCache.set(messages, indexes);
  return indexes;
}

export type { LiveHistory };
export type LiveSessionWithHistory = WebState["liveSession"] & {
  history?: LiveHistory;
};

export function liveCommit(
  state: WebState,
  live: {
    messages?: MessageLog;
    session?: WebState["liveSession"]["session"];
    history?: LiveHistory;
    /** Indexes already valid for `messages`. Omit to scan. */
    indexes?: RenderIndexes;
    /**
     * New value for `streamRev`. A frame that mutates the message array in
     * place must pass it, since the array identity alone no longer reports
     * that anything changed.
     */
    streamRev?: number;
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
  if (live.messages) {
    // A caller that knows the change left the tool ids and the streaming
    // message intact passes the indexes it holds; only an unknown shape pays
    // for the full scan.
    renderIndexCache.set(
      liveSession.messages,
      live.indexes ?? computeRenderIndexes(liveSession.messages),
    );
  }
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
  // A transition that replaces the message sequence consumes a version, even
  // when the caller does not say so. Without this, a snapshot or a prepended
  // history page would leave `streamRev` untouched, and the next stream frame
  // would then arrive at exactly `cached + 1` — indistinguishable from one step
  // over the same list. A consumer would reuse a grouping built from messages
  // that transition had already replaced. The counter only proves immediacy if
  // every change to the sequence advances it, so the rule lives here, where all
  // callers pass through, rather than in each caller.
  const sequenceReplaced =
    live.messages !== undefined && live.messages !== state.liveSession.messages;
  const nextRev = sequenceReplaced
    ? (live.streamRev ?? (state.streamRev ?? 0) + 1)
    : (live.streamRev ?? state.streamRev ?? 0);
  const next: WebState = {
    ...state,
    ...safePatch,
    liveSession,
    streamRev: nextRev,
    // A transition that does not say which index it touched is treated as
    // having touched all of them. Inheriting the previous frame's index would
    // describe a step from a version this state may not derive from, and a
    // consumer would reuse a prefix that no longer matches the list.
    streamDirtyFrom: (safePatch.streamDirtyFrom as number | undefined) ?? 0,
  };
  return {
    ...next,
    messages: liveSession.messages,
    session: liveSession.session,
  };
}

/**
 * A read-only map that answers from a small overlay first.
 *
 * A boundary frame changes one position and maybe adds a tool id or an appended
 * message id. Rebuilding the whole index answered the same question at the
 * cost of the session; layering the frame's few entries over the index it
 * derived from keeps the answer exact and the work bounded by the frame.
 */
class MapOverlay<K, V> implements ReadonlyMap<K, V> {
  constructor(
    private readonly base: ReadonlyMap<K, V>,
    private readonly added: ReadonlyMap<K, V>,
  ) {}

  get size(): number {
    let extra = 0;
    for (const key of this.added.keys()) if (!this.base.has(key)) extra += 1;
    return this.base.size + extra;
  }

  get(key: K): V | undefined {
    return this.added.has(key) ? this.added.get(key) : this.base.get(key);
  }

  has(key: K): boolean {
    return this.added.has(key) || this.base.has(key);
  }

  *entries(): IterableIterator<[K, V]> {
    for (const entry of this.base) if (!this.added.has(entry[0])) yield entry;
    yield* this.added.entries();
  }

  *keys(): IterableIterator<K> {
    for (const [key] of this.entries()) yield key;
  }

  *values(): IterableIterator<V> {
    for (const [, value] of this.entries()) yield value;
  }

  forEach(
    visit: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.entries()) visit.call(thisArg, value, key, this);
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries();
  }

  readonly [Symbol.toStringTag] = "Map";
}

/** A read-only set that answers from a small overlay first. See `MapOverlay`. */
class SetOverlay<T> implements ReadonlySet<T> {
  constructor(
    private readonly base: ReadonlySet<T>,
    private readonly added: ReadonlySet<T>,
  ) {}

  get size(): number {
    let extra = 0;
    for (const value of this.added) if (!this.base.has(value)) extra += 1;
    return this.base.size + extra;
  }

  has(value: T): boolean {
    return this.added.has(value) || this.base.has(value);
  }

  *values(): IterableIterator<T> {
    for (const value of this.base) if (!this.added.has(value)) yield value;
    yield* this.added;
  }

  *keys(): IterableIterator<T> {
    yield* this.values();
  }

  *entries(): IterableIterator<[T, T]> {
    for (const value of this.values()) yield [value, value];
  }

  forEach(
    visit: (value: T, valueAgain: T, set: ReadonlySet<T>) => void,
    thisArg?: unknown,
  ): void {
    for (const value of this.values()) visit.call(thisArg, value, value, this);
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.values();
  }

  readonly [Symbol.toStringTag] = "Set";
}

/** The change one frame made, in the currency `RenderIndexes` is priced in. */
export interface IndexDerivation {
  /** Positions this frame added or remapped. An id keeps its first position. */
  positions?: ReadonlyMap<string, number>;
  /** Tool ids this frame attached to a message. */
  toolIds?: Iterable<string>;
  /** Every position streaming after the frame. */
  streamingAt?: ReadonlySet<number>;
  /** Ids that became duplicated, because an appended message reused one. */
  duplicateIds?: Iterable<string>;
}

/**
 * The indexes for a frame that replaced a few messages.
 *
 * `computeRenderIndexes` scans every message, which is the right price for a
 * sequence nobody has described yet and the wrong one for a frame that touched
 * one position. This layers the frame's own entries over the indexes of the
 * sequence it derived from: the result answers exactly what a full scan would,
 * and costs the frame rather than the session.
 */
export function deriveIndexes(
  base: RenderIndexes,
  change: IndexDerivation,
  sequence: MessageLog | readonly UiMessage[],
): RenderIndexes {
  const streamingAt = change.streamingAt ?? base.streamingAt;
  const toolIds = change.toolIds ? Array.from(change.toolIds) : [];
  const duplicateIds = change.duplicateIds ? Array.from(change.duplicateIds) : [];
  // The last streaming position, matching the scan `computeRenderIndexes`
  // performs — it overwrites the id for every streaming message it meets.
  let lastStreaming = -1;
  for (const index of streamingAt) if (index > lastStreaming) lastStreaming = index;
  const active =
    lastStreaming < 0
      ? null
      : (sequence instanceof MessageLog
          ? sequence.at(lastStreaming)
          : sequence[lastStreaming]
        )?.id ?? null;
  return {
    attachedToolIds:
      toolIds.length > 0
        ? new SetOverlay(base.attachedToolIds, new Set(toolIds))
        : base.attachedToolIds,
    activeStreamingId: active,
    positions:
      change.positions && change.positions.size > 0
        ? new MapOverlay(base.positions, change.positions)
        : base.positions,
    streamingAt,
    duplicateIds:
      duplicateIds.length > 0
        ? new SetOverlay(base.duplicateIds, new Set(duplicateIds))
        : base.duplicateIds,
  };
}
