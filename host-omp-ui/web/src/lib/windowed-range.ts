export interface WindowRange {
  start: number;
  count: number;
}

export type ScrollIntent = "following" | "paused" | "restoring";

export function userScrollUp(_intent: ScrollIntent): ScrollIntent {
  return "paused";
}

export function reachBottom(_intent: ScrollIntent): ScrollIntent {
  return "following";
}

export function startRestore(_intent: ScrollIntent): ScrollIntent {
  return "restoring";
}

export function finishRestore(previous: ScrollIntent): ScrollIntent {
  return previous === "restoring" ? "following" : previous;
}

export function intentFromPosition(
  intent: ScrollIntent,
  distance: number,
  bottomPx = 4,
  nearBottomPx = 120,
): ScrollIntent {
  if (intent === "restoring") return intent;
  if (distance <= bottomPx) return "following";
  if (distance > nearBottomPx) return "paused";
  return intent;
}

export function restoreIntentForLoad(intent: ScrollIntent): ScrollIntent {
  return intent === "following" ? "paused" : intent;
}

export interface TailWindowOptions {
  running?: boolean;
  open?: boolean;
  visible?: number;
  runningTail?: number;
}

export function tailWindow(
  total: number,
  options: TailWindowOptions = {},
): WindowRange {
  const safeTotal = Math.max(0, Math.floor(total));
  const { running = false, open = true, visible = 30, runningTail = 12 } = options;
  if (!open || safeTotal === 0) return { start: safeTotal, count: 0 };
  const requested = running ? runningTail : visible;
  const count = Math.max(0, Math.min(safeTotal, Math.floor(requested)));
  return { start: safeTotal - count, count };
}

export function prependWindow(
  total: number,
  visible: number,
  page = 30,
): WindowRange {
  const safeTotal = Math.max(0, Math.floor(total));
  const count = Math.max(
    0,
    Math.min(safeTotal, Math.floor(visible) + Math.max(0, Math.floor(page))),
  );
  return { start: safeTotal - count, count };
}

/**
 * Anything the scroll list can render: a real array, or the persistent group
 * sequence. Both answer `length`, `slice` and positional reads, which is the
 * whole of what this module asks for; requiring an array would force the
 * grouping to copy its settled prefix on every frame.
 */
export type WindowItems<T> =
  | readonly T[]
  | { readonly length: number; slice(from?: number, to?: number): T[] };

export function sliceWindow<T>(items: WindowItems<T>, range: WindowRange): T[] {
  return items.slice(range.start, range.start + range.count);
}
