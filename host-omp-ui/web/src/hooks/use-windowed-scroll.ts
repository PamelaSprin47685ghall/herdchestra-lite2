import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  finishRestore,
  reachBottom,
  startRestore,
  tailWindow,
  userScrollUp,
  type ScrollIntent,
  type WindowRange,
} from "../lib/windowed-range";

export interface UseWindowedScrollOptions {
  total: number;
  running?: boolean;
  open?: boolean;
  page?: number;
  runningTail?: number;
  autoFollow?: boolean;
  resetOnRun?: boolean;
  showAll?: boolean;
  onNeedEarlier?: () => Promise<boolean> | boolean;
}

export interface WindowedScrollState {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  range: WindowRange;
  atBottom: boolean;
  canScroll: boolean;
  visible: number;
  loading: boolean;
  scrollToEnd: () => void;
  expandEarlier: () => void;
  onScroll: () => void;
  onWheel: (event: React.WheelEvent) => void;
  onTouchMove: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
}

const NEAR_BOTTOM_PX = 120;
const BOTTOM_PX = 4;
const TOP_TRIGGER_PX = 24;

export function useWindowedScroll({
  total,
  running = false,
  open = true,
  page = 30,
  runningTail = 12,
  autoFollow = false,
  resetOnRun = false,
  showAll = false,
  onNeedEarlier,
}: UseWindowedScrollOptions): WindowedScrollState {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(page);
  const [atBottom, setAtBottom] = useState(true);
  const [canScroll, setCanScroll] = useState(false);
  const [loading, setLoading] = useState(false);

  const active = open !== false;
  const intent = useRef<ScrollIntent>("following");
  const restoreIntent = useRef<ScrollIntent>("following");
  const programmatic = useRef(false);
  const pending = useRef<{ height: number; top: number } | null>(null);
  const initialized = useRef(false);
  const wasRunning = useRef(Boolean(running));
  const requestGeneration = useRef(0);
  const mounted = useRef(false);
  const topRequested = useRef(false);

  useEffect(() => {
    topRequested.current = false;
  }, [total]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
    };
  }, []);

  useEffect(() => {
    if (resetOnRun && running && !wasRunning.current) setVisible(page);
    wasRunning.current = Boolean(running);
  }, [resetOnRun, running, page]);

  const range = useMemo(
    () =>
      showAll && active
        ? { start: 0, count: total }
        : tailWindow(total, {
            running: false,
            open: active,
            visible: running ? Math.max(visible, runningTail) : visible,
            runningTail,
          }),
    [total, running, active, visible, runningTail, showAll],
  );

  const pinBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 2) {
      setAtBottom(true);
      return;
    }
    programmatic.current = true;
    el.scrollTop = el.scrollHeight;
    intent.current = reachBottom(intent.current);
    setAtBottom(true);
    requestAnimationFrame(() => {
      programmatic.current = false;
    });
  }, []);

  const scrollToEnd = useCallback(() => {
    intent.current = reachBottom(intent.current);
    pinBottom();
  }, [pinBottom]);

  const expandLocal = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      pending.current = { height: el.scrollHeight, top: el.scrollTop };
      restoreIntent.current = intent.current;
      intent.current = startRestore(intent.current);
    }
    setVisible((value) => value + page);
  }, [page]);

  const triggerTopLoad = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (loading || topRequested.current) return;
    if (range.start > 0) {
      topRequested.current = true;
      expandLocal();
      return;
    }
    if (!onNeedEarlier) {
      topRequested.current = false;
      return;
    }
    topRequested.current = true;
    setLoading(true);
    pending.current = { height: el.scrollHeight, top: el.scrollTop };
    restoreIntent.current = intent.current;
    intent.current = startRestore(intent.current);
    const generation = ++requestGeneration.current;
    Promise.resolve()
      .then(() => onNeedEarlier())
      .then((changed) => {
        if (!mounted.current || generation !== requestGeneration.current) return;
        if (!changed) {
          pending.current = null;
          intent.current = finishRestore(restoreIntent.current);
          topRequested.current = false;
        }
        setLoading(false);
      })
      .catch(() => {
        if (!mounted.current || generation !== requestGeneration.current) return;
        pending.current = null;
        intent.current = finishRestore(restoreIntent.current);
        topRequested.current = false;
        setLoading(false);
      });
  }, [loading, range.start, expandLocal, onNeedEarlier]);

  const onScroll = useCallback(() => {
    if (!active) return;
    const el = scrollRef.current;
    if (!el) return;
    const nextCanScroll = el.scrollHeight > el.clientHeight + 8;
    setCanScroll((value) => (value === nextCanScroll ? value : nextCanScroll));
    if (programmatic.current) return;

    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance <= BOTTOM_PX) intent.current = reachBottom(intent.current);
    const showButton =
      distance > NEAR_BOTTOM_PX && intent.current !== "following";
    setAtBottom((value) => (value === !showButton ? value : !showButton));

    if (el.scrollTop > TOP_TRIGGER_PX) {
      topRequested.current = false;
      return;
    }
    triggerTopLoad();
  }, [active, triggerTopLoad]);

  const scrollToTopAndLoad = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    intent.current = userScrollUp(intent.current);
    setAtBottom(false);
    programmatic.current = true;
    el.scrollTop = 0;
    topRequested.current = false;
    requestAnimationFrame(() => {
      programmatic.current = false;
      triggerTopLoad();
    });
  }, [triggerTopLoad]);

  const expandEarlier = scrollToTopAndLoad;

  const onWheel = useCallback(
    (event: React.WheelEvent) => {
      if (!active) return;
      if (event.deltaY < 0) {
        intent.current = userScrollUp(intent.current);
        return;
      }
      const el = scrollRef.current;
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_PX) {
        intent.current = reachBottom(intent.current);
      }
    },
    [active],
  );

  const onTouchMove = useCallback(() => {
    if (!active) return;
    intent.current = userScrollUp(intent.current);
  }, [active]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!active) return;
      if (
        event.key === "PageUp" ||
        event.key === "ArrowUp" ||
        event.key === "Home"
      ) {
        intent.current = userScrollUp(intent.current);
        return;
      }
      if (event.key === "PageDown" || event.key === "End") {
        intent.current = reachBottom(intent.current);
        pinBottom();
      }
    },
    [active, pinBottom],
  );

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !pending.current) return;
    const { height, top } = pending.current;
    pending.current = null;
    programmatic.current = true;
    el.scrollTop = top + (el.scrollHeight - height);
    intent.current = finishRestore(restoreIntent.current);
    requestAnimationFrame(() => {
      programmatic.current = false;
    });
  }, [total, visible, active]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !active || !autoFollow || pending.current) return;
    if (!initialized.current) {
      initialized.current = true;
      pinBottom();
      return;
    }
    if (intent.current === "following") pinBottom();
  }, [total, visible, active, autoFollow, pinBottom]);

  useEffect(() => {
    if (!active) return;
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      const el = scrollRef.current;
      if (el) {
        const nextCanScroll = el.scrollHeight > el.clientHeight + 8;
        setCanScroll((value) => (value === nextCanScroll ? value : nextCanScroll));
      }
      if (!active || intent.current !== "following") return;
      if (!el) return;
      requestAnimationFrame(() => {
        if (!active || intent.current !== "following") return;
        pinBottom();
      });
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [active, pinBottom]);

  return {
    scrollRef,
    contentRef,
    range,
    atBottom,
    canScroll,
    visible,
    loading,
    scrollToEnd,
    expandEarlier,
    onScroll,
    onWheel,
    onTouchMove,
    onKeyDown,
  };
}
