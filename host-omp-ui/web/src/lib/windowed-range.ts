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

export function sliceWindow<T>(items: readonly T[], range: WindowRange): T[] {
  return items.slice(range.start, range.start + range.count);
}
