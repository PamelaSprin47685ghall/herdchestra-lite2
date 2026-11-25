import { useMemo } from "react";
import type { ReactNode } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useWindowedScroll } from "../hooks/use-windowed-scroll";
import { sliceWindow } from "../lib/windowed-range";
import type { WindowItems } from "../lib/windowed-range";

interface WindowedScrollProps<T> {
  items: WindowItems<T>;
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  /** Immutable leading items, shared by successive versions of items. */
  stablePrefix?: WindowItems<T>;
  className?: string;
  contentClassName?: string;
  header?: ReactNode;
  footer?: ReactNode;
  empty?: ReactNode;
  open?: boolean;
  running?: boolean;
  page?: number;
  runningTail?: number;
  autoFollow?: boolean;
  nested?: boolean;
  showAll?: boolean;
  onNeedEarlier?: () => Promise<boolean> | boolean;
  canLoadEarlier?: boolean;
}

export function WindowedScroll<T>({
  items,
  getKey,
  renderItem,
  stablePrefix,
  className = "",
  contentClassName = "",
  header,
  footer,
  empty,
  open = true,
  running = false,
  page = 30,
  runningTail = 12,
  autoFollow = false,
  nested = false,
  showAll = false,
  onNeedEarlier,
  canLoadEarlier = false,
}: WindowedScrollProps<T>) {
  const state = useWindowedScroll({
    total: items.length,
    running,
    open,
    page,
    runningTail,
    autoFollow,
    showAll,
    onNeedEarlier,
  });
  const start = state.range.start;
  const end = start + state.range.count;
  const prefixEnd = Math.min(end, stablePrefix?.length ?? 0);
  // The caller promises `stablePrefix` is an immutable prefix of `items`. Its
  // elements are memoised on that promise, so a tail-only update does not
  // rebuild them — but they stay in the same child list, under the same
  // parents and keys, so React reuses the mounted rows. Rendering them from a
  // nested component instead would move them to a new parent and remount every
  // expanded tool card, selection and scroll anchor on each seal.
  const prefixRows = useMemo(
    () =>
      stablePrefix && start < prefixEnd
        ? stablePrefix.slice(start, prefixEnd).map((item) => (
            <div key={getKey(item)}>{renderItem(item)}</div>
          ))
        : [],
    [stablePrefix, start, prefixEnd, getKey, renderItem],
  );
  const tailItems = sliceWindow(items, {
    start: Math.max(start, prefixEnd),
    count: end - Math.max(start, prefixEnd),
  });
  const showJump = !state.atBottom && items.length > 0;
  const showLoad = Boolean(canLoadEarlier) && (showJump || !state.canScroll);
  const pillClass =
    "bg-background/95 text-foreground border-border hover:bg-accent inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium shadow-sm backdrop-blur transition-colors disabled:opacity-60";

  return (
    <div className={`relative flex min-h-0 flex-col ${className}`}>
      {header}
      <div
        ref={state.scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        tabIndex={0}
        onScroll={state.onScroll}
        onWheelCapture={(event) => {
          if (nested) event.stopPropagation();
          state.onWheel(event);
        }}
        onTouchMoveCapture={(event) => {
          if (nested) event.stopPropagation();
          state.onTouchMove();
        }}
        onKeyDownCapture={state.onKeyDown}
      >
        <div
          ref={state.contentRef}
          className={
            items.length === 0 && empty
              ? `${contentClassName} flex min-h-full flex-col`
              : contentClassName
          }
        >
          {[
            ...prefixRows,
            ...tailItems.map((item) => (
              <div key={getKey(item)}>{renderItem(item)}</div>
            )),
          ]}
          {items.length === 0 && empty ? (
            <div className="flex flex-1 items-center justify-center">{empty}</div>
          ) : null}
        </div>
      </div>
      {showJump || showLoad ? (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2">
          {showLoad ? (
            <button
              type="button"
              onClick={state.expandEarlier}
              disabled={state.loading}
              className={`pointer-events-auto ${pillClass}`}
              aria-label="加载更早历史"
              aria-busy={state.loading}
            >
              <ChevronUpIcon className="size-3.5" />
              {state.loading ? "正在加载…" : "加载更早历史"}
            </button>
          ) : null}
          {showJump ? (
            <button
              type="button"
              onClick={state.scrollToEnd}
              className={`pointer-events-auto ${pillClass}`}
              aria-label="回到底部"
            >
              <ChevronDownIcon className="size-3.5" />
              回到底部
            </button>
          ) : null}
        </div>
      ) : null}
      {footer}
    </div>
  );
}
