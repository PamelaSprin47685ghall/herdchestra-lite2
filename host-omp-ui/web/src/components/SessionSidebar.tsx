import { useMemo, useState } from "react";
import { Loader2Icon, RefreshCwIcon, SearchIcon, XIcon } from "lucide-react";
import { Button } from "@herd/deer-flow-ui/ui/button";
import { Input } from "@herd/deer-flow-ui/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@herd/deer-flow-ui/ui/sheet";
import { modelNickname } from "../lib/model-display";
import type { SessionSummary, WebState } from "../protocol/types";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

function CloseInstanceButton({ sessionId }: { sessionId: string }) {
  const [closing, setClosing] = useState(false);
  const close = () => {
    if (closing) return;
    setClosing(true);
    window.dispatchEvent(
      new CustomEvent("omp-ui:close-instance", { detail: sessionId }),
    );
    window.setTimeout(() => setClosing(false), 8000);
  };
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label="关闭此 Herdchestra 实例"
      title="退出此 Herdchestra 实例（关闭最后一个时会自动在桌面开启空白实例保活）"
      onClick={(event) => {
        event.stopPropagation();
        close();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
      className="text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10 group-hover:opacity-100 focus-visible:opacity-100 ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md opacity-0 transition-opacity"
    >
      {closing ? (
        <Loader2Icon className="size-3 animate-spin" />
      ) : (
        <span aria-hidden className="text-sm leading-none">×</span>
      )}
    </span>
  );
}

function formatStamp(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${WEEKDAYS[date.getDay()]} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dirLabel(cwd: string | null | undefined): string {
  if (!cwd) return "";
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function modelTone(label: string): string {
  const key = label.toLowerCase();
  if (key.includes("claude") || key.includes("sonnet") || key.includes("opus")) return "border-violet-500/25 bg-violet-500/10 text-[#010102] dark:text-[#914cfd]";
  if (key.includes("gpt") || key.includes("openai")) return "border-emerald-500/25 bg-emerald-500/10 text-[#007753] dark:text-[#00885f]";
  if (key.includes("deepseek")) return "border-sky-500/25 bg-sky-500/10 text-[#00243a] dark:text-[#007bc5]";
  if (key.includes("gemini")) return "border-amber-500/25 bg-amber-500/10 text-[#381700] dark:text-[#c75200]";
  return "border-border bg-muted/60 text-muted-foreground";
}

export function SessionSidebarContent({
  state,
  onOpen,
  onRefresh,
  onNew,
  onClose,
  refreshing,
  catalogStale,
  liveIds = [],
  startingInstances = [],
}: {
  state: WebState;
  liveIds?: string[];
  startingInstances?: { instanceId: string; title?: string | null; cwd?: string | null }[];
  onOpen: (id: string) => void;
  onNew?: () => void;
  onRefresh?: () => void;
  onClose?: () => void;
  refreshing?: boolean;
  catalogStale?: boolean;
}) {
  const [query, setQuery] = useState("");
  const liveId = state.liveSession.session?.id ?? null;
  const sessions = useMemo(() => {
    const seen = new Set<string>();
    const list: SessionSummary[] = [];
    const live = state.liveSession.session;
    if (live?.id) {
      list.push(live);
      seen.add(live.id);
    }
    for (const session of state.sessions) {
      if (!session.id || seen.has(session.id)) continue;
      seen.add(session.id);
      list.push(session);
    }
    return list;
  }, [state.liveSession.session, state.sessions]);
  const q = query.trim().toLowerCase();
  const matches = (title?: string | null, id?: string, cwd?: string | null) =>
    `${title ?? ""} ${id ?? ""} ${cwd ?? ""}`.toLowerCase().includes(q);
  const filtered = sessions.filter((session) => matches(session.title, session.id, session.cwd));

  return (
    <div className="bg-sidebar text-sidebar-foreground flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 px-3 pt-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span aria-hidden className="shrink-0 text-sm leading-none">
            🐘
          </span>
          <span className="truncate text-sm font-semibold">Herdchestra</span>
          {state.streaming && (
            <Loader2Icon className="text-brand size-3 animate-spin" />
          )}
        </div>
        {onNew && <Button variant="ghost" size="sm" className="h-8" onClick={onNew} aria-label="新建会话">+</Button>}
        {onRefresh && (
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="刷新会话"
          >
            {refreshing ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3.5" />
            )}
          </Button>
        )}
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={onClose}
            aria-label="关闭会话列表"
          >
            <XIcon className="size-4" />
          </Button>
        )}
      </div>
      <div className="relative px-3 py-2">
        <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-5 size-3.5 -translate-y-1/2" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="过滤会话"
          className="h-8 pl-8 text-xs"
        />
      </div>
      {catalogStale && (
        <div role="status" className="text-destructive flex items-center justify-between gap-2 px-3 pb-2 text-xs">
          <span className="min-w-0 truncate">历史列表加载失败</span>
          {onRefresh && (
            <button type="button" onClick={onRefresh} className="shrink-0 underline underline-offset-2">
              重试
            </button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4 [scrollbar-gutter:stable]">
        {(() => {
          const starting = startingInstances.filter((instance) => matches(instance.title, instance.instanceId, instance.cwd));
          const liveSessions = filtered.filter((session) => session.id === liveId || liveIds.includes(session.id));
          const recentSessions = filtered.filter((session) => !(session.id === liveId || liveIds.includes(session.id)));

          const renderSession = (session: SessionSummary, isLive: boolean) => {
            const active = session.id === liveId;
            const activeModel = state.model ?? state.meta.model;
            const modelLabel = active
              ? modelNickname(activeModel, state.models)
              : "";
            const stamp = formatStamp(session.modified);
            const day = stamp.split(" ").slice(0, 2).join(" ");
            const meta = [day, dirLabel(session.cwd)].filter(Boolean).join(" · ");
            return (
              <div
                key={session.id}
                role="button"
                tabIndex={0}
                onClick={() => onOpen(session.id)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  onOpen(session.id);
                }}
                title={`${session.title || "未命名会话"}\n${stamp}${session.cwd ? ` · ${session.cwd}` : ""}`}
                className={
                  active
                    ? "group border-brand bg-sidebar-accent text-sidebar-accent-foreground flex w-full cursor-pointer items-start gap-2 rounded-lg border-l-2 px-3 py-2 text-left transition-colors"
                    : "group hover:bg-sidebar-accent/70 flex w-full cursor-pointer items-start gap-2 rounded-lg border-l-2 border-transparent px-3 py-2 text-left transition-colors"
                }
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    {isLive && <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />}
                    <span className="min-w-0 flex-1 truncate text-[13px] leading-snug font-medium">
                      {session.title || "未命名会话"}
                    </span>
                    {isLive && <span className="text-muted-foreground/70 shrink-0 text-[10px]">live</span>}
                  </span>
                  <span className="text-muted-foreground/70 mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px]">
                    <span className="min-w-0 flex-1 truncate">{meta || "无日期"}</span>
                    {modelLabel && (
                      <span className={`inline-flex max-w-full shrink-0 items-center rounded-full border px-1.5 py-px font-mono text-[9px] ${modelTone(modelLabel)}`}>
                        <span className="truncate">{modelLabel}</span>
                      </span>
                    )}
                  </span>
                </span>
                {isLive && <CloseInstanceButton sessionId={session.id} />}
              </div>
            );
          };

          if (!starting.length && !liveSessions.length && !recentSessions.length) {
            return <p className="text-muted-foreground px-3 py-8 text-center text-xs">没有匹配的会话</p>;
          }

          return (
            <>
              {(starting.length > 0 || liveSessions.length > 0) && (
                <p className="text-muted-foreground/70 px-3 pt-3 pb-1 text-[11px] font-medium">运行中</p>
              )}
              <div className="space-y-0.5">
                {starting.map((instance) => (
                  <div key={instance.instanceId} className="text-muted-foreground flex items-center gap-2 rounded-lg px-3 py-2 text-[13px]" aria-disabled="true">
                    <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
                    <span className="min-w-0 flex-1 truncate">{instance.title || dirLabel(instance.cwd) || instance.instanceId}</span>
                    <span className="shrink-0 text-[10px]">启动中</span>
                  </div>
                ))}
                {liveSessions.map((session) => renderSession(session, true))}
              </div>
              {recentSessions.length > 0 && (
                <p className="text-muted-foreground/70 px-3 pt-4 pb-1 text-[11px] font-medium">最近</p>
              )}
              <div className="space-y-0.5">
                {recentSessions.map((session) => renderSession(session, false))}
              </div>
            </>
          );
        })()}
      </div>
    </div>
  );
}

export function SessionSidebar(props: {
  state: WebState;
  liveIds?: string[];
  startingInstances?: { instanceId: string; title?: string | null; cwd?: string | null }[];
  onOpen: (id: string) => void;
  onNew?: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  catalogStale?: boolean;
}) {
  return (
    <aside className="bg-sidebar hidden w-72 shrink-0 border-r md:flex md:flex-col">
      <SessionSidebarContent {...props} />
    </aside>
  );
}

export function SessionSidebarSheet({
  open,
  onOpenChange,
  ...props
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: WebState;
  liveIds?: string[];
  startingInstances?: { instanceId: string; title?: string | null; cwd?: string | null }[];
  onOpen: (id: string) => void;
  onNew?: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  catalogStale?: boolean;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" showClose={false} className="bg-sidebar w-72 p-0 sm:max-w-[288px]">
        <SheetTitle className="sr-only">会话列表</SheetTitle>
        <SheetDescription className="sr-only">
          本机运行中的实例与历史会话
        </SheetDescription>
        <SessionSidebarContent
          state={props.state}
          onOpen={(id) => {
            props.onOpen(id);
            onOpenChange(false);
          }}
          onRefresh={props.onRefresh}
          onClose={() => onOpenChange(false)}
          onNew={props.onNew}
          refreshing={props.refreshing}
          catalogStale={props.catalogStale}
          liveIds={props.liveIds}
          startingInstances={props.startingInstances}
        />
      </SheetContent>
    </Sheet>
  );
}
