import { useState } from "react";
import type { EditView } from "../../protocol/tool-view";

export function DiffView({ view }: { view: EditView }) {
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const { lines, added, removed } = view.diff;
  let oldLine = 0, newLine = 0;
  const numbered = lines.map((line) => ({ ...line, oldLine: line.kind === "add" ? undefined : ++oldLine, newLine: line.kind === "remove" ? undefined : ++newLine }));
  const limit = showAll ? numbered.length : Math.min(500, numbered.length);
  const rows = [];
  for (let i = 0; i < limit;) {
    if (numbered[i].kind === "same") {
      let end = i;
      while (end < limit && numbered[end].kind === "same") end++;
      if (end - i > 8 && !expanded[i]) {
        for (let j = i; j < i + 3; j++) rows.push(numbered[j]);
        rows.push({ kind: "fold" as const, text: `${end - i - 6} 行未变更上下文`, index: i });
        for (let j = end - 3; j < end; j++) rows.push(numbered[j]);
        i = end; continue;
      }
    }
    rows.push(numbered[i++]);
  }
  const total = added + removed;
  return <section className="space-y-2">
    <div className="flex flex-wrap items-center gap-2"><span className="tool-chip font-mono">{view.path || "diff"}</span><span className="tool-chip" style={{ color: "var(--diff-add-fg)" }}>+{added}</span><span className="tool-chip" style={{ color: "var(--diff-del-fg)" }}>−{removed}</span>{total > 0 && <span className="flex h-1.5 w-20 overflow-hidden rounded-full" aria-label={`新增 ${added} 行，删除 ${removed} 行`}><span style={{ width: `${added / total * 100}%`, background: "var(--diff-add-fg)" }}/><span style={{ width: `${removed / total * 100}%`, background: "var(--diff-del-fg)" }}/></span>}</div>
    <div className="overflow-auto rounded-md border font-mono text-xs">
      {rows.map((line, i) => line.kind === "fold" ? <button type="button" key={`fold-${line.index}`} className="text-muted-foreground block w-full px-3 py-1 text-left hover:underline" onClick={() => setExpanded({ ...expanded, [line.index]: true })}>⋯ {line.text} ⋯</button> : <div key={i} className="flex min-w-max" style={{ color: line.kind === "add" ? "var(--diff-add-fg)" : line.kind === "remove" ? "var(--diff-del-fg)" : undefined, background: line.kind === "add" ? "var(--diff-add-bg)" : line.kind === "remove" ? "var(--diff-del-bg)" : undefined }}><span className="text-muted-foreground w-10 shrink-0 select-none px-1 text-right">{line.oldLine ?? ""}</span><span className="text-muted-foreground w-10 shrink-0 select-none px-1 text-right">{line.newLine ?? ""}</span><span className="w-5 shrink-0 select-none text-center">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}</span><span className="whitespace-pre px-2">{line.text || " "}</span></div>)}
      {!lines.length && <p className="text-muted-foreground p-3">没有可显示的差异。</p>}
    </div>
    {lines.length > 500 && <button type="button" className="text-muted-foreground text-xs underline" onClick={() => setShowAll(!showAll)}>{showAll ? "收起" : `显示全部 ${lines.length} 行`}</button>}
    {view.diff.truncated && <p className="text-muted-foreground text-xs">差异过大，按完整删除和新增显示。</p>}
  </section>;
}
