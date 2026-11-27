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
  Globe2Icon,
  ListTodoIcon,
  Loader2Icon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import { CodeBlock, CodeBlockCopyButton } from "@herd/deer-flow-ui/ai-elements/code-block";
import { DiffView } from "./tool/DiffView";
import { JsStudioCard } from "./tool/JsStudioCard";
import { TerminalView } from "./tool/TerminalView";
import { externalLinkAttributes } from "../lib/safe-links";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@herd/deer-flow-ui/ui/collapsible";
import type { ToolExecution } from "../protocol/types";
import { describeTool, type ToolView } from "../protocol/tool-view";

function language(value: string): BundledLanguage {
  return value as BundledLanguage;
}

function StatusIcon({ view }: { view: ToolView }) {
  // Colours come from the tool tokens so a card matches the terminal palette
  // in both themes instead of pinning Tailwind's raw hues.
  if (view.status === "running") {
    return <Loader2Icon className="size-4 animate-spin" style={{ color: "var(--tool-run)" }} />;
  }
  if (view.isError) {
    return <XCircleIcon className="size-4" style={{ color: "var(--tool-err)" }} />;
  }
  return <CheckCircle2Icon className="size-4" style={{ color: "var(--tool-ok)" }} />;
}

function KindIcon({ view }: { view: ToolView }) {
  const className = "size-4 shrink-0";
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
    default:
      return <WrenchIcon className={className} />;
  }
}

function Code({ code, lang }: { code: string; lang: string }) {
  if (!code) {
    return <p className="text-muted-foreground px-3 pb-3 text-xs">暂无内容</p>;
  }
  return (
    <CodeBlock code={code} language={language(lang)} className="max-h-96 overflow-auto">
      <CodeBlockCopyButton className="size-7" />
    </CodeBlock>
  );
}

/** `path:line:text` is what grep prints; split it so the line number can be dimmed. */
function MatchLine({ match }: { match: string }) {
  const parts = /^(.*?):(\d+):(.*)$/.exec(match);
  if (!parts) {
    return <span className="break-all">{match}</span>;
  }
  return (
    <span className="break-all">
      <span className="text-muted-foreground">
        {parts[1]}:{parts[2]}
      </span>{" "}
      {parts[3]}
    </span>
  );
}

function ToolBody({ view }: { view: ToolView }) {
  switch (view.kind) {
    case "read":
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="tool-chip">{view.path ?? "read"}</span>
            {view.range && <span className="tool-chip">行 {view.range}</span>}
            <span className="tool-chip">{view.language}</span>
          </div>
          <Code code={view.preview} lang={view.language} />
        </div>
      );
    case "write":
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="tool-chip">{view.path ?? "write"}</span>
            <span className="tool-chip">{view.language}</span>
            {view.lines !== undefined && <span className="tool-chip">{view.lines} 行</span>}
            {view.bytes !== undefined && <span className="tool-chip">{view.bytes} B</span>}
          </div>
          <Code code={view.content} lang={view.language} />
        </div>
      );
    case "edit":
      return <DiffView view={view} />;
    case "bash":
      return (
        <TerminalView
          output={view.rawOutput ?? view.output}
          truncated={view.truncated}
        />
      );
    case "eval":
      return <JsStudioCard view={view} renderInnerBody={(child) => <ToolBody view={child} />} />;
    case "search":
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {view.pattern && <span className="tool-chip">{view.pattern}</span>}
            {view.path && <span className="tool-chip">{view.path}</span>}
            <span className="tool-chip" data-tone={view.matches.length ? "ok" : undefined}>
              {view.matches.length} 条
            </span>
          </div>
          {view.matches.length ? (
            <ul className="divide-border divide-y overflow-hidden rounded-md border">
              {view.matches.map((match, index) => (
                <li
                  key={`${index}-${match}`}
                  className="truncate px-3 py-1 font-mono text-xs"
                  title={match}
                >
                  <MatchLine match={match} />
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
          {view.query && <span className="tool-chip">{view.query}</span>}
          {view.links.length ? (
            <ul className="space-y-1">
              {view.links.map((link) => {
                const attributes = externalLinkAttributes(link);
                return (
                  <li key={link} className="max-w-full truncate text-xs">
                    {attributes ? (
                      <a
                        {...attributes}
                        className="text-primary inline-flex max-w-full items-center gap-1 hover:underline"
                      >
                        <ExternalLinkIcon className="size-3 shrink-0" />
                        <span className="truncate">{link}</span>
                      </a>
                    ) : (
                      <span className="text-muted-foreground inline-flex max-w-full items-center gap-1">
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
    case "ask":
      return <p className="text-muted-foreground text-xs">{view.summary}</p>;
    case "task":
      return (
        <div className="space-y-2">
          <span className="tool-chip">{view.agent}</span>
          {view.prompt && (
            <>
              <p className="tool-label">Prompt</p>
              <pre className="tool-terminal max-h-48 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap">
                {view.prompt}
              </pre>
            </>
          )}
          {view.result && (
            <>
              <p className="tool-label">Result</p>
              <pre className="tool-terminal max-h-80 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap">
                {view.result}
              </pre>
            </>
          )}
        </div>
      );
    default:
      return (
        <div className="grid gap-2 md:grid-cols-2">
          <div>
            <p className="tool-label mb-1">Input</p>
            <pre className="tool-terminal max-h-64 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap break-words">
              {view.argsText || "(none)"}
            </pre>
          </div>
          <div>
            <p className="tool-label mb-1">{view.isError ? "Error" : "Result"}</p>
            <pre className="tool-terminal max-h-64 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap break-words">
              {view.resultText || "(no output yet)"}
            </pre>
          </div>
        </div>
      );
  }
}

export const ToolStepCard = memo(
  function ToolStepCard({ tool }: { tool: ToolExecution }) {
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
        className="tool-card"
        data-kind={view.kind}
        data-state={view.isError ? "error" : view.status === "running" ? "running" : "ok"}
      >
        {view.status === "running" && (
          <div className="h-0.5 w-full overflow-hidden">
            <div
              className="h-full w-1/2 animate-[loading-bar_1.4s_ease-in-out_infinite]"
              style={{ background: "var(--tool-accent)" }}
            />
          </div>
        )}
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="hover:bg-muted/40 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors"
          >
            <span
              className="flex size-7 shrink-0 items-center justify-center rounded-md"
              style={{
                background: "color-mix(in oklab, var(--tool-accent) 14%, transparent)",
                color: "var(--tool-accent)",
              }}
            >
              <KindIcon view={view} />
            </span>
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
            {view.kind !== "bash" && view.path && (
              <span className="text-muted-foreground hidden max-w-56 truncate font-mono text-[11px] sm:inline">
                {view.path}
              </span>
            )}
            {view.kind === "read" && view.range && (
              <span className="tool-chip">行 {view.range}</span>
            )}
            {view.kind === "edit" && (
              <span className="tool-chip">
                +{view.diff.added} / −{view.diff.removed}
              </span>
            )}
            {view.kind === "search" && view.matches.length > 0 && (
              <span className="tool-chip">{view.matches.length} 条</span>
            )}
            {view.kind === "eval" && (view.innerCallCount ?? 0) > 0 && (
              <span className="tool-chip">{view.innerCallCount} 次调用</span>
            )}
            {view.kind === "bash" && view.exitCode !== undefined && (
              <span className="tool-chip" data-tone={view.exitCode === 0 ? "ok" : "err"}>
                exit {view.exitCode}
              </span>
            )}
            {view.durationMs !== undefined && <span className="tool-chip">{view.durationMs} ms</span>}
            <StatusIcon view={view} />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t px-3 py-3" style={{ borderColor: "var(--tool-rule)" }}>
            <ToolBody view={view} />
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
    previous.tool.partialResult === next.tool.partialResult &&
    // `details` carries `innerCalls`; without it a live js frame that grows new
    // inner calls keeps the old card, because every other field is unchanged.
    previous.tool.details === next.tool.details,
);
