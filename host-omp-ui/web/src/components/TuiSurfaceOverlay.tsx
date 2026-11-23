import { useEffect, useState } from "react";
import { externalLinkAttributes } from "../lib/safe-links";
import type { ReactNode } from "react";
import type { BundledLanguage } from "shiki";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  CornerDownLeftIcon,
  KeyboardIcon,
  LayersIcon,
  MonitorIcon,
  PanelLeftIcon,
  TerminalSquareIcon,
} from "lucide-react";
import { CodeBlock } from "@herd/deer-flow-ui/ai-elements/code-block";
import { MessageResponse } from "@herd/deer-flow-ui/ai-elements/message";
import { Badge } from "@herd/deer-flow-ui/ui/badge";
import { Button } from "@herd/deer-flow-ui/ui/button";
import { Input } from "@herd/deer-flow-ui/ui/input";
import { ScrollArea } from "@herd/deer-flow-ui/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@herd/deer-flow-ui/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@herd/deer-flow-ui/ui/tabs";
import { Textarea } from "@herd/deer-flow-ui/ui/textarea";
import { isRecord } from "../protocol/guards";
import { findRegion } from "../protocol/surface";
import { ansiSegments } from "../protocol/tool-view";
import type {
  OverlaySummary,
  SurfaceDocument,
  SurfaceNode,
} from "../protocol/types";

type SurfaceAction = (payload: Record<string, unknown>) => void;

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
              ? "text-emerald-600 dark:text-emerald-400"
              : /\b(warning)\b/.test(tokens)
                ? "text-amber-600 dark:text-amber-400"
                : /\b(info|accent|link)\b/.test(tokens)
                  ? "text-sky-600 dark:text-sky-400"
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

function SurfaceNodeView({
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
                  ? "text-emerald-600 dark:text-emerald-400"
                  : line.startsWith("-")
                    ? "text-rose-600 dark:text-rose-400"
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

  if (node.kind === "json" || node.kind === "tree" || node.kind === "code") {
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

function Region({
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

const KEYS: Array<{ label: string; data: string; title: string }> = [
  { label: "Esc", data: "\u001b", title: "Escape" },
  { label: "Tab", data: "\t", title: "Tab" },
  { label: "⇧Tab", data: "\u001b[Z", title: "Shift+Tab" },
  { label: "↑", data: "\u001b[A", title: "Arrow up" },
  { label: "↓", data: "\u001b[B", title: "Arrow down" },
  { label: "←", data: "\u001b[D", title: "Arrow left" },
  { label: "→", data: "\u001b[C", title: "Arrow right" },
  { label: "Enter", data: "\r", title: "Enter" },
  { label: "Ctrl+O", data: "\u000f", title: "Ctrl+O" },
];

export function TuiSurfaceOverlay({
  open,
  onOpenChange,
  surface,
  overlays,
  fences,
  onEvent,
  onKeys,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  surface: SurfaceDocument;
  overlays: OverlaySummary[];
  fences?: Record<string, unknown> | null;
  onEvent: SurfaceAction;
  onKeys: (data: string) => void;
}) {
  const sf = surface.sf || "s:web";
  const layer = findRegion(surface, "layer");
  const main = findRegion(surface, "main");
  const dock = findRegion(surface, "dock");
  const [tab, setTab] = useState("overlay");
  const overlayNode = (
    overlay: OverlaySummary,
    index: number,
  ): SurfaceNode | undefined => {
    if (!layer) return undefined;
    return (
      layer.children.find((child) => child.id === overlay.id) ??
      layer.children[index]
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl"
      >
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-sm">
            <TerminalSquareIcon className="size-4" />
            TUI Surface
            <Badge variant="secondary" className="text-[10px]">
              {surface.sf ?? "s:web"} · seq {surface.seq}
            </Badge>
            {overlays.length > 0 && (
              <Badge className="bg-amber-500/15 text-[10px] text-amber-600 dark:text-amber-300">
                {overlays.length} 个 overlay
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription className="text-xs">
            结构化 Tsp 节点直接映射为 DeerFlow 元件；无 describe() 的组件用按键透传。
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-wrap items-center gap-1 border-b px-3 py-1.5">
          {KEYS.map((key) => (
            <Button
              key={key.label}
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-1.5 font-mono text-[10px]"
              title={key.title}
              onClick={() => onKeys(key.data)}
            >
              {key.label}
            </Button>
          ))}
          <input
            aria-label="TUI 键盘透传"
            placeholder="聚焦此处向 TUI 键入"
            className="ml-auto h-7 min-w-36 rounded border bg-transparent px-2 text-xs"
            value=""
            onChange={() => {}}
            onPaste={(event) => {
              event.preventDefault();
              const text = event.clipboardData.getData("text/plain");
              if (text) onKeys(`\u001b[200~${text}\u001b[201~`);
            }}
            onCompositionEnd={(event) => {
              if (event.data) onKeys(event.data);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.key === "Process") return;
              if (event.metaKey || (event.ctrlKey && ["v", "c", "x"].includes(event.key.toLowerCase()))) {
                // Ctrl+C is a terminal interrupt; paste is handled by onPaste.
                if (!event.ctrlKey || event.key.toLowerCase() !== "c") return;
              }
              const special: Record<string, string> = {
                Escape: "\u001b", Enter: "\r", Tab: event.shiftKey ? "\u001b[Z" : "\t",
                Backspace: "\u007f", Delete: "\u001b[3~", ArrowUp: "\u001b[A",
                ArrowDown: "\u001b[B", ArrowRight: "\u001b[C", ArrowLeft: "\u001b[D",
                Home: "\u001b[H", End: "\u001b[F", PageUp: "\u001b[5~", PageDown: "\u001b[6~",
              };
              let data = special[event.key];
              const modifier = 1 + (event.shiftKey ? 1 : 0) + (event.altKey ? 2 : 0) + (event.ctrlKey ? 4 : 0);
              const arrows: Record<string, string> = { ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D", Home: "H", End: "F" };
              const tilde: Record<string, number> = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
              const fkeys: Record<string, string> = { F1: "P", F2: "Q", F3: "R", F4: "S" };
              if (arrows[event.key] && modifier > 1) data = `\u001b[1;${modifier}${arrows[event.key]}`;
              else if (tilde[event.key]) data = `\u001b[${tilde[event.key]}${modifier > 1 ? `;${modifier}` : ""}~`;
              else if (fkeys[event.key]) data = modifier > 1 ? `\u001b[1;${modifier}${fkeys[event.key]}` : `\u001bO${fkeys[event.key]}`;
              if (!data && event.ctrlKey && /^[a-z]$/i.test(event.key)) {
                data = String.fromCharCode(event.key.toUpperCase().charCodeAt(0) - 64);
              } else if (!data && !event.ctrlKey && event.key.length === 1) {
                data = event.key;
              }
              if (!data) return;
              event.preventDefault();
              const encodedModifier = modifier > 1 && Boolean(arrows[event.key] || tilde[event.key] || fkeys[event.key]);
              onKeys(event.altKey && !encodedModifier ? `\u001b${data}` : data);
            }}
          />
        </div>
        <Tabs
          value={tab}
          onValueChange={setTab}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <TabsList className="mx-3 mt-2 w-fit">
            <TabsTrigger value="overlay" className="gap-1 text-xs">
              <LayersIcon className="size-3.5" /> Overlay
            </TabsTrigger>
            <TabsTrigger value="main" className="gap-1 text-xs">
              <PanelLeftIcon className="size-3.5" /> Main
            </TabsTrigger>
            <TabsTrigger value="dock" className="gap-1 text-xs">
              <MonitorIcon className="size-3.5" /> Dock
            </TabsTrigger>
            <TabsTrigger value="keys" className="gap-1 text-xs">
              <KeyboardIcon className="size-3.5" /> 诊断
            </TabsTrigger>
          </TabsList>
          <ScrollArea className="min-h-0 flex-1">
            <TabsContent value="overlay" className="m-0">
              {layer && layer.children.length ? (
                <div className="space-y-3 p-3">
                  {overlays.length > 0 &&
                    overlays.map((overlay, index) => {
                      const node = overlayNode(overlay, index);
                      return (
                        <div key={`${overlay.id}-${index}`} className="space-y-1">
                          <div className="text-muted-foreground flex items-center gap-2 text-[10px]">
                            <Badge variant="outline" className="text-[10px]">
                              {overlay.kind ?? "overlay"}
                            </Badge>
                            {overlay.title ?? overlay.id}
                          </div>
                          {node ? (
                            <SurfaceNodeView
                              node={node}
                              sf={sf}
                              depth={0}
                              onEvent={onEvent}
                            />
                          ) : (
                            <p className="text-muted-foreground text-xs">
                              该 overlay 没有结构化节点，请用下方按键透传操作。
                            </p>
                          )}
                        </div>
                      );
                    })}
                  {overlays.length === 0 &&
                    layer.children.map((child) => (
                      <SurfaceNodeView
                        key={child.id}
                        node={child}
                        sf={sf}
                        depth={0}
                        onEvent={onEvent}
                      />
                    ))}
                </div>
              ) : (
                <div className="space-y-3 p-6 text-center">
                  <TerminalSquareIcon className="text-muted-foreground mx-auto size-8 opacity-40" />
                  <p className="text-muted-foreground text-sm">
                    当前没有活跃的 TUI overlay。打开 /settings、/tree 或 custom()
                    组件后会在这里出现。
                  </p>
                  {overlays.length > 0 && (
                    <div className="flex flex-wrap justify-center gap-1">
                      {overlays.map((overlay) => (
                        <Badge key={overlay.id} variant="secondary" className="text-[10px]">
                          {overlay.title ?? overlay.kind ?? overlay.id}
                        </Badge>
                      ))}
                    </div>
                  )}
                  <div className="flex justify-center gap-1">
                    {(["Esc", "↑", "↓", "Tab", "Enter"] as const).map((label) => {
                      const key = KEYS.find((entry) => entry.label === label);
                      return key ? (
                        <Button
                          key={label}
                          type="button"
                          size="sm"
                          variant="outline"
                          className="font-mono text-xs"
                          onClick={() => onKeys(key.data)}
                        >
                          {label}
                        </Button>
                      ) : null;
                    })}
                  </div>
                </div>
              )}
            </TabsContent>
            <TabsContent value="main" className="m-0">
              <Region
                node={main}
                sf={sf}
                empty="TUI main 区域还没有帧数据。"
                onEvent={onEvent}
              />
            </TabsContent>
            <TabsContent value="dock" className="m-0">
              <Region
                node={dock}
                sf={sf}
                empty="TUI dock 区域还没有帧数据。"
                onEvent={onEvent}
              />
            </TabsContent>
            <TabsContent value="keys" className="m-0 space-y-3 p-4 text-xs">
              <div>
                <p className="mb-1 font-medium">Fence</p>
                <pre className="bg-muted/40 max-h-48 overflow-auto rounded-md border p-2 font-mono text-[10px] whitespace-pre-wrap">
                  {JSON.stringify(fences ?? {}, null, 2)}
                </pre>
              </div>
              <div>
                <p className="mb-1 font-medium">Surface document</p>
                <pre className="bg-muted/40 max-h-64 overflow-auto rounded-md border p-2 font-mono text-[10px] whitespace-pre-wrap">
                  {JSON.stringify(surface, null, 2)}
                </pre>
              </div>
              <p className="text-muted-foreground">
                settle / del 会从渲染树移除节点；suspend / resume / scroll
                只影响终端本身。
              </p>
            </TabsContent>
          </ScrollArea>
        </Tabs>
        <div className="text-muted-foreground flex items-center gap-2 border-t px-3 py-1.5 text-[10px]">
          <CornerDownLeftIcon className="size-3" />
          点击结构化节点会回发 surface.event（含 sf）；输入框回车发送
          activate/send。
          <span className="ml-auto flex items-center gap-1">
            <ArrowUpIcon className="size-3" />
            <ArrowDownIcon className="size-3" /> 按键栏
          </span>
        </div>
      </SheetContent>
    </Sheet>
  );
}
