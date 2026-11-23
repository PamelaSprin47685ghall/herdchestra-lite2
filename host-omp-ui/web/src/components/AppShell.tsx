import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Loader2Icon, WifiOffIcon } from "lucide-react";
import { toast, Toaster } from "sonner";
import { Button } from "@herd/deer-flow-ui/ui/button";
import { Input } from "@herd/deer-flow-ui/ui/input";
import { TooltipProvider } from "@herd/deer-flow-ui/ui/tooltip";
import {
  createBridgeClient,
  type ConnectionState,
} from "../protocol/client";
import { isRecord } from "../protocol/guards";
import { stripAnsi } from "../protocol/tool-view";
import { createStreamBatcher } from "../protocol/stream-batcher";
import { createCatalogRefresh, type CatalogRefresh } from "../protocol/catalog-refresh";
import {
  createInitialWebState,
  frameToast,
  frameType,
  reduceWebState,
  selectWidgetList,
  selectWorkingText,
} from "../protocol/store";
import type { ServerFrame, WebState, WidgetEntry } from "../protocol/types";
import { ComposerDock, type SubmitMode } from "./ComposerDock";
import { ConversationView } from "./ConversationView";
import { InteractionDock } from "./InteractionDock";
import { SessionSidebar, SessionSidebarSheet } from "./SessionSidebar";
import { TodoDock } from "./TodoDock";
import { TopHeader } from "./TopHeader";
import { TuiSurfaceOverlay } from "./TuiSurfaceOverlay";
import {
  capabilitiesForSession,
  normalizeManagerInstance,
  instanceSessionState,
  type ManagerInstance,
} from "../lib/instance-capabilities";

const THEME_KEY = "herd.omp-ui.theme";

function readTheme(): "dark" | "light" {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function toastLevel(level: string): "info" | "success" | "warning" | "error" {
  if (level === "success" || level === "warning" || level === "error") {
    return level;
  }
  return "info";
}

function WidgetStrip({ entries }: { entries: WidgetEntry[] }) {
  if (!entries.length) return null;
  return (
    <div className="mx-auto w-full max-w-[var(--chat-max-w)] px-4">
      <div className="text-muted-foreground mb-1 space-y-0.5 rounded-lg border bg-card/50 px-3 py-1.5 font-mono text-[10px]">
        {entries.map(({ key, lines }) => {
          const line = stripAnsi(lines.join("  "));
          return (
            <div key={key} className="min-w-0 truncate" title={line}>
              <span className="text-muted-foreground/60 mr-2">[{key}]</span>
              {line}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AppShell() {
  const client = useMemo(() => createBridgeClient(), []);
  const [state, setState] = useState<WebState>(createInitialWebState);
  const [connection, setConnection] = useState<ConnectionState>(client.state);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [dismissedOverlayKey, setDismissedOverlayKey] = useState<string | null>(null);
  const [tokenDraft, setTokenDraft] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(readTheme);
  const [wideMode, setWideMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem("omp-ui:wide-mode") !== "false";
    } catch {
      return true;
    }
  });
  const [refreshing, setRefreshing] = useState(false);
  const [catalogStale, setCatalogStale] = useState(false);
  const [instances, setInstances] = useState<ManagerInstance[]>([]);
  const [opening, setOpening] = useState<string | null>(null);
  const openingRef = useRef<{ id: string; previousId: string | null; previousInstanceId?: string; requestId?: string } | null>(null);
  const lastToast = useRef<{ key: string; at: number } | null>(null);
  const socketHydrated = useRef(false);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Private mode: the class still applies for this page lifetime.
    }
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem("omp-ui:wide-mode", wideMode ? "true" : "false");
    } catch {
      // Private mode: the in-memory choice still applies for this page lifetime.
    }
  }, [wideMode]);

  useEffect(() => {
    const batcher = createStreamBatcher({
      flush: (frames) =>
        setState((current) =>
          frames.reduce(
            (next, item) => reduceWebState(next, item as ServerFrame),
            current,
          ),
        ),
    });
    return client.subscribe((frame, next) => {
      setConnection((previous) =>
        previous &&
        next &&
        Object.keys(previous).length === Object.keys(next).length &&
        Object.entries(previous).every(([key, value]) =>
          Object.is((next as Record<string, unknown>)[key], value),
        )
          ? previous
          : next,
      );
      if (!frame || typeof frame !== "object") return;
      const serverFrame = frame as ServerFrame;
      const frameKind =
        typeof serverFrame.kind === "string" ? serverFrame.kind : "";
      const earlyType = frameType(serverFrame);
      if (
        earlyType === "transcript.delta" &&
        (frameKind === "text_delta" || frameKind === "thinking_delta")
      ) {
        batcher.push(serverFrame as unknown as Record<string, unknown>);
        return;
      }
      batcher.flushNow();
      const notice = frameToast(serverFrame);
      if (notice) {
        const key = `${notice.level}:${notice.message}`;
        const now = Date.now();
        const duplicate =
          lastToast.current?.key === key && now - lastToast.current.at < 1500;
        if (!duplicate) {
          lastToast.current = { key, at: now };
          const level = toastLevel(notice.level);
          if (level === "success") toast.success(notice.message);
          else if (level === "warning") toast.warning(notice.message);
          else if (level === "error") toast.error(notice.message);
          else toast.message(notice.message);
        }
      }
      const type = frameType(serverFrame);
      if (type === "manager.instances" && Array.isArray(serverFrame.instances)) {
        setInstances(serverFrame.instances.map(normalizeManagerInstance).filter((item): item is ManagerInstance => item !== null));
      }
      if (type === "command.pending" && openingRef.current && (serverFrame.command === "manager.select" || serverFrame.command === "manager.open_session" || serverFrame.command === "manager.new_session") && typeof serverFrame.requestId === "string") {
        openingRef.current.requestId = serverFrame.requestId;
      }
      if (type === "snapshot") {
        socketHydrated.current = true;
        const session = isRecord(serverFrame.session) ? serverFrame.session : null;
        if (!openingRef.current || session?.id === openingRef.current.id || (openingRef.current.id === "" && typeof session?.id === "string" && session.id !== openingRef.current.previousId)) {
          openingRef.current = null;
          setOpening(null);
        }
      }
      if (type === "command.result" && serverFrame.ok === false) {
        const operation = openingRef.current;
        if (operation && serverFrame.requestId === operation.requestId) {
          openingRef.current = null;
          setOpening(null);
          if (operation.previousId) {
            setState((current) => reduceWebState(current, { type: "session.select", sessionId: operation.previousId }));
            if (operation.previousInstanceId) client.sendCommand("manager.select", { instanceId: operation.previousInstanceId });
          }
        }
        toast.error(`操作失败：${String(serverFrame.message ?? serverFrame.code ?? "未知错误")}`);
      }
      if (type === "interaction.error" && typeof serverFrame.code === "string") {
        toast.error(`交互被拒绝：${serverFrame.code}`);
      }
      if (type === "client.error" && typeof serverFrame.code === "string") {
        toast.error(`命令被拒绝：${serverFrame.code}`);
      }
      setState((current) => reduceWebState(current, serverFrame));
    });
  }, [client]);

  useEffect(() => {
    if (!client.token) return;
    let cancelled = false;
    void client
      .fetchBootstrap()
      .then((bootstrap) => {
        // Bootstrap only seeds the instance list. Session content is hydrated
        // by the authoritative snapshot that follows session.select, so a
        // late bootstrap response must never be treated as a snapshot.
        if (cancelled || socketHydrated.current) return;
        const listed = bootstrap.instances;
        if (Array.isArray(listed)) {
          setInstances(
            listed.map(normalizeManagerInstance).filter((item): item is ManagerInstance => item !== null),
          );
        }
      })
      .catch(() => {
        // The WS snapshot is authoritative; a failed preload is harmless.
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const send = useCallback(
    (type: string, payload?: Record<string, unknown>) => {
      client.sendCommand(type, payload);
    },
    [client],
  );

  const openSession = useCallback(
    (id: string) => {
      if (id === state.liveSession.session?.id && !opening) return;
      const instance = instances.find((item) => item.session?.id === id);
      const previousId = state.liveSession.session?.id ?? null;
      openingRef.current = { id, previousId, previousInstanceId: instances.find((item) => item.session?.id === previousId)?.instanceId };
      setOpening(id);
      setState((current) => reduceWebState(current, { type: "session.select", sessionId: id }));
      if (instance) client.sendCommand("manager.select", { instanceId: instance.instanceId });
      else client.sendCommand("manager.open_session", { sessionId: id });
    },
    [client, instances, opening, state.liveSession.session?.id],
  );

  const newSession = useCallback(() => {
    const previousId = state.liveSession.session?.id ?? null;
    const instance = instances.find((item) => item.session?.id === previousId);
    const cwd = instance?.session?.cwd;
    if (!cwd) {
      toast.error("当前会话没有可用的工作目录；请先在 Herdchestra 中打开一个项目");
      return;
    }
    openingRef.current = { id: "", previousId, previousInstanceId: instance?.instanceId };
    setOpening("正在启动新会话");
    client.sendCommand("manager.new_session", { cwd });
  }, [client, instances, state.liveSession.session?.id]);

  const catalogRef = useRef<CatalogRefresh | null>(null);
  useEffect(() => {
    const catalog = createCatalogRefresh({
      fetchSessions: () => client.fetchSessions(),
      apply: (sessions) => setState((current) => reduceWebState(current, { type: "manager.sessions", sessions })),
      error: (reason) => toast.error(reason === "offline" ? "尚未连接管理器" : "刷新会话列表失败"),
      busy: setRefreshing,
      status: (status) => {
        if (status === "stale") setCatalogStale(true);
        else if (status === "ready") setCatalogStale(false);
      },
    });
    catalogRef.current = catalog;
    return () => {
      catalogRef.current = null;
      catalog.dispose();
    };
  }, [client]);
  const refreshSessions = useCallback(() => catalogRef.current?.refresh({ manual: true }), []);

  useEffect(() => {
    catalogRef.current?.handleConnection(connection, Boolean(client.token));
  }, [client, connection]);

  const respond = useCallback(
    (requestId: string, payload: Record<string, unknown>) => {
      send("interaction.respond", { requestId, ...payload });
    },
    [send],
  );

  const submit = useCallback(
    (text: string, mode: SubmitMode = "default", attachments: { name: string; mimeType: string; data: string }[] = []) => {
      const clean = text.trim();
      if (!clean && !attachments.length) return Promise.reject(new Error("消息为空"));
      return client.submitCommand({ text: clean, mode, attachments });
    },
    [client],
  );

  const loadHistory = useCallback(
    async (before: string) => {
      const page = await client.requestHistory(before);
      return Array.isArray(page.messages) && page.messages.length > 0;
    },
    [client],
  );

  const handleDraft = useCallback((text: string) => send("composer.draft", { text }), [send]);
  const handleKeys = useCallback((data: string) => send("surface.keys", { data }), [send]);
  const handleAbort = useCallback(() => send("session.abort", {}), [send]);
  const handleModel = useCallback(
    (provider: string, modelId: string) => send("session.set_model", { provider, modelId }),
    [send],
  );
  const handleThinking = useCallback(
    (level: string) => send("session.set_thinking", { level }),
    [send],
  );
  const handleMode = useCallback(
    (mode: "plan" | "vibe", action: "enter" | "exit") =>
      send("session.set_mode", { mode, action }),
    [send],
  );

  useEffect(() => {
    const onClose = (event: Event) => {
      const sessionId = (event as CustomEvent<string>).detail;
      const instance = instances.find((item) => item.session?.id === sessionId);
      if (!instance) {
        toast.error("找不到该会话对应的 Herdchestra 实例");
        return;
      }
      send("manager.close_instance", { instanceId: instance.instanceId });
    };
    window.addEventListener("omp-ui:close-instance", onClose);
    return () => window.removeEventListener("omp-ui:close-instance", onClose);
  }, [instances, send]);

  const unlock = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const clean = tokenDraft.trim();
    if (!clean) {
      setTokenError("请输入 TUI /web 命令打印的 token。");
      return;
    }
    setTokenError(null);
    client.unlock(clean);
    setTokenDraft("");
  };

  const composerKeyRef = useRef<string>(state.liveSession.session?.id ?? "live");
  if (state.liveSession.session?.id) {
    composerKeyRef.current = state.liveSession.session.id;
  }
  const composerKey = composerKeyRef.current;

  if (!client.token || connection === "unauthorized") {
    return (
      <main className="bg-background text-foreground grid min-h-dvh place-items-center p-4">
        <form
          className="bg-card w-[min(30rem,94vw)] rounded-2xl border p-6 shadow-sm"
          onSubmit={unlock}
        >
          <h1 className="text-lg font-semibold">解锁本机会话</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            把 TUI 中 <code className="bg-muted rounded px-1">/web</code>{" "}
            打印的带 token URL 直接打开，或在这里粘贴 token。它只存在这个浏览器标签里。
          </p>
          <Input
            className="mt-4"
            value={tokenDraft}
            onChange={(event) => setTokenDraft(event.target.value)}
            placeholder="token"
            autoFocus
            aria-invalid={Boolean(tokenError)}
          />
          {tokenError && (
            <p className="text-destructive mt-2 text-xs">{tokenError}</p>
          )}
          <div className="mt-4 flex items-center gap-2">
            <Button type="submit">进入</Button>
            <span className="text-muted-foreground text-xs">
              {connection === "unauthorized"
                ? "token 未通过校验或已失效"
                : "仅绑定 127.0.0.1"}
            </span>
          </div>
        </form>
      </main>
    );
  }

  const capabilities = capabilitiesForSession(instances, state.liveSession.session?.id);
  const disabled = Boolean(opening);
  const sidebarState = (() => {
    const seen = new Set<string>();
    const live = state.liveSession.session;
    if (live?.id) seen.add(live.id);
    const merged: typeof state.sessions = [];
    for (const item of instances) {
      const session = item.session;
      if (!session?.id || seen.has(session.id)) continue;
      seen.add(session.id);
      merged.push({ ...session, id: session.id });
    }
    for (const session of state.sessions) {
      if (!session.id || seen.has(session.id)) continue;
      seen.add(session.id);
      merged.push(session);
    }
    return { ...state, sessions: merged };
  })();
  const startingInstances = instances.filter((item) => instanceSessionState(item) === "starting").map((item) => ({ instanceId: item.instanceId, title: item.session?.title, cwd: item.session?.cwd }));
  const liveIds = instances.flatMap((item) => item.session?.id ? [item.session.id] : []);
  const overlayKey = state.overlays.map((item) => item.id ?? item.title ?? "").join("|");
  return (
    <TooltipProvider>
      <div
        data-wide={wideMode ? "true" : "false"}
        className="bg-background text-foreground flex h-dvh overflow-hidden"
      >
        <SessionSidebar
          state={sidebarState}
          onOpen={(id) => void openSession(id)}
          onRefresh={() => void refreshSessions()}
          onNew={newSession}
          liveIds={liveIds}
          startingInstances={startingInstances}
          refreshing={refreshing}
          catalogStale={catalogStale}
        />
        <SessionSidebarSheet
          open={mobileSidebar}
          onOpenChange={setMobileSidebar}
          state={sidebarState}
          onOpen={(id) => void openSession(id)}
          onRefresh={() => void refreshSessions()}
          onNew={newSession}
          liveIds={liveIds}
          startingInstances={startingInstances}
          refreshing={refreshing}
          catalogStale={catalogStale}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TopHeader
            state={state}
            connection={connection}
            wideMode={wideMode}
            onToggleWide={() => setWideMode((current) => !current)}
            theme={theme}
            onMenu={() => setMobileSidebar(true)}
            onToggleTheme={() =>
              setTheme((current) => (current === "dark" ? "light" : "dark"))
            }
          />
          {connection === "offline" && (
            <div className="flex items-center gap-2 border-b bg-amber-500/10 px-4 py-1.5 text-xs text-[#381700] dark:text-[#c75200]">
              <WifiOffIcon className="size-3.5" />
              连接断开，正在自动重连；界面保留最后一帧状态。
            </div>
          )}

          <ConversationView
            key={`conversation:${composerKey}`}
            hasMoreHistory={Boolean(state.liveSession.history?.hasMore)}
            historyOldestId={state.liveSession.history?.oldestId ?? null}
            messages={state.messages}
            toolExecutions={state.toolExecutions}
            streaming={state.streaming}
            onLoadHistory={loadHistory}
          />
          <WidgetStrip entries={selectWidgetList(state)} />
          <TodoDock todos={state.todos} phases={state.todoPhases} />
          <InteractionDock
            items={state.openInteractions}
            errors={state.interactionErrors}
            onRespond={respond}
          />
          {opening && (
            <div className="text-muted-foreground flex items-center gap-2 px-4 py-1 text-xs">
              <Loader2Icon className="size-3.5 animate-spin" />
              正在启动或连接会话…
            </div>
          )}
          {connection === "connecting" && !state.messages.length && (
            <div className="text-muted-foreground flex items-center gap-2 px-4 py-1 text-xs">
              <Loader2Icon className="size-3.5 animate-spin" />
              正在连接 Herdchestra…
            </div>
          )}
          <ComposerDock
            key={`composer:${composerKey}`}
            draft={state.draft}
            models={state.models}
            modelKey={
              state.model ? `${state.model.provider}/${state.model.id}` : ""
            }
            thinkingLevel={state.thinkingLevel}
            thinkingLevels={state.thinkingLevels}
            modes={state.modes}
            streaming={state.streaming}
            working={selectWorkingText(state)}
            disabled={disabled}
            capabilities={capabilities}
            queue={state.queue}
            completion={state.completion}
            onKeys={handleKeys}
            onDraft={handleDraft}
            onSubmit={submit}
            onAbort={handleAbort}
            onModel={handleModel}
            onThinking={handleThinking}
            onMode={handleMode}
          />
        </main>
        <TuiSurfaceOverlay
          open={
            state.overlays.length > 0 &&
            capabilities?.canUseTuiSurface !== false &&
            overlayKey !== dismissedOverlayKey
          }
          onOpenChange={(next) => {
            if (!next) {
              setDismissedOverlayKey(overlayKey);
            }
          }}
          surface={state.surface}
          overlays={state.overlays}
          fences={state.meta.fence}
          onEvent={(payload) =>
            send("surface.event", {
              sf: state.surface.sf || "s:web",
              ...payload,
            })
          }
          onKeys={(data) => send("surface.keys", { data })}
        />
      </div>
      <Toaster theme={theme} position="top-right" richColors />
    </TooltipProvider>
  );
}
