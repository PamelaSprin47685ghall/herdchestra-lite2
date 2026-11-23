import { useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CornerDownLeftIcon,
  KeyboardIcon,
  LayersIcon,
  MonitorIcon,
  PanelLeftIcon,
  TerminalSquareIcon,
} from "lucide-react";
import { Badge } from "@herd/deer-flow-ui/ui/badge";
import { Button } from "@herd/deer-flow-ui/ui/button";
import { ScrollArea } from "@herd/deer-flow-ui/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@herd/deer-flow-ui/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@herd/deer-flow-ui/ui/tabs";
import { findRegion } from "../protocol/surface";
import type {
  OverlaySummary,
  SurfaceDocument,
  SurfaceNode,
} from "../protocol/types";
import { KEYS, KeyPassthrough } from "./tui-surface/keyboard";
import {
  Region,
  SurfaceNodeView,
  type SurfaceAction,
} from "./tui-surface/node-view";

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
              <Badge className="bg-amber-500/15 text-[10px] text-[#452300] dark:text-[#ba5d00]">
                {overlays.length} 个 overlay
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription className="text-xs">
            结构化 Tsp 节点直接映射为 DeerFlow 元件；无 describe() 的组件用按键透传。
          </SheetDescription>
        </SheetHeader>
        <KeyPassthrough onKeys={onKeys} />
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
