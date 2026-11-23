type Frame = Record<string, unknown>;

type Scheduler = (callback: () => void) => () => void;

type StreamBatcherOptions = {
  schedule?: Scheduler;
  flush: (frames: Frame[]) => void;
};

const TERMINAL_KINDS: Record<string, true> = {
  message_end: true,
  agent_end: true,
};

function defaultSchedule(callback: () => void): () => void {
  if (typeof globalThis.requestAnimationFrame === "function") {
    const handle = globalThis.requestAnimationFrame(callback);
    return () => globalThis.cancelAnimationFrame?.(handle);
  }
  const timer = setTimeout(callback, 16);
  return () => clearTimeout(timer);
}

function kindOf(frame: Frame): string {
  return typeof frame.kind === "string"
    ? frame.kind
    : frame.type === "transcript.delta"
      ? ""
      : String(frame.type ?? "");
}

function isTextDelta(frame: Frame): boolean {
  const kind = kindOf(frame);
  return kind === "text_delta" || kind === "thinking_delta";
}

function isTerminal(frame: Frame): boolean {
  if (frame.type !== "transcript.delta") return true;
  return TERMINAL_KINDS[kindOf(frame)] === true;
}

function mergeKey(frame: Frame): string {
  const blockIndex = frame.blockIndex ?? frame.index ?? 0;
  return `${kindOf(frame)}|${String(frame.messageId ?? "")}|${String(blockIndex)}`;
}

/**
 * Coalesces consecutive text/thinking deltas for the same message block so a
 * fast token stream costs one state update per animation frame instead of one
 * per token. Terminal frames flush the buffer synchronously to preserve order.
 */
export function createStreamBatcher({ schedule = defaultSchedule, flush }: StreamBatcherOptions) {
  let queue: Frame[] = [];
  let cancel: (() => void) | null = null;

  const drain = () => {
    if (cancel) {
      cancel();
      cancel = null;
    }
    if (queue.length === 0) return;
    const frames = queue;
    queue = [];
    flush(frames);
  };

  const scheduleFlush = () => {
    if (cancel) return;
    cancel = schedule(() => {
      cancel = null;
      drain();
    });
  };

  return {
    push(frame: Frame): void {
      if (!frame || typeof frame !== "object") return;
      if (isTerminal(frame)) {
        queue.push(frame);
        drain();
        return;
      }
      const previous = queue[queue.length - 1];
      if (
        isTextDelta(frame) &&
        previous &&
        isTextDelta(previous) &&
        mergeKey(previous) === mergeKey(frame)
      ) {
        previous.delta = `${String(previous.delta ?? "")}${String(frame.delta ?? "")}`;
        scheduleFlush();
        return;
      }
      queue.push(frame);
      scheduleFlush();
    },
    flushNow(): void {
      drain();
    },
  };
}
