import type { ReactNode } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useWindowedScroll } from "../hooks/use-windowed-scroll";
import { sliceWindow } from "../lib/windowed-range";

export interface WindowedScrollProps<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
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
  const visibleItems = sliceWindow(items, state.range);
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
          {visibleItems.map((item) => (
            <div key={getKey(item)}>{renderItem(item)}</div>
          ))}
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
