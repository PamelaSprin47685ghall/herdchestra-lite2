import { memo, useEffect, useRef, useState } from "react";
import type { BundledLanguage } from "shiki";
import {
  CheckCircle2Icon,
  CircleDotIcon,
  Code2Icon,
  ExternalLinkIcon,
  FileDiffIcon,
  FilePlus2Icon,
  FileTextIcon,
  FolderOpenIcon,
  Globe2Icon,
  ListTodoIcon,
  Loader2Icon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import { CodeBlock, CodeBlockCopyButton } from "@herd/deer-flow-ui/ai-elements/code-block";
import { Task, TaskContent, TaskTrigger } from "@herd/deer-flow-ui/ai-elements/task";
import { Badge } from "@herd/deer-flow-ui/ui/badge";
import { externalLinkAttributes } from "../lib/safe-links";
import { Button } from "@herd/deer-flow-ui/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@herd/deer-flow-ui/ui/collapsible";
import type { ToolExecution } from "../protocol/types";
import {
  describeTool,
  type ToolView,
} from "../protocol/tool-view";

const MAX_DIFF_ROWS = 400;

function language(value: string): BundledLanguage {
  return value as BundledLanguage;
}

function StatusIcon({ view }: { view: ToolView }) {
  if (view.status === "running") {
    return <Loader2Icon className="size-4 animate-spin text-sky-400" />;
  }
  if (view.isError) {
    return <XCircleIcon className="text-destructive size-4" />;
  }
  return <CheckCircle2Icon className="size-4 text-emerald-500" />;
}

function KindIcon({ view }: { view: ToolView }) {
  const className = "text-muted-foreground size-4 shrink-0";
  switch (view.kind) {
    case "read":
      return <FileTextIcon className={className} />;
    case "write":
      return <FilePlus2Icon className={className} />;
    case "edit":
      return <FileDiffIcon className={className} />;
    case "bash":
      return <TerminalIcon className={className} />;
    case "eval":
      return <Code2Icon className={className} />;
    case "search":
      return <SearchIcon className={className} />;
    case "web":
      return <Globe2Icon className={className} />;
    case "todo":
      return <ListTodoIcon className={className} />;
    case "task":
      return <CircleDotIcon className={className} />;
    case "ask":
      return <WrenchIcon className={className} />;
    default:
      return <WrenchIcon className={className} />;
  }
}

function Code({ code, lang }: { code: string; lang: string }) {
  if (!code) {
    return (
      <p className="text-muted-foreground px-3 pb-3 text-xs">暂无内容</p>
    );
  }
  return (
    <CodeBlock
      code={code}
      language={language(lang)}
      className="max-h-96 overflow-auto"
    >
      <CodeBlockCopyButton className="size-7" />
    </CodeBlock>
  );
}

function Diff({ view }: { view: Extract<ToolView, { kind: "edit" }> }) {
  const rows = view.diff.lines.slice(0, MAX_DIFF_ROWS);
  return (
    <div className="bg-muted/30 overflow-auto rounded-md border font-mono text-xs">
      {rows.map((line, index) => (
        <div
          key={`${index}-${line.kind}`}
          className={
            line.kind === "add"
              ? "bg-emerald-500/10 text-[#007753] dark:text-[#00885f]"
              : line.kind === "remove"
                ? "bg-rose-500/10 text-[#130005] dark:text-[#ec0040]"
                : "text-muted-foreground"
          }
        >
          <span className="text-muted-foreground/60 inline-block w-10 select-none border-r px-1 text-right">
            {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : ""}
          </span>
          <span className="inline-block whitespace-pre-wrap px-2">
            {line.text || " "}
          </span>
        </div>
      ))}
      {view.diff.lines.length > MAX_DIFF_ROWS && (
        <div className="text-muted-foreground px-3 py-2">
          仅显示前 {MAX_DIFF_ROWS} 行；完整内容见工件抽屉。
        </div>
      )}
      {view.diff.lines.length === 0 && (
        <div className="text-muted-foreground px-3 py-2">没有可显示的差异。</div>
      )}
    </div>
  );
}

function ToolBody({ view }: { view: ToolView }) {
  switch (view.kind) {
    case "read":
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="font-mono text-[11px]">
              {view.path ?? "read"}
            </Badge>
            <Badge variant="secondary" className="text-[11px]">
              {view.language}
            </Badge>

          </div>
          <Code code={view.preview} lang={view.language} />
        </div>
      );
    case "write":
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="font-mono text-[11px]">
              {view.path ?? "write"}
            </Badge>

          </div>
          <Code code={view.content} lang={view.language} />
        </div>
      );
    case "edit":
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="font-mono text-[11px]">
              {view.path ?? "edit"}
            </Badge>
            <Badge className="bg-emerald-500/15 text-[11px] text-[#007753] dark:text-[#00885f]">
              +{view.diff.added}
            </Badge>
            <Badge className="bg-rose-500/15 text-[11px] text-[#130005] dark:text-[#ec0040]">
              −{view.diff.removed}
            </Badge>

          </div>
          <Diff view={view} />
        </div>
      );
    case "bash":
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            {view.exitCode !== undefined && (
              <Badge
                variant={view.exitCode === 0 ? "secondary" : "destructive"}
                className="text-[11px]"
              >
                exit {view.exitCode}
              </Badge>
            )}
            {view.truncated && (
              <Badge variant="outline" className="text-[11px]">
                输出已截断
              </Badge>
            )}
          </div>
          {view.output && (
            <pre className="max-h-80 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap">
              {view.output}
            </pre>
          )}
        </div>
      );
    case "eval":
      return (
        <div className="space-y-2">
          <Badge variant="outline" className="text-[11px]">
            {view.language}
          </Badge>
          <Code code={view.code} lang={view.language} />
          {view.output && (
            <pre className="bg-background max-h-80 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap">
              {view.output}
            </pre>
          )}
        </div>
      );
    case "search":
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {view.pattern && (
              <Badge variant="secondary" className="font-mono text-[11px]">
                {view.pattern}
              </Badge>
            )}
            {view.path && (
              <Badge variant="outline" className="font-mono text-[11px]">
                {view.path}
              </Badge>
            )}
          </div>
          {view.matches.length ? (
            <ul className="divide-border divide-y rounded-md border">
              {view.matches.map((match, index) => (
                <li
                  key={`${index}-${match}`}
                  className="truncate px-3 py-1 font-mono text-xs"
                  title={match}
                >
                  {match}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-xs">没有命中结果。</p>
          )}
        </div>
      );
    case "web":
      return (
        <div className="space-y-2">
          {view.query && (
            <Badge variant="secondary" className="text-[11px]">
              {view.query}
            </Badge>
          )}
          {view.links.length ? (
            <ul className="space-y-1">
              {view.links.map((link) => {
                const attributes = externalLinkAttributes(link);
                return (
                  <li key={link}>
                    {attributes ? (
                      <a
                        {...attributes}
                        className="text-primary inline-flex max-w-full items-center gap-1 text-xs hover:underline"
                      >
                        <ExternalLinkIcon className="size-3 shrink-0" />
                        <span className="truncate">{link}</span>
                      </a>
                    ) : (
                      <span className="text-muted-foreground inline-flex max-w-full items-center gap-1 text-xs">
                        <ExternalLinkIcon className="size-3 shrink-0" />
                        <span className="truncate">{link}</span>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-muted-foreground text-xs">没有可显示的外链。</p>
          )}
        </div>
      );
    case "todo":
      return <p className="text-muted-foreground text-xs">{view.summary}</p>;
    case "task":
      return (
        <Task defaultOpen className="px-3 pb-3">
          <TaskTrigger title={view.title} />
          <TaskContent>
            <div className="space-y-2">
              <p className="text-muted-foreground text-xs">agent: {view.agent}</p>
              {view.prompt && (
                <pre className="bg-muted/40 max-h-48 overflow-auto rounded-md border p-2 font-mono text-xs whitespace-pre-wrap">
                  {view.prompt}
                </pre>
              )}
              {view.result && (
                <pre className="bg-background max-h-80 overflow-auto rounded-md border p-2 font-mono text-xs whitespace-pre-wrap">
                  {view.result}
                </pre>
              )}
            </div>
          </TaskContent>
        </Task>
      );
    case "ask":
      return <p className="text-muted-foreground text-xs">{view.summary}</p>;
    default:
      return (
        <div className="grid gap-2 md:grid-cols-2">
          <div>
            <p className="text-muted-foreground mb-1 text-[11px] font-medium uppercase">
              Input
            </p>
            <pre className="bg-muted/40 max-h-64 overflow-auto rounded-md border p-2 font-mono text-xs whitespace-pre-wrap">
              {view.argsText || "(none)"}
            </pre>
          </div>
          <div>
            <p className="text-muted-foreground mb-1 text-[11px] font-medium uppercase">
              {view.isError ? "Error" : "Result"}
            </p>
            <pre className="bg-background max-h-64 overflow-auto rounded-md border p-2 font-mono text-xs whitespace-pre-wrap">
              {view.resultText || "(no output yet)"}
            </pre>
          </div>
        </div>
      );
  }
}

export const ToolStepCard = memo(function ToolStepCard({
  tool,
}: {
  tool: ToolExecution;
}) {
  const view = describeTool(tool);
  const [open, setOpen] = useState(
    view.status === "running" || view.isError || view.kind === "edit",
  );
  const wasRunning = useRef(view.status === "running");
  useEffect(() => {
    const running = view.status === "running";
    if (wasRunning.current && !running) {
      setOpen(view.isError || view.kind === "edit");
    }
    wasRunning.current = running;
  }, [view.status, view.isError, view.kind]);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={
        view.isError
          ? "border-destructive/40 bg-destructive/5 rounded-lg border"
          : "bg-card/60 rounded-lg border"
      }
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="hover:bg-muted/40 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors"
        >
          <KindIcon view={view} />
          {view.kind === "bash" ? (
            <span className="min-w-0 flex-1 font-medium whitespace-pre-wrap break-words">
              {view.command || view.title}
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate font-medium">{view.title}</span>
          )}
          {view.kind === "bash" && view.title !== view.command.split("\n")[0] && (
            <span className="text-muted-foreground hidden max-w-56 truncate text-[11px] sm:inline">
              {view.title}
            </span>
          )}
          {view.path && (
            <span className="text-muted-foreground hidden max-w-56 truncate font-mono text-[11px] sm:inline">
              {view.path}
            </span>
          )}
          <StatusIcon view={view} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t px-3 py-3">
          <ToolBody view={view}  />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
},
(previous, next) =>
  previous.tool.id === next.tool.id &&
  previous.tool.name === next.tool.name &&
  previous.tool.status === next.tool.status &&
  previous.tool.isError === next.tool.isError &&
  previous.tool.args === next.tool.args &&
  previous.tool.argsText === next.tool.argsText &&
  previous.tool.result === next.tool.result &&
  previous.tool.partialResult === next.tool.partialResult,
);
