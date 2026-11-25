// Pure paging decisions. The Station owns the transcript and commits pages;
// this module only answers "which messages does this window contain?".

import { isRealUser } from "./transcript-model.mjs";

export const MAX_HISTORY_LIMIT = 200;
const DEFAULT_PAGE_LIMIT = 50;

// A page must not start in the middle of a turn. When the first message is not
// a real user, walk back to the nearest real user and include it. Legacy
// transcripts without attribution have no real-user boundary, so they keep the
// requested window instead of backtracking to the beginning.
//
// Exported because a caller that rebuilds only part of a transcript has to know
// how far back the walk can reach; asking for exactly the page would cut the
// walk short and start the frame inside a turn.
export const TURN_ALIGN_LIMIT = 400;

/**
 * The page size a request asks for, or null when the request is invalid.
 *
 * Paging validates the limit before it looks for the cursor, and a caller that
 * resolves the cursor against its own index has to keep that order: an
 * impossible limit is the answer whether or not the cursor exists, so reporting
 * `stale_cursor` first would tell a caller to refetch a page it never asked for.
 */
export function normalizeHistoryLimit(limit) {
  const requested = limit === undefined ? DEFAULT_PAGE_LIMIT : Number(limit);
  return Number.isInteger(requested) && requested > 0
    ? Math.min(requested, MAX_HISTORY_LIMIT)
    : null;
}

export function alignToTurnStart(messages, start) {
  if (start <= 0) return start;
  if (isRealUser(messages[start])) return start;
  const floor = Math.max(0, start - TURN_ALIGN_LIMIT);
  for (let index = start - 1; index >= floor; index -= 1) {
    if (isRealUser(messages[index])) return index;
  }
  return start;
}

// Returns either { ok: false, code } or the raw page slice plus its cursor
// metadata. The caller maps entries to its own capped view; paging stays pure.
//
// `origin` is the ordinal of `messages[0]` within the whole transcript. A caller
// that holds only a window passes where that window starts, and the answer is
// still expressed in whole-transcript ordinals — so a cursor resolves against
// the same numbers whether the caller kept everything or one page.
export function planHistoryPage({ messages, before, limit, origin = 0 } = {}) {
  const pageLimit = normalizeHistoryLimit(limit);
  if (pageLimit === null) return { ok: false, code: "invalid_limit" };

  const base = Number.isInteger(origin) && origin > 0 ? origin : 0;
  const cursor = String(before ?? "");
  const local = messages.findIndex((message) => message.id === cursor);
  if (local < 0) return { ok: false, code: "stale_cursor" };

  const index = base + local;
  const rawStart = Math.max(0, index - pageLimit);
  const start = base + alignToTurnStart(messages, Math.max(0, rawStart - base));
  const page = messages.slice(start - base, local);
  return {
    ok: true,
    start,
    index,
    messages: page,
    history: {
      hasMore: start > 0,
      oldestId: page[0]?.id ?? null,
    },
  };
}
