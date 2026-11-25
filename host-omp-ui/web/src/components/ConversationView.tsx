import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileIcon, SparklesIcon } from "lucide-react";
import { ConversationEmptyState } from "@herd/deer-flow-ui/ai-elements/conversation";
import { Message, MessageContent } from "@herd/deer-flow-ui/ai-elements/message";
import { IncremarkMessage } from "./IncremarkMessage";
import { WindowedScroll } from "./WindowedScroll";
import type { UiMessage, WebState } from "../protocol/types";
import { renderIndexes } from "../protocol/store";
import {
  buildTurnGroupsResumable,
  canReuseGroups,
  isStepGroupActive,
  resolveHistoryCursor,
  type TurnGroup,
  type TurnGroupCache,
} from "../lib/build-steps";
import { ProcessingSteps } from "./conversation/steps";
import {
  BoundarySummary,
  NeutralMessage,
  OrphanToolResult,
  TerminalRun,
  UserBlocks,
} from "./conversation/content-blocks";

const groupKey = (group: TurnGroup) => group.id;

function ConversationViewInner({
  messages,
  toolExecutions,
  streaming,
  streamRev = 0,
  streamDirtyFrom = 0,
  onLoadHistory,
  hasMoreHistory = false,
  historyOldestId = null,
}: {
  messages: WebState["messages"];
  toolExecutions: WebState["toolExecutions"];
  streaming: boolean;
  /** Revision of the current message sequence. */
  streamRev?: number;
  /**
   * The first index this state changed, valid only when it is one step after
   * the cached version. Read together with `streamRev`; see `WebState`.
   */
  streamDirtyFrom?: number;
  onLoadHistory?: (before: string) => Promise<boolean>;
  hasMoreHistory?: boolean;
  historyOldestId?: string | null;
}) {
  const [earlierNotice, setEarlierNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!earlierNotice) return;
    const timer = window.setTimeout(() => setEarlierNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [earlierNotice]);

  const { attachedToolIds } = renderIndexes(messages);
  // Regroup only what did not move. The settled prefix is reused only after its
  // inputs are proven identical by reference; anything else — a rewrite in the
  // middle, an insert at the front, a shorter list — falls back to regrouping
  // the whole list.
  //
  // Writing the cache during render is safe because the cache is never trusted
  // on its own: it is validated against the current list on every use, so a
  // discarded render or a double invocation can cost one extra regroup and can
  // never produce groups that disagree with the messages on screen.
  const groupCache = useRef<{
    messages: WebState["messages"];
    streamRev: number;
    cache: TurnGroupCache;
  } | null>(null);
  const groups = useMemo(() => {
    const previous = groupCache.current;
    // Reuse the settled prefix only when the sequence itself proves the prefix
    // is unchanged: same object, or an ancestor whose first difference lands at
    // or past the boundary. The version counter is deliberately not consulted —
    // it is a per-tree value, and a session switch or a rebuild can put a
    // different conversation at its successor.
    const reusable = canReuseGroups(previous, messages);
    const settled = reusable && previous ? previous.cache : null;
    const next = buildTurnGroupsResumable(messages, settled);
    groupCache.current = { messages, streamRev, cache: next.cache };
    return next.groups;
  }, [messages, streamRev, streamDirtyFrom]);
  const groupsRef = useRef(groups);
  if (groups.length > 0) groupsRef.current = groups;
  const displayGroups = groups.length > 0 ? groups : groupsRef.current;
  const lastGroupId = displayGroups[displayGroups.length - 1]?.id;
  const isEmpty = messages.length === 0;

  const renderOther = useCallback((message: UiMessage) => {
    if (message.role === "toolResult") {
      return (
        <OrphanToolResult
          message={message}
          tools={toolExecutions}
          attachedToolIds={attachedToolIds}
        />
      );
    }
    if (message.role === "fileMention") {
      const path = message.path?.trim();
      if (!path) return null;
      const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
      return (
        <div
          className="text-muted-foreground flex items-center gap-1.5 text-xs"
          title={path}
        >
          <FileIcon className="size-3.5 shrink-0" />
          <span className="bg-muted max-w-[28rem] truncate rounded px-1.5 py-0.5 font-mono">
            {name}
          </span>
          <span className="shrink-0">文件引用</span>
        </div>
      );
    }
    return <NeutralMessage message={message} />;
  }, [toolExecutions, attachedToolIds]);

  const renderGroup = useCallback((group: TurnGroup) => {
    if (group.kind === "user") {
      return (
        <Message from="user" className="ml-auto w-fit max-w-[82%] gap-1">
          <MessageContent className="rounded-2xl rounded-br-sm border border-brand/20 bg-brand-soft/75 px-4 py-2.5 text-ink shadow-[0_1px_2px_rgba(27,54,93,0.06)]">
            <UserBlocks message={group.message} />
          </MessageContent>
        </Message>
      );
    }
    if (group.kind === "processing") {
      const waiting =
        group.streaming && group.totalSteps === 0 && group.body === "";
      return (
        <div className="flex w-full flex-col gap-3">
          {group.totalSteps > 0 && (
            <ProcessingSteps
              segments={group.segments}
              totalSteps={group.totalSteps}
              hasStreamingStep={group.hasStreamingStep}
              runningTools={group.runningTools}
              bodyFinished={group.bodyFinished}
              turnStreaming={isStepGroupActive({
                isLastGroup: group.id === lastGroupId,
                sessionStreaming: streaming,
                hasBody: Boolean(group.body.trim()),
                runningStepsOrTools:
                  group.hasStreamingStep || group.runningTools > 0,
              })}
              tools={toolExecutions}
            />
          )}
          {waiting ? (
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <SparklesIcon className="size-4 animate-pulse" />
              正在生成…
            </div>
          ) : null}
          {group.body ? (
            <Message from="assistant" className="mr-auto w-fit max-w-[92%] gap-1">
              <MessageContent className="w-full rounded-2xl rounded-bl-sm border border-border bg-card px-5 py-3.5 text-card-foreground shadow-[0_1px_2px_rgba(20,20,19,0.04)]">
                <IncremarkMessage streaming={!group.bodyFinished}>
                  {group.body}
                </IncremarkMessage>
              </MessageContent>
            </Message>
          ) : null}
        </div>
      );
    }
    if (group.kind === "terminal") {
      return <TerminalRun message={group.message} />;
    }
    if (group.kind === "boundary") {
      return <BoundarySummary message={group.message} />;
    }
    return renderOther(group.message);
  }, [lastGroupId, streaming, toolExecutions, renderOther]);

  return (
    <WindowedScroll
      items={displayGroups}
      stablePrefix={groups === displayGroups ? groupCache.current?.cache.sealed : undefined}
      getKey={groupKey}
      renderItem={renderGroup}
      className="min-h-0 flex-1"
      contentClassName={
        isEmpty
          ? "mx-auto w-full max-w-[var(--chat-max-w)] px-4"
          : "mx-auto w-full max-w-[var(--chat-max-w)] space-y-5 px-4 pb-12 pt-3"
      }
      running={streaming}
      runningTail={100000}
      page={100000}
      autoFollow
      canLoadEarlier={Boolean(hasMoreHistory)}
      empty={
        isEmpty ? (
          <ConversationEmptyState
            icon={
              <span aria-hidden className="text-3xl leading-none">
                🐘
              </span>
            }
            title={streaming ? "Herdchestra 正在准备回复" : "会话是空的"}
            description="基于 DeerFlow 的集成工作台。在下方输入，Enter 发送，Shift+Enter 换行。"
          />
        ) : displayGroups.length === 0 ? (
          <div className="text-muted-foreground flex items-center gap-2 px-1 py-6 text-sm">
            <SparklesIcon className="size-4 animate-pulse" />
            {streaming ? "正在生成…" : "正在准备会话…"}
          </div>
        ) : undefined
      }
      footer={
        earlierNotice ? (
          <div className="text-muted-foreground border-t px-4 py-1.5 text-center text-xs">
            {earlierNotice}
          </div>
        ) : null
      }
      onNeedEarlier={async () => {
        const before = resolveHistoryCursor(historyOldestId, messages);
        if (!before || !onLoadHistory) return false;
        const loaded = await onLoadHistory(before);
        if (loaded) setEarlierNotice("已加载更早消息，继续上滚查看");
        return loaded;
      }}
    />
  );
}

export const ConversationView = memo(
  ConversationViewInner,
  (previous, next) =>
    previous.messages === next.messages &&
    previous.streamRev === next.streamRev &&
    previous.streamDirtyFrom === next.streamDirtyFrom &&
    previous.toolExecutions === next.toolExecutions &&
    previous.streaming === next.streaming &&
    previous.onLoadHistory === next.onLoadHistory &&
    previous.hasMoreHistory === next.hasMoreHistory &&
    previous.historyOldestId === next.historyOldestId,
);
