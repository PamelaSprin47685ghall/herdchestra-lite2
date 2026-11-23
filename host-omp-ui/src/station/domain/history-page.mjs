// Pure paging decisions. The Station owns the transcript and commits pages;
// this module only answers "which messages does this window contain?".

import { isRealUser } from "./transcript-model.mjs";

const MAX_HISTORY_LIMIT = 200;
const DEFAULT_PAGE_LIMIT = 50;

// A page must not start in the middle of a turn. When the first message is not
// a real user, walk back to the nearest real user and include it. Legacy
// transcripts without attribution have no real-user boundary, so they keep the
// requested window instead of backtracking to the beginning.
const TURN_ALIGN_LIMIT = 400;

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
export function planHistoryPage({ messages, before, limit } = {}) {
  const requested = limit === undefined ? DEFAULT_PAGE_LIMIT : Number(limit);
  const pageLimit = Number.isInteger(requested) && requested > 0
    ? Math.min(requested, MAX_HISTORY_LIMIT)
    : null;
  if (pageLimit === null) return { ok: false, code: "invalid_limit" };

  const cursor = String(before ?? "");
  const index = messages.findIndex((message) => message.id === cursor);
  if (index < 0) return { ok: false, code: "stale_cursor" };

  const rawStart = Math.max(0, index - pageLimit);
  const start = alignToTurnStart(messages, rawStart);
  const page = messages.slice(start, index);
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
