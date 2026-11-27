import { memo } from "react";
import { ChevronDownIcon, CircleSlashIcon, FileIcon } from "lucide-react";
import { Badge } from "@herd/deer-flow-ui/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@herd/deer-flow-ui/ui/collapsible";
import { ToolStepCard } from "../ToolStepCard";
import { TerminalView } from "../tool/TerminalView";
import type {
  MessageBlock,
  ToolExecution,
  UiMessage,
} from "../../protocol/types";

function textBlocks(message: UiMessage, type: "text" | "thinking"): string {
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
  // One shell card for both the tool path and the bare execution path: the same
  // .tool-card frame, the same ANSI terminal, so a run never looks like a
  // second, poorer cousin of a `bash` tool call.
  return (
    <div className="tool-card" data-kind="bash" data-state={message.isError ? "error" : "ok"}>
      <div className="p-2 pl-3">
        <TerminalView
          output={output}
          command={command}
          language={isPython ? "python" : "bash"}
          exitCode={message.exitCode}
          excludeFromContext={message.excludeFromContext}
          showHeader
        />
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
  attachedToolIds: ReadonlySet<string>;
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

