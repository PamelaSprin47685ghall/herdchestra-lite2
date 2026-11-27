import type { ReactNode } from "react";
import type { BundledLanguage } from "shiki";
import { CodeBlock, CodeBlockCopyButton } from "@herd/deer-flow-ui/ai-elements/code-block";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@herd/deer-flow-ui/ui/tabs";
import { Code2Icon, FileTextIcon, FileDiffIcon, FilePlus2Icon, Globe2Icon, SearchIcon, TerminalIcon, WrenchIcon } from "lucide-react";
import type { EvalView, ToolView } from "../../protocol/tool-view";
import { TerminalView } from "./TerminalView";

function CallIcon({ view }: { view: ToolView }) {
  const Icon = ({ read: FileTextIcon, write: FilePlus2Icon, edit: FileDiffIcon, bash: TerminalIcon, eval: Code2Icon, search: SearchIcon, web: Globe2Icon } as Record<string, typeof WrenchIcon>)[view.kind] ?? WrenchIcon;
  return <Icon className="size-3.5 shrink-0" />;
}
function summary(view: ToolView): string {
  if (view.path) return view.path;
  if (view.kind === "bash") return view.command;
  if (view.kind === "search") return view.pattern;
  return view.title;
}
export function JsStudioCard({ view, renderInnerBody }: { view: EvalView; renderInnerBody: (view: ToolView) => ReactNode }) {
  const children = view.children ?? [];
  const errors = children.filter(child => child.isError).length;
  const lineCount = view.code ? view.code.split("\n").length : 0;
  const hasInputs = view.inputs != null && (typeof view.inputs !== "object" || Object.keys(view.inputs).length > 0);
  let inputsText = "";
  if (hasInputs) {
    try { inputsText = JSON.stringify(view.inputs, null, 2) ?? String(view.inputs); }
    catch { inputsText = String(view.inputs); }
  }
  return <section className="overflow-hidden rounded-lg border">
    <div className="tool-js-glow flex flex-wrap items-center gap-2 px-3 py-2">
      <span className="tool-chip" data-tone="accent">{view.name === "js" ? "JS" : view.language}</span>
      <span className="tool-chip">{children.length} 次 API 调用</span>
      {errors > 0 && <span className="tool-chip" data-tone="err">{errors} 失败</span>}
      <span className="tool-chip">{lineCount} 行代码</span>
      {view.durationMs !== undefined && <span className="tool-chip">{view.durationMs} ms</span>}
    </div>
    <Tabs key={children.length > 0 ? "calls" : view.output ? "output" : "code"} defaultValue={children.length ? "calls" : view.output ? "output" : "code"}>
      <TabsList className="mx-3 mt-2 w-fit">{children.length > 0 && <TabsTrigger value="calls" className="gap-1 text-xs">Calls <span>{children.length}</span></TabsTrigger>}<TabsTrigger value="output" className="gap-1 text-xs">Output</TabsTrigger>{hasInputs && <TabsTrigger value="inputs" className="gap-1 text-xs">Inputs</TabsTrigger>}<TabsTrigger value="code" className="gap-1 text-xs">Code</TabsTrigger></TabsList>
      {children.length > 0 && <TabsContent value="calls" className="p-3"><ol className="ml-2 space-y-2 border-l border-dashed pl-4">{children.map((child, i) => <li key={`${child.id}-${i}`} className="relative"><span className="absolute -left-[21px] top-3.5 size-2 rounded-full ring-2 ring-background" style={{ background: child.isError ? "var(--tool-err)" : "var(--tool-ok)" }}/><details className="tool-call"><summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs"><CallIcon view={child}/><span className="font-medium">{child.name}</span><span className="text-muted-foreground min-w-0 flex-1 truncate font-mono" title={summary(child)}>{summary(child)}</span><span style={{ color: child.isError ? "var(--tool-err)" : "var(--tool-ok)" }}>{child.isError ? "失败" : "完成"}</span></summary><div className="border-t p-3">{renderInnerBody(child)}</div></details></li>)}</ol></TabsContent>}
      <TabsContent value="output" className="p-3"><TerminalView
          output={view.rawOutput ?? view.output}
          showHeader
        /></TabsContent>
      {hasInputs && <TabsContent value="inputs" className="p-3"><CodeBlock code={inputsText} language={"json" as BundledLanguage} className="max-h-96 overflow-auto"><CodeBlockCopyButton className="size-7" /></CodeBlock></TabsContent>}
      <TabsContent value="code" className="p-3">{view.code ? <CodeBlock code={view.code} language={(view.language || "text") as BundledLanguage} className="max-h-96 overflow-auto"><CodeBlockCopyButton className="size-7" /></CodeBlock> : <p className="text-muted-foreground text-xs">暂无代码</p>}</TabsContent>
    </Tabs>
  </section>;
}
