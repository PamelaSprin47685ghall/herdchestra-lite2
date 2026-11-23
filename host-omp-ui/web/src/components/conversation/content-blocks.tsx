import { memo } from "react";
import {
  CircleSlashIcon,
  FileIcon,
  SparklesIcon,
  TerminalIcon,
} from "lucide-react";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@herd/deer-flow-ui/ai-elements/code-block";
import { Badge } from "@herd/deer-flow-ui/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@herd/deer-flow-ui/ui/collapsible";
import { Message, MessageContent } from "@herd/deer-flow-ui/ai-elements/message";
import type { BundledLanguage } from "shiki";
import { IncremarkMessage } from "../IncremarkMessage";
import { ToolStepCard } from "../ToolStepCard";
import type {
  MessageBlock,
  ToolExecution,
  UiMessage,
} from "../../protocol/types";
import { buildSteps } from "../../lib/build-steps";
import { ProcessingSteps } from "./steps";

export function textBlocks(message: UiMessage, type: "text" | "thinking"): string {
  return (message.blocks ?? [])
    .filter((block) => block.type === type)
    .map((block) => ("text" in block ? block.text : ""))
    .filter(Boolean)
    .join("\n");
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

export function UserBlocks({ message }: { message: UiMessage }) {
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

export const TerminalRun = memo(function TerminalRun({
  message,
}: {
  message: UiMessage;
}) {
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

export function BoundarySummary({ message }: { message: UiMessage }) {
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

export function NeutralMessage({ message }: { message: UiMessage }) {
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

export function OrphanToolResult({
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

export const AssistantMessage = memo(function AssistantMessage({
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
              <IncremarkMessage streaming={isStreaming && text !== ""}>
                {text}
              </IncremarkMessage>
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
