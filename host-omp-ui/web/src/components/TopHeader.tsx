import { MoonIcon, PanelLeftIcon, SunIcon } from "lucide-react";
import { Badge } from "@herd/deer-flow-ui/ui/badge";
import { Button } from "@herd/deer-flow-ui/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@herd/deer-flow-ui/ui/tooltip";
import type { ConnectionState } from "../protocol/client";
import { selectModeStatus, selectUsage } from "../protocol/store";
import type { WebState } from "../protocol/types";

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: "连接中",
  connected: "已连接",
  reconnecting: "重连中",
  unauthorized: "未解锁",
  offline: "离线",
};

export function TopHeader({
  state,
  connection,
  theme,
  wideMode,
  onMenu,
  onToggleTheme,
  onToggleWide,
}: {
  state: WebState;
  connection: ConnectionState;
  theme: "dark" | "light";
  wideMode: boolean;
  onMenu: () => void;
  onToggleTheme: () => void;
  onToggleWide: () => void;
}) {
  const usage = selectUsage(state);
  const goal = selectModeStatus(state.modes, "goal");
  const loop = selectModeStatus(state.modes, "loop");
  const busy = state.streaming || Boolean(state.meta.busy);
  const cwd = state.session?.cwd ?? state.liveSession.session?.cwd ?? "";
  const split = cwd.lastIndexOf("/");
  const dir = split > 0 ? cwd.slice(0, split) : "";
  const base = split >= 0 ? cwd.slice(split + 1) : cwd;
  const breathing =
    busy || connection === "connecting" || connection === "reconnecting";
  const tone =
    connection === "connected"
      ? "bg-emerald-500"
      : connection === "connecting" || connection === "reconnecting"
        ? "bg-amber-500"
        : "bg-rose-500";
  const fill = Math.max(2, usage.percent);
  // Past half the label sits inside the fill, right-aligned against the edge.
  const percentOnFill = fill > 50;
  return (
    <header className="bg-background/80 flex shrink-0 items-center gap-2 border-b px-3 py-2 backdrop-blur md:px-4">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={onMenu}
        aria-label="打开会话列表"
      >
        <PanelLeftIcon className="size-4" />
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="flex shrink-0 items-center outline-none"
            tabIndex={0}
            aria-label={CONNECTION_LABEL[connection]}
          >
            <span
              className={`size-2 rounded-full ${tone} ${breathing ? "animate-pulse" : ""}`}
            />
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {CONNECTION_LABEL[connection]}
          {busy ? " · 工作中" : ""}
        </TooltipContent>
      </Tooltip>
      <div
        className="flex min-w-0 flex-1 items-center gap-1.5"
        title={cwd || undefined}
      >
        {dir && (
          <span className="text-muted-foreground/60 min-w-0 truncate font-mono text-[11px]">
            {dir}
          </span>
        )}
        {base && (
          <span className="max-w-[60%] shrink-0 truncate font-mono text-xs font-medium">
            {base}
          </span>
        )}
        {goal !== "inactive" && (
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            goal · {goal}
          </Badge>
        )}
        {loop !== "inactive" && (
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            loop · {loop}
          </Badge>
        )}
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <div className="hidden cursor-default items-center gap-2 sm:flex">
            <span className="text-muted-foreground shrink-0 text-[10px]">
              上下文
            </span>
            <div className="bg-muted relative h-4 w-24 overflow-hidden rounded-full md:w-28">
              <div
                className={`h-full rounded-full transition-all ${
                  usage.percent > 85
                    ? "bg-destructive"
                    : usage.percent > 65
                      ? "bg-amber-500"
                      : "bg-primary"
                }`}
                style={{ width: `${fill}%` }}
              />
              <span
                className={`absolute top-1/2 -translate-y-1/2 text-[10px] font-medium tabular-nums ${
                  percentOnFill ? "text-primary-foreground" : "text-muted-foreground"
                }`}
                style={
                  percentOnFill
                    ? { right: `calc(${100 - Math.min(fill, 100)}% + 5px)` }
                    : { left: `min(calc(${fill}% + 5px), calc(100% - 1.5rem))` }
                }
              >
                {usage.percent}%
              </span>
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <div className="space-y-0.5 text-xs">
            <div>
              input {usage.input.toLocaleString()} · output{" "}
              {usage.output.toLocaleString()}
            </div>
            <div>
              cache {usage.cacheRead.toLocaleString()} /{" "}
              {usage.cacheWrite.toLocaleString()}
            </div>
            {usage.cost !== null && <div>cost ${usage.cost.toFixed(4)}</div>}
            {usage.contextWindow !== null && (
              <div>window {usage.contextWindow.toLocaleString()}</div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" onClick={onToggleTheme}>
            {theme === "dark" ? (
              <SunIcon className="size-4" />
            ) : (
              <MoonIcon className="size-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>切换主题</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleWide}
            aria-label={wideMode ? "切换到标准视图" : "切换到宽屏视图"}
            title="切换宽屏/标准视图"
          >
            {wideMode ? (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-4"
                aria-hidden="true"
              >
                <path d="M4 14h6v6" />
                <path d="M20 10h-6V4" />
                <path d="M14 10l7-7" />
                <path d="M3 21l7-7" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-4"
                aria-hidden="true"
              >
                <path d="M15 3h6v6" />
                <path d="M9 21H3v-6" />
                <path d="M21 3l-7 7" />
                <path d="M3 21l7-7" />
              </svg>
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>切换宽屏/标准视图</TooltipContent>
      </Tooltip>

    </header>
  );
}
