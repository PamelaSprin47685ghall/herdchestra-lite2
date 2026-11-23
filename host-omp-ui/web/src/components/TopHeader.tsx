import {
  BoxesIcon,
  CircleDotIcon,
  MoonIcon,
  PanelLeftIcon,
  SunIcon,
  TerminalSquareIcon,
  WifiOffIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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

function ConnectionBadge({ state }: { state: ConnectionState }) {
  const tone =
    state === "connected"
      ? "bg-emerald-500"
      : state === "connecting" || state === "reconnecting"
        ? "bg-amber-500 animate-pulse"
        : "bg-rose-500";
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
      <span className={`size-2 rounded-full ${tone}`} />
      {CONNECTION_LABEL[state]}
    </span>
  );
}

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
  const model = state.model;
  const rawTitle =
    state.session?.title ??
    state.meta.title ??
    "omp";
  const title = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(rawTitle)
    ? "未命名会话"
    : rawTitle;
  const plan = selectModeStatus(state.modes, "plan");
  const vibe = selectModeStatus(state.modes, "vibe");
  const goal = selectModeStatus(state.modes, "goal");
  const loop = selectModeStatus(state.modes, "loop");
  const busy = state.streaming || Boolean(state.meta.busy);
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
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          {busy && (
            <span className="flex items-center gap-1 text-xs text-brand">
              <CircleDotIcon className="size-3 animate-pulse" /> 工作中
            </span>
          )}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2">
          <ConnectionBadge state={connection} />
          {connection === "offline" && (
            <WifiOffIcon className="text-muted-foreground size-3" />
          )}
          {model && (
            <span className="text-muted-foreground truncate text-xs">
              {state.models.find((candidate) => candidate.provider === model.provider && candidate.id === model.id)?.name ??
                model.name ??
                model.id.split("/").filter(Boolean).pop() ??
                model.id}
            </span>
          )}
          {state.thinkingLevel && (
            <Badge variant="outline" className="text-[10px]">
              {state.thinkingLevel.charAt(0).toUpperCase() + state.thinkingLevel.slice(1)}
            </Badge>
          )}
          {plan === "active" && (
            <Badge className="bg-violet-500/15 text-[10px] text-violet-600 dark:text-violet-300">
              plan
            </Badge>
          )}
          {vibe === "active" && (
            <Badge className="bg-emerald-500/15 text-[10px] text-emerald-600 dark:text-emerald-300">
              vibe
            </Badge>
          )}
          {goal !== "inactive" && (
            <Badge variant="secondary" className="text-[10px]">
              goal · {goal}
            </Badge>
          )}
          {loop !== "inactive" && (
            <Badge variant="secondary" className="text-[10px]">
              loop · {loop}
            </Badge>
          )}
        </div>
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <div className="hidden w-28 cursor-default flex-col gap-1 sm:flex md:w-32">
            <div className="text-muted-foreground flex justify-between text-[10px]">
              <span>上下文</span>
              <span>
                {usage.percent}%
                {usage.tokens !== null ? ` · ${usage.tokens.toLocaleString()} tok` : ""}
              </span>
            </div>
            <div className="bg-muted h-1.5 overflow-hidden rounded-full">
              <div
                className={`h-full transition-all ${
                  usage.percent > 85
                    ? "bg-destructive"
                    : usage.percent > 65
                      ? "bg-amber-500"
                      : "bg-primary"
                }`}
                style={{ width: `${Math.max(2, usage.percent)}%` }}
              />
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
