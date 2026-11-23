import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { BundledLanguage } from "shiki";
import { ChevronRightIcon } from "lucide-react";
import { CodeBlock } from "@herd/deer-flow-ui/ai-elements/code-block";
import { MessageResponse } from "@herd/deer-flow-ui/ai-elements/message";
import { Badge } from "@herd/deer-flow-ui/ui/badge";
import { Button } from "@herd/deer-flow-ui/ui/button";
import { Input } from "@herd/deer-flow-ui/ui/input";
import { Textarea } from "@herd/deer-flow-ui/ui/textarea";
import { externalLinkAttributes } from "../../lib/safe-links";
import { isRecord } from "../../protocol/guards";
import { ansiSegments } from "../../protocol/tool-view";
import type { SurfaceNode } from "../../protocol/types";

export type SurfaceAction = (payload: Record<string, unknown>) => void;

function propText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (isRecord(entry)) return propText(entry.t ?? entry.text ?? entry.label);
        return "";
      })
      .join("");
  }
  if (isRecord(value)) return propText(value.t ?? value.text ?? value.label);
  return "";
}

function Spans({ value }: { value: unknown }) {
  if (!Array.isArray(value)) {
    return <>{propText(value)}</>;
  }
  return (
    <>
      {value.map((entry, index) => {
        if (typeof entry === "string") return <span key={index}>{entry}</span>;
        if (!isRecord(entry)) return null;
        const text = propText(entry.t ?? entry.text);
        const tokens = typeof entry.s === "string" ? entry.s : "";
        const className =
          /\b(error|danger)\b/.test(tokens)
            ? "text-destructive"
            : /\b(success|ins)\b/.test(tokens)
              ? "text-[#00774f] dark:text-[#00885a]"
              : /\b(warning)\b/.test(tokens)
                ? "text-[#452300] dark:text-[#ba5d00]"
                : /\b(info|accent|link)\b/.test(tokens)
                  ? "text-[#00263c] dark:text-[#007bc3]"
                  : /\b(muted|dim)\b/.test(tokens)
                    ? "text-muted-foreground"
                    : /\b(strong|em)\b/.test(tokens)
                      ? "font-medium"
                      : "";
        const content = /code|mono|path|key|num/.test(tokens) ? (
          <code className="bg-muted rounded px-0.5 font-mono text-[0.92em]">
            {text}
          </code>
        ) : (
          text
        );
        return (
          <span
            key={index}
            className={className}
            title={typeof entry.href === "string" ? entry.href : undefined}
          >
            {content}
          </span>
        );
      })}
    </>
  );
}

function ProgressBar({ node }: { node: SurfaceNode }) {
  const value = Number(node.props?.value ?? 0);
  const max = Number(node.props?.max ?? 100) || 100;
  const percent = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
      <div className="bg-primary h-full" style={{ width: `${percent}%` }} />
    </div>
  );
}

function NodeTable({ node }: { node: SurfaceNode }) {
  const rows = Array.isArray(node.props?.rows) ? node.props.rows : [];
  if (!rows.length) return <pre className="text-xs">{propText(node.text)}</pre>;
  return (
    <div className="overflow-auto rounded-md border">
      <table className="w-full border-collapse text-xs">
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-b last:border-0">
              {(Array.isArray(row) ? row : [row]).map((cell, cellIndex) => (
                <td key={cellIndex} className="px-2 py-1 align-top">
                  <Spans value={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NodeInput({
  node,
  sf,
  onEvent,
}: {
  node: SurfaceNode;
  sf: string;
  onEvent: SurfaceAction;
}) {
  const source = propText(node.text ?? node.props?.value);
  const [value, setValue] = useState(source);
  useEffect(() => setValue(source), [source]);
  const update = (next: string, cursor: number) => {
    onEvent({ ev: "edit", sf, id: node.id, from: 0, to: value.length, text: next, cursor, len: value.length });
    setValue(next);
  };
  const multiline = node.kind === "editor";
  const submit = () => {
    if (node.props?.sendable === true) onEvent({ ev: "send", sf, id: node.id, text: value });
    else onEvent({ ev: "change", sf, id: node.id, text: value });
  };
  return (
    <div className="space-y-1">
      {multiline ? (
        <Textarea
          value={value}
          onChange={(event) => update(event.target.value, event.target.selectionStart ?? event.target.value.length)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          className="min-h-24 font-mono text-xs"
          placeholder={propText(node.props?.placeholder)}
        />
      ) : (
        <Input
          value={value}
          onChange={(event) => update(event.target.value, event.target.selectionStart ?? event.target.value.length)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          className="h-8 text-xs"
          placeholder={propText(node.props?.placeholder)}
        />
      )}
      <Button type="button" size="sm" variant="outline" onClick={submit}>
        发送给 TUI
      </Button>
    </div>
  );
}

export function SurfaceNodeView({
  node,
  sf,
  depth,
  onEvent,
}: {
  node: SurfaceNode;
  sf: string;
  depth: number;
  onEvent: SurfaceAction;
}) {
  if (node.kind === "spacer" || node.kind === "rule") {
    return <div className="bg-border h-px w-full" />;
  }
  const children = node.children;
  const textValue = node.text ?? node.props?.text;
  const label = propText(
    node.props?.label ?? node.props?.title ?? node.props?.text ?? node.text,
  );

  if (node.kind === "text" || node.kind === "md") {
    return (
      <div className="text-sm break-words">
        {node.kind === "md" ? (
          <MessageResponse>{propText(textValue) || label}</MessageResponse>
        ) : (
          <span className="whitespace-pre-wrap">
            <Spans value={node.props?.text ?? textValue} />
          </span>
        )}
      </div>
    );
  }

  if (node.kind === "code") {
    return (
      <CodeBlock
        code={propText(textValue)}
        language={(propText(node.props?.lang) || "text") as BundledLanguage}
        className="max-h-64 overflow-auto"
      />
    );
  }

  if (node.kind === "ansi" || node.kind === "rows") {
    return (
      <pre className="bg-background max-h-72 overflow-auto rounded-md border p-2 font-mono text-[11px] whitespace-pre-wrap">
        {ansiSegments(propText(textValue)).map((segment, index) => (
          <span key={index} style={{ color: segment.color, backgroundColor: segment.backgroundColor, fontWeight: segment.bold ? "bold" : undefined, textDecoration: segment.underline ? "underline" : undefined }}>{segment.text}</span>
        ))}
      </pre>
    );
  }

  if (node.kind === "diff") {
    return (
      <pre className="max-h-72 overflow-auto rounded-md border p-2 font-mono text-[11px] whitespace-pre-wrap">
        {propText(textValue)
          .split("\n")
          .map((line, index) => (
            <div
              key={index}
              className={
                line.startsWith("+")
                  ? "text-[#00774f] dark:text-[#00885a]"
                  : line.startsWith("-")
                    ? "text-[#130005] dark:text-[#ec003f]"
                    : ""
              }
            >
              {line}
            </div>
          ))}
      </pre>
    );
  }

  if (node.kind === "table" || node.kind === "kv") {
    return <NodeTable node={node} />;
  }

  if (node.kind === "progress" || node.kind === "meter" || node.kind === "rate") {
    return (
      <div className="space-y-1">
        <ProgressBar node={node} />
        {label && <p className="text-muted-foreground text-[10px]">{label}</p>}
      </div>
    );
  }

  if (node.kind === "badge" || node.kind === "status" || node.kind === "kbd") {
    if (node.kind === "kbd") {
      return (
        <kbd className="bg-muted rounded border px-1.5 py-0.5 font-mono text-[10px]">
          {label}
        </kbd>
      );
    }
    return (
      <Badge variant="secondary" className="text-[10px]">
        {label || node.kind}
      </Badge>
    );
  }

  if (node.kind === "input" || node.kind === "editor") {
    return <NodeInput node={node} sf={sf} onEvent={onEvent} />;
  }

  if (node.kind === "button" || node.kind === "buttons") {
    if (node.kind === "button") {
      const disabled = Boolean(node.props?.disabled);
      return (
        <Button
          type="button"
          size="sm"
          variant={node.props?.tone === "accent" ? "default" : "outline"}
          disabled={disabled}
          onClick={() =>
            onEvent({
              ev: "activate",
              sf,
              id: node.id,
              item: propText(node.props?.value) || label,
              value: propText(node.props?.value),
              text: label,
            })
          }
        >
          {label || "按钮"}
        </Button>
      );
    }
    return (
      <div className="flex flex-wrap gap-1.5">
        {children.map((child) => (
          <SurfaceNodeView
            key={child.id}
            node={child}
            sf={sf}
            depth={depth + 1}
            onEvent={onEvent}
          />
        ))}
      </div>
    );
  }

  if (node.kind === "item") {
    const detail = propText(node.props?.detail);
    const value = propText(node.props?.value) || label;
    const disabled = Boolean(node.props?.disabled);
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() =>
          onEvent({
            ev: "select",
            sf,
            id: node.id,
            item: value,
            value,
            text: label,
          })
        }
        className="hover:bg-muted/60 flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors disabled:opacity-50"
      >
        <ChevronRightIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{label}</span>
          {detail && (
            <span className="text-muted-foreground block text-xs">{detail}</span>
          )}
          {children.length > 0 && (
            <span className="mt-1 block space-y-1">
              {children.map((child) => (
                <SurfaceNodeView
                  key={child.id}
                  node={child}
                  sf={sf}
                  depth={depth + 1}
                  onEvent={onEvent}
                />
              ))}
            </span>
          )}
        </span>
      </button>
    );
  }

  if (node.kind === "list" || node.kind === "checklist") {
    return (
      <ul className="space-y-1">
        {children.map((child) => (
          <li key={child.id}>
            <SurfaceNodeView
              node={child}
              sf={sf}
              depth={depth + 1}
              onEvent={onEvent}
            />
          </li>
        ))}
      </ul>
    );
  }

  if (node.kind === "image" || node.kind === "media") {
    const src = propText(node.props?.src ?? node.props?.url);
    if (/^(https?:|data:image\/|blob:)/.test(src)) {
      return (
        <img
          src={src}
          alt={propText(node.props?.alt) || "surface image"}
          className="max-h-64 rounded-md border object-contain"
        />
      );
    }
    return <p className="text-muted-foreground text-xs">[image]</p>;
  }

  if (node.kind === "web") {
    const href = propText(node.props?.href ?? node.props?.url);
    const attributes = externalLinkAttributes(href);
    if (attributes) {
      return (
        <a
          {...attributes}
          className="text-primary text-sm hover:underline"
        >
          {label || href}
        </a>
      );
    }
  }

  if (node.kind === "spinner" || node.kind === "shimmer" || node.kind === "elapsed") {
    return (
      <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <span className="size-1.5 animate-pulse rounded-full bg-sky-400" />
        {label || "…"}
      </span>
    );
  }

  if (node.kind === "tabs" || node.kind === "seg" || node.kind === "menu") {
    return (
      <div className="flex flex-wrap gap-1 border-b pb-1">
        {children.map((child) => (
          <Button
            key={child.id}
            type="button"
            size="sm"
            variant={child.props?.active === true ? "secondary" : "ghost"}
            className="h-7 px-2 text-xs"
            onClick={() =>
              onEvent({
                ev: "select",
                sf,
                id: child.id,
                item: propText(child.props?.value) || propText(child.text),
                value: propText(child.props?.value),
                text: propText(child.text ?? child.props?.label),
              })
            }
          >
            {propText(child.props?.label ?? child.text) || child.kind}
          </Button>
        ))}
      </div>
    );
  }

  if (node.kind === "json" || node.kind === "tree") {
    return (
      <pre className="bg-muted/30 max-h-64 overflow-auto rounded-md border p-2 font-mono text-[11px] whitespace-pre-wrap">
        {propText(textValue) || JSON.stringify(node.props, null, 2)}
      </pre>
    );
  }

  if (
    node.kind === "col" ||
    node.kind === "row" ||
    node.kind === "card" ||
    node.kind === "section" ||
    node.kind === "overlay" ||
    node.kind === "doc" ||
    node.kind === "tool" ||
    node.kind === "agent" ||
    node.kind === "shell" ||
    node.kind === "picker" ||
    node.kind === "prefs" ||
    node.kind === "settings"
  ) {
    const row = node.kind === "row";
    const chrome =
      node.kind === "card" ||
      node.kind === "section" ||
      node.kind === "overlay" ||
      node.kind === "doc" ||
      node.kind === "tool" ||
      node.kind === "agent" ||
      node.kind === "shell";
    return (
      <div
        className={`${row ? "flex flex-wrap items-start gap-2" : "flex flex-col gap-1.5"} ${
          chrome ? "bg-card/60 rounded-lg border p-2.5" : ""
        } ${depth > 6 ? "opacity-90" : ""}`}
      >
        {label && (
          <div className="text-muted-foreground flex items-center gap-2 text-[11px] font-medium tracking-wide uppercase">
            {label}
            {node.props?.collapsible === true && (
              <button
                type="button"
                className="hover:text-foreground inline-flex items-center gap-0.5 text-[10px] normal-case"
                onClick={() =>
                  onEvent({
                    ev: "toggle",
                    sf,
                    id: node.id,
                    collapsed: Boolean(node.props?.collapsed),
                  })
                }
              >
                <ChevronRightIcon className="size-3" />
                {node.props?.collapsed === true ? "展开" : "折叠"}
              </button>
            )}
          </div>
        )}
        <Spans value={node.props?.text} />
        {children.map((child) => (
          <SurfaceNodeView
            key={child.id}
            node={child}
            sf={sf}
            depth={depth + 1}
            onEvent={onEvent}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="text-sm">
      {label && <div className="mb-1">{label}</div>}
      {children.map((child) => (
        <SurfaceNodeView
          key={child.id}
          node={child}
          sf={sf}
          depth={depth + 1}
          onEvent={onEvent}
        />
      ))}
    </div>
  );
}

export function Region({
  node,
  sf,
  empty,
  onEvent,
}: {
  node: SurfaceNode | undefined;
  sf: string;
  empty: ReactNode;
  onEvent: SurfaceAction;
}) {
  if (!node || node.children.length === 0) {
    return <div className="text-muted-foreground p-6 text-center text-sm">{empty}</div>;
  }
  return (
    <div className="space-y-2 p-3">
      {node.children.map((child) => (
        <SurfaceNodeView
          key={child.id}
          node={child}
          sf={sf}
          depth={0}
          onEvent={onEvent}
        />
      ))}
    </div>
  );
}
