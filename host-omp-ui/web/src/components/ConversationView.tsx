import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWindowedScroll } from "../hooks/use-windowed-scroll";
import { WindowedScroll } from "./WindowedScroll";
import {
  BrainIcon,
  ChevronDownIcon,
  CircleSlashIcon,
  FileIcon,
  SparklesIcon,
  TerminalIcon,
} from "lucide-react";
import {
  Conversation,
  ConversationEmptyState,
} from "@herd/deer-flow-ui/ai-elements/conversation";
import {
  Message,
  MessageContent,
} from "@herd/deer-flow-ui/ai-elements/message";
import { IncremarkMessage } from "./IncremarkMessage";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
} from "@herd/deer-flow-ui/ai-elements/chain-of-thought";
import { CodeBlock, CodeBlockCopyButton } from "@herd/deer-flow-ui/ai-elements/code-block";
import { Badge } from "@herd/deer-flow-ui/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@herd/deer-flow-ui/ui/collapsible";
import type { BundledLanguage } from "shiki";
import type {
  MessageBlock,
  ToolExecution,
  UiMessage,
  WebState,
} from "../protocol/types";
import {
  isToolBlock,
  mergeToolBlock,
  toolBlockId,
} from "../protocol/tool-view";
import { renderIndexes } from "../protocol/store";
import {
  buildSteps,
  buildTurnGroups,
  isStepGroupActive,
  resolveHistoryCursor,
  type StepEntry,
  type TurnGroup,
} from "../lib/build-steps";
import { ToolStepCard } from "./ToolStepCard";

function textBlocks(message: UiMessage, type: "text" | "thinking"): string {
  return (message.blocks ?? [])
    .filter((block) => block.type === type)
    .map((block) => ("text" in block ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

function hasKind(message: UiMessage, type: MessageBlock["type"]): boolean {
  return (message.blocks ?? []).some((block) => block.type === type);
}

function toolBlocks(message: UiMessage): MessageBlock[] {
  return (message.blocks ?? []).filter(isToolBlock);
}

function imageBlocks(
  message: UiMessage,
): Array<Extract<MessageBlock, { type: "image" }>> {
  return (message.blocks ?? []).filter(
    (block): block is Extract<MessageBlock, { type: "image" }> =>
      block.type === "image",
  );
}

function language(value: string | undefined): BundledLanguage {
  return (value || "text") as BundledLanguage;
}

function ThinkingPanel({
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

function StepMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return <IncremarkMessage streaming={streaming}>{text}</IncremarkMessage>;
}

function ProcessingSteps({
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
              <ToolStepCard
                key={step.key}
                tool={step.tool}
                
              />
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

function UserBlocks({ message }: { message: UiMessage }) {
  const text = textBlocks(message, "text") || message.text || "";
  const images = imageBlocks(message);
  return (
    <>
      {text && <div className="break-words whitespace-pre-wrap">{text}</div>}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((image, index) =>
            image.url ? (
              <img
                key={`${image.url}-${index}`}
                src={image.url}
                alt={image.alt ?? "attachment"}
                className="max-h-64 rounded-md border object-contain"
              />
            ) : null,
          )}
        </div>
      )}
    </>
  );
}

const TerminalRun = memo(function TerminalRun({ message }: { message: UiMessage }) {
  const command = message.command ?? message.code ?? "";
  const output = message.output ?? textBlocks(message, "text");
  const isPython = message.role === "pythonExecution";
  return (
    <div className="bg-card/60 rounded-lg border">
      <div className="text-muted-foreground flex items-center gap-2 border-b px-3 py-2 text-xs">
        <TerminalIcon className="size-3.5" />
        <span className="font-medium">{isPython ? "Python" : "Shell"}</span>
        {message.exitCode !== undefined && (
          <Badge
            variant={message.exitCode === 0 ? "secondary" : "destructive"}
            className="text-[11px]"
          >
            exit {message.exitCode}
          </Badge>
        )}
        {message.excludeFromContext && (
          <Badge variant="outline" className="text-[11px]">
            不进入上下文
          </Badge>
        )}
        <span className="ml-auto font-mono">{isPython ? "python" : "bash"}</span>
      </div>
      <div className="space-y-2 p-3">
        {command && (
          <CodeBlock
            code={command}
            language={language(isPython ? "python" : "bash")}
            className="max-h-40 overflow-auto"
          >
            <CodeBlockCopyButton className="size-7" />
          </CodeBlock>
        )}
        {output && (
          <pre className="bg-background max-h-72 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap break-words">
            {output}
          </pre>
        )}
      </div>
    </div>
  );
});

function BoundarySummary({ message }: { message: UiMessage }) {
  const title =
    message.role === "compactionSummary" ? "上下文已压缩" : "分支摘要";
  const summary = message.summary ?? textBlocks(message, "text");
  return (
    <div className="flex items-center gap-3">
      <span className="bg-border h-px flex-1" />
      <Collapsible className="max-w-[80%]">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs"
          >
            <CircleSlashIcon className="size-3.5" />
            {title}
            <ChevronDownIcon className="size-3" />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="text-muted-foreground bg-muted/40 mt-2 rounded-lg border px-3 py-2 text-sm">
            {summary || "（无摘要）"}
          </div>
        </CollapsibleContent>
      </Collapsible>
      <span className="bg-border h-px flex-1" />
    </div>
  );
}

function NeutralMessage({ message }: { message: UiMessage }) {
  const label =
    message.customType ??
    (message.role === "compactionSummary" ? "compaction" : message.role);
  const body = message.summary || textBlocks(message, "text") || message.text || "";
  return (
    <div className="bg-muted/30 rounded-lg border border-dashed px-3 py-2 text-sm">
      <div className="text-muted-foreground mb-1 flex items-center gap-2 text-xs">
        <FileIcon className="size-3.5" />
        <Badge variant="outline" className="text-[10px]">
          {label}
        </Badge>
      </div>
      <div className="whitespace-pre-wrap">{body}</div>
    </div>
  );
}

function OrphanToolResult({
  message,
  tools,
  attachedToolIds,
  
}: {
  message: UiMessage;
  tools: Record<string, ToolExecution>;
  attachedToolIds: Set<string>;
}) {
  const id = message.toolCallId ?? message.id;
  if (
    message.toolCallId &&
    (tools[message.toolCallId] || attachedToolIds.has(message.toolCallId))
  ) {
    return null;
  }
  const result =
    message.blocks?.map((block) => ("text" in block ? block.text : "")).join("\n") ??
    "";
  return (
    <ToolStepCard
      tool={{
        id,
        name: message.toolName ?? "tool",
        status: message.isError ? "failed" : "completed",
        result,
        isError: Boolean(message.isError),
      }}
      
    />
  );
}

const AssistantMessage = memo(function AssistantMessage({
  message,
  tools,
  
}: {
  message: UiMessage;
  tools: Record<string, ToolExecution>;
}) {
  const { steps, body: text } = buildSteps(message);
  const isStreaming = Boolean(message.streaming);
  const hasSteps = steps.length > 0;
  if (!hasSteps && !text) {
    if (!isStreaming) return null;
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <SparklesIcon className="size-4 animate-pulse" />
        正在生成…
      </div>
    );
  }
  return (
    <div className="flex w-full flex-col gap-3">
      <ProcessingSteps
        segments={[{ id: message.id, steps }]}
        totalSteps={steps.length}
        hasStreamingStep={steps.some((step) => step.streaming)}
        runningTools={
          steps.filter(
            (step) => step.kind === "tool" && step.tool.status === "running",
          ).length
        }
        bodyFinished={!isStreaming}
        tools={tools}
        
      />
      {(text || imageBlocks(message).length > 0) && (
        <Message from="assistant" className="gap-1">
          <MessageContent className="w-full">
            {text && (
              <IncremarkMessage streaming={isStreaming && text !== ""}>{text}</IncremarkMessage>
            )}
            {imageBlocks(message).map((image, index) =>
              image.url ? (
                <img
                  key={`${image.url}-${index}`}
                  src={image.url}
                  alt={image.alt ?? "assistant attachment"}
                  className="max-h-72 rounded-md border object-contain"
                />
              ) : null,
            )}
          </MessageContent>
          {isStreaming && (
            <span className="text-muted-foreground flex items-center gap-1.5 pl-1 text-xs">
              <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
              生成中
            </span>
          )}
        </Message>
      )}
    </div>
  );
});

function ConversationViewInner({
  messages,
  toolExecutions,
  streaming,
  
  onLoadHistory,
  hasMoreHistory = false,
  historyOldestId = null,
}: {
  messages: WebState["messages"];
  toolExecutions: WebState["toolExecutions"];
  streaming: boolean;
  onLoadHistory?: (before: string) => Promise<boolean>;
  hasMoreHistory?: boolean;
  historyOldestId?: string | null;
}) {
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierNotice, setEarlierNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!earlierNotice) return;
    const timer = window.setTimeout(() => setEarlierNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [earlierNotice]);

  const { attachedToolIds } = renderIndexes(messages);
  const groups = useMemo(() => buildTurnGroups(messages), [messages]);
  const groupsRef = useRef(groups);
  if (groups.length > 0) groupsRef.current = groups;
  const displayGroups = groups.length > 0 ? groups : groupsRef.current;
  const lastGroupId = displayGroups[displayGroups.length - 1]?.id;

  const renderGroup = (group: TurnGroup) => {
    if (group.kind === "user") {
      return (
        <Message from="user" className="ml-auto w-fit max-w-[82%] gap-1">
          <MessageContent className="rounded-2xl rounded-br-sm border border-brand/20 bg-brand-soft/75 px-4 py-2.5 text-ink shadow-[0_1px_2px_rgba(27,54,93,0.06)]">
            <UserBlocks message={group.message} />
          </MessageContent>
        </Message>
      );
    }
    if (group.kind === "processing") {
      const waiting =
        group.streaming && group.totalSteps === 0 && group.body === "";
      return (
        <div className="flex w-full flex-col gap-3">
          {group.totalSteps > 0 && (
            <ProcessingSteps
              segments={group.segments}
              totalSteps={group.totalSteps}
              hasStreamingStep={group.hasStreamingStep}
              runningTools={group.runningTools}
              bodyFinished={group.bodyFinished}
              turnStreaming={isStepGroupActive({
                isLastGroup: group.id === lastGroupId,
                sessionStreaming: streaming,
                hasBody: Boolean(group.body.trim()),
                runningStepsOrTools:
                  group.hasStreamingStep || group.runningTools > 0,
              })}
              tools={toolExecutions}
              
            />
          )}
          {waiting ? (
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <SparklesIcon className="size-4 animate-pulse" />
              正在生成…
            </div>
          ) : null}
          {group.body ? (
            <Message from="assistant" className="mr-auto w-fit max-w-[92%] gap-1">
              <MessageContent className="w-full rounded-2xl rounded-bl-sm border border-border bg-card px-5 py-3.5 text-card-foreground shadow-[0_1px_2px_rgba(20,20,19,0.04)]">
                <IncremarkMessage streaming={!group.bodyFinished}>
                  {group.body}
                </IncremarkMessage>
              </MessageContent>
            </Message>
          ) : null}
        </div>
      );
    }
    if (group.kind === "terminal") {
      return <TerminalRun message={group.message} />;
    }
    if (group.kind === "boundary") {
      return <BoundarySummary message={group.message} />;
    }
    return renderOther(group.message);
  };

  const renderOther = (message: UiMessage) => {
    if (message.role === "toolResult") {
      return (
        <OrphanToolResult
          message={message}
          tools={toolExecutions}
          attachedToolIds={attachedToolIds}
          
        />
      );
    }
    if (message.role === "fileMention") {
      const path = message.path?.trim();
      if (!path) return null;
      const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
      return (
        <div
          className="text-muted-foreground flex items-center gap-1.5 text-xs"
          title={path}
        >
          <FileIcon className="size-3.5 shrink-0" />
          <span className="bg-muted max-w-[28rem] truncate rounded px-1.5 py-0.5 font-mono">
            {name}
          </span>
          <span className="shrink-0">文件引用</span>
        </div>
      );
    }
    return <NeutralMessage message={message} />;
  };

  return (
    <WindowedScroll
      items={displayGroups}
      getKey={(group) => group.id}
      renderItem={renderGroup}
      className="min-h-0 flex-1"
      contentClassName={
        messages.length === 0
          ? "mx-auto w-full max-w-[var(--chat-max-w)] px-4"
          : "mx-auto w-full max-w-[var(--chat-max-w)] space-y-5 px-4 pb-12 pt-3"
      }
      running={streaming}
      runningTail={100000}
      page={100000}
      autoFollow
      canLoadEarlier={Boolean(hasMoreHistory)}
      empty={
        messages.length === 0 ? (
          <ConversationEmptyState
            icon={<SparklesIcon className="size-8" />}
            title={streaming ? "omp 正在准备回复" : "会话是空的"}
            description="在下方输入。Enter 发送，Shift+Enter 换行。"
          />
        ) : displayGroups.length === 0 ? (
          <div className="text-muted-foreground flex items-center gap-2 px-1 py-6 text-sm">
            <SparklesIcon className="size-4 animate-pulse" />
            {streaming ? "正在生成…" : "正在准备会话…"}
          </div>
        ) : undefined
      }
      footer={
        earlierNotice ? (
          <div className="text-muted-foreground border-t px-4 py-1.5 text-center text-xs">
            {earlierNotice}
          </div>
        ) : null
      }
      onNeedEarlier={async () => {
        const before = resolveHistoryCursor(historyOldestId, messages);
        if (!before || !onLoadHistory) return false;
        const loaded = await onLoadHistory(before);
        if (loaded) setEarlierNotice("已加载更早消息，继续上滚查看");
        return loaded;
      }}
    />
  );
}

export const ConversationView = memo(
  ConversationViewInner,
  (previous, next) =>
    previous.messages === next.messages &&
    previous.toolExecutions === next.toolExecutions &&
    previous.streaming === next.streaming &&
    previous.onLoadHistory === next.onLoadHistory &&
    previous.hasMoreHistory === next.hasMoreHistory &&
    previous.historyOldestId === next.historyOldestId,
);
