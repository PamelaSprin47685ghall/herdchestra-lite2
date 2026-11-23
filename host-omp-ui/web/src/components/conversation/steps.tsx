import { useCallback, useEffect, useRef, useState } from "react";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
} from "@herd/deer-flow-ui/ai-elements/chain-of-thought";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@herd/deer-flow-ui/ui/collapsible";
import { IncremarkMessage } from "../IncremarkMessage";
import { useWindowedScroll } from "../../hooks/use-windowed-scroll";
import { ToolStepCard } from "../ToolStepCard";
import { mergeToolBlock } from "../../protocol/tool-view";
import type { ToolExecution } from "../../protocol/types";
import type { StepEntry, StepSegment } from "../../lib/build-steps";

export function ThinkingPanel({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(streaming);
  useEffect(() => {
    setOpen(streaming);
  }, [streaming]);
  if (!text.trim()) return null;
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="text-muted-foreground w-full"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="hover:text-foreground flex items-center gap-2 text-sm transition-colors"
        >
          <BrainIcon
            className={streaming ? "size-4 animate-pulse text-violet-400" : "size-4"}
          />
          <span>{streaming ? "思考中…" : "思考过程"}</span>
          <ChevronDownIcon
            className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="text-sm">
          <IncremarkMessage streaming={streaming}>{text}</IncremarkMessage>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function StepMarkdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  return <IncremarkMessage streaming={streaming}>{text}</IncremarkMessage>;
}

export function ProcessingSteps({
  segments,
  totalSteps,
  hasStreamingStep,
  runningTools,
  bodyFinished,
  turnStreaming = false,
  tools,
}: {
  segments: readonly StepSegment[];
  totalSteps: number;
  hasStreamingStep: boolean;
  runningTools: number;
  bodyFinished: boolean;
  turnStreaming?: boolean;
  tools: Record<string, ToolExecution>;
}) {
  const running =
    turnStreaming || hasStreamingStep || runningTools > 0 || !bodyFinished;
  const [open, setOpenState] = useState(running);
  const [everOpened, setEverOpened] = useState(open);
  const userOpen = useRef<boolean | null>(null);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current === running) return;
    wasRunning.current = running;
    // Once the user has explicitly opened or closed this group, that choice is
    // permanent: later running transitions must never override it. Only groups
    // the user has never touched follow the running edge automatically.
    if (userOpen.current !== null) {
      setOpenState(userOpen.current);
      return;
    }
    setOpenState(running);
  }, [running]);
  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);
  const setOpen = useCallback((next: boolean) => {
    userOpen.current = next;
    setOpenState(next);
  }, []);
  const windowed = useWindowedScroll({
    total: totalSteps,
    running,
    open,
    page: 30,
    runningTail: 12,
    autoFollow: true,
  });
  if (!totalSteps) return null;
  const window = windowed.range;
  const visibleSteps = !everOpened ? [] : (() => {
    const out: StepEntry[] = [];
    const end = window.start + window.count;
    let index = 0;
    for (const segment of segments) {
      const next = index + segment.steps.length;
      if (next > window.start && index < end) {
        const from = Math.max(0, window.start - index);
        const to = Math.min(segment.steps.length, end - index);
        for (let i = from; i < to; i += 1) {
          const step = segment.steps[i];
          out.push(
            step.kind === "tool"
              ? { ...step, tool: mergeToolBlock(step.tool, tools[step.tool.id]) }
              : step,
          );
        }
      }
      index = next;
      if (index >= end) break;
    }
    return out;
  })();
  return (
    <ChainOfThought open={open} onOpenChange={setOpen} className="w-full">
      <ChainOfThoughtHeader>
        {running
          ? `正在执行 ${totalSteps} 个步骤…`
          : `已执行 ${totalSteps} 个步骤`}
      </ChainOfThoughtHeader>
      {everOpened && (
        <ChainOfThoughtContent>
          <div
            ref={windowed.scrollRef}
            className={
              open
                ? "max-h-[60vh] space-y-2 overflow-y-auto overscroll-contain pt-2"
                : "hidden"
            }
            onWheelCapture={(event) => {
              event.stopPropagation();
              windowed.onWheel(event);
            }}
            onTouchMoveCapture={(event) => {
              event.stopPropagation();
              windowed.onTouchMove();
            }}
            onKeyDownCapture={(event) => {
              event.stopPropagation();
              windowed.onKeyDown(event);
            }}
            onScroll={windowed.onScroll}
          >
            {open && window.start > 0 && (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground w-full py-1 text-xs"
                onClick={windowed.expandEarlier}
              >
                加载更早的 {Math.min(30, window.start)} 个步骤
              </button>
            )}
            <div
              ref={windowed.contentRef}
              className="space-y-3 border-l-2 border-border/70 pl-3.5"
            >
              {visibleSteps.map((step) =>
                step.kind === "tool" ? (
                  <ToolStepCard key={step.key} tool={step.tool} />
                ) : step.format === "pre" ? (
                  <pre
                    key={step.key}
                    className="bg-muted/40 max-h-72 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap"
                  >
                    {step.text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")}
                  </pre>
                ) : (
                  <div key={step.key} className="text-sm">
                    <StepMarkdown text={step.text} streaming={step.streaming} />
                  </div>
                ),
              )}
            </div>
          </div>
        </ChainOfThoughtContent>
      )}
    </ChainOfThought>
  );
}
