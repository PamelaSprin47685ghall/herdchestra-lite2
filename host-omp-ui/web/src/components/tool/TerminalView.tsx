import { useMemo, useState } from "react";
import { ansiSegments } from "../../protocol/tool-view";

export function TerminalView({ output, command, language = "bash", exitCode, truncated, excludeFromContext, durationMs, showHeader = true }: {
  output: string; command?: string; language?: "bash" | "python"; exitCode?: number;
  truncated?: boolean; excludeFromContext?: boolean; durationMs?: number; showHeader?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const lines = output.split("\n");
  const canExpand = lines.length > 24;
  const visible = expanded || !canExpand ? output : lines.slice(0, 24).join("\n");
  const segments = useMemo(() => ansiSegments(visible), [visible]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(output); setCopied(true); } catch { setCopied(false); }
  };
  return (
    <section className="tool-terminal overflow-hidden">
      {showHeader && <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs" style={{ borderColor: "var(--tool-rule)" }}>
        <span aria-hidden="true" className="flex gap-1 opacity-50"><i className="size-1.5 rounded-full bg-current"/><i className="size-1.5 rounded-full bg-current"/><i className="size-1.5 rounded-full bg-current"/></span>
        <span className="min-w-0 flex-1 truncate font-mono" title={command}>{command ? `${language === "python" ? ">>>" : "$"} ${command}` : language}</span>
        {exitCode !== undefined && <span className="tool-chip" data-tone={exitCode === 0 ? "ok" : "err"}>exit {exitCode}</span>}
        {durationMs !== undefined && <span className="tool-chip">{durationMs} ms</span>}
        {excludeFromContext && <span className="tool-chip">不进入上下文</span>}
        <button type="button" className="text-muted-foreground hover:text-foreground" onClick={copy}>{copied ? "已复制" : "复制"}</button>
      </div>}
      <pre className="max-h-96 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap break-words">{segments.length ? segments.map((segment, i) => <span key={i} style={{ color: segment.color, backgroundColor: segment.backgroundColor, fontWeight: segment.bold ? 600 : undefined, textDecoration: segment.underline ? "underline" : undefined }}>{segment.text}</span>) : <span className="text-muted-foreground">(no output)</span>}</pre>
      {(canExpand || truncated) && <div className="flex items-center justify-between gap-2 border-t px-3 py-1.5 text-xs" style={{ borderColor: "var(--tool-rule)" }}>
        <span className="text-muted-foreground">{truncated ? "输出已由来源截断" : `${lines.length} 行`}</span>
        {canExpand && <button type="button" className="underline underline-offset-2" onClick={() => setExpanded(!expanded)}>{expanded ? "收起" : "展开全部"}</button>}
      </div>}
    </section>
  );
}
