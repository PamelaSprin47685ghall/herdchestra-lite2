import { memo, useEffect, useRef, useState } from "react";
import {
  ArrowUpIcon,
  CircleStopIcon,
  Loader2Icon,
  SendIcon,
  SparklesIcon,
} from "lucide-react";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputController,
} from "@herd/deer-flow-ui/ai-elements/prompt-input";
import { Button } from "@herd/deer-flow-ui/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@herd/deer-flow-ui/ui/tooltip";
import { ModelControlsBar } from "./composer/model-controls";
import { CompletionMenu, QueueChips } from "./composer/overlays";
import type { CompletionState, DraftState, ModelRef, WebState } from "../protocol/types";
import type { InstanceCapabilities } from "../lib/instance-capabilities";
import { resolveComposerSubmit } from "../lib/composer-action";

export type SubmitMode = "default" | "steer" | "followUp";

type ComposerProps = {
  draft: DraftState;
  models: ModelRef[];
  modelKey: string;
  thinkingLevel: string | null;
  thinkingLevels: string[];
  modes: WebState["modes"];
  streaming: boolean;
  working: string | null;
  disabled: boolean;
  capabilities: InstanceCapabilities | null;
  queue: { steering: string[]; followUp: string[] };
  completion: CompletionState;
  onKeys: (data: string) => void;
  onDraft: (text: string) => void;
  onSubmit: (text: string, mode?: SubmitMode, attachments?: { name: string; mimeType: string; data: string }[]) => Promise<void>;
  onAbort: () => void;
  onModel: (provider: string, modelId: string) => void;
  onThinking: (level: string) => void;
  onMode: (mode: "plan" | "vibe", action: "enter" | "exit") => void;
};

function ComposerForm({
  draft,
  models,
  modelKey,
  thinkingLevel,
  thinkingLevels,
  modes,
  streaming,
  working,
  capabilities,
  queue,
  blocked,
  completion,
  onKeys,
  onDraft,
  onSubmit,
  onAbort,
  onModel,
  onThinking,
  onMode,
}: Omit<ComposerProps, "disabled"> & { blocked: boolean }) {
  const controller = usePromptInputController();
  const [composing, setComposing] = useState(false);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const syncedRev = useRef<number | null>(null);
  // A remote draft is data, not typing. Only a real change event may report the
  // composer back to the host; deriving that from `text` treats the host's own
  // slash-mode rewrite as user input and bounces "" and "/" between the sides.
  const userEdited = useRef(false);
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  const text = controller.textInput.value;
  const completionRef = useRef(completion);
  completionRef.current = completion;
  const onKeysRef = useRef(onKeys);
  onKeysRef.current = onKeys;

  useEffect(() => {
    // Native listener, not React's synthetic one: the shared PromptInputTextarea
    // is bundled from DeerFlow and does not reliably forward our onKeyDown.
    // The ref keeps the newest completion state without rebinding per render.
    const el = document.querySelector<HTMLTextAreaElement>('[data-omp-completion="1"]');
    if (!el) return;
    const handler = (event: KeyboardEvent) => {
      const current = completionRef.current;
      if (!current.open || current.items.length === 0 || event.isComposing) return;
      const arrows: Record<string, string> = {
        ArrowUp: "\u001b[A",
        ArrowDown: "\u001b[B",
      };
      let key: string | null = arrows[event.key] ?? null;
      if (key === null && event.key === "Tab") key = "\t";
      if (key === null && event.key === "Escape") key = "\u001b";
      if (key === null && event.key === "Enter" && !event.shiftKey) key = "\r";
      if (key === null) return;
      event.preventDefault();
      event.stopPropagation();
      onKeysRef.current(key);
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  });

  useEffect(() => {
    if (draft.rev === syncedRev.current) return;
    syncedRev.current = draft.rev;
    if (draft.origin === "web") return;
    // Slash mode can leave the host buffer empty while the web composer still
    // holds the token. Keep the token so deleting it can close both menus.
    if (draft.text === "" && controller.textInput.value.startsWith("/")) return;
    if (controller.textInput.value !== draft.text) {
      userEdited.current = false;
      controller.textInput.setInput(draft.text);
    }
  }, [controller, draft.rev, draft.origin, draft.text]);

  useEffect(() => {
    // Only report a render the user caused. The remote write above also changes
    // `text`; reporting that render sends the host its own value back and lets
    // the slash-mode rewrite alternate "" and "/" forever.
    if (!userEdited.current) return;
    // Deleting "/" must reach the host even when its empty rewrite already
    // landed; otherwise both autocomplete popups stay open.
    const closingSlash = completionRef.current.open && text === "";
    if (composing || (!closingSlash && text === draft.text)) return;
    const timer = setTimeout(() => {
      userEdited.current = false;
      onDraftRef.current(text);
    }, 80);
    return () => clearTimeout(timer);
  }, [composing, text, draft.text]);

  const sendWithAttachments = async (value: string, mode: SubmitMode) => {
    const clean = value.trim();
    if (!clean && !attachments.length) {
      if (streaming || working) onAbort();
      return;
    }
    if (capabilities?.canSlashCommands === false && /^[\s]*[\/!$]/.test(value)) {
      setAttachmentError("此实例不支持斜杠命令或终端命令。");
      return;
    }
    if (capabilities?.canAttachments === false && attachments.length) {
      setAttachmentError("此实例不支持附件，请先移除附件。");
      return;
    }
    const submittedFiles = attachments;
    try {
      const encoded = await Promise.all(submittedFiles.map(async (file) => {
        const { promise, resolve, reject } = Promise.withResolvers<string>();
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
        reader.onerror = () => reject(new Error("读取附件失败"));
        reader.readAsDataURL(file);
        return { name: file.name, mimeType: file.type || "text/plain", data: await promise };
      }));
      const effectiveMode =
        mode === "default" && (streaming || Boolean(working)) ? "steer" : mode;
      await onSubmit(clean, effectiveMode, encoded);
      setAttachments((current) => current.filter((file) => !submittedFiles.includes(file)));
      setAttachmentError("");
      if (effectiveMode !== "default" && controller.textInput.value === value) controller.textInput.clear();
    } catch (error) {
      const message = error instanceof Error ? error.message : "提交失败";
      setAttachmentError(message.includes("submission_unconfirmed")
        ? "已交给输入框，结果未知；请检查会话后再重试，避免重复发送。附件已保留。"
        : message);
      throw error;
    }
  };

  const levels =
    thinkingLevel && !thinkingLevels.includes(thinkingLevel)
      ? [thinkingLevel, ...thinkingLevels]
      : thinkingLevels;

  return (
    <div className="mx-auto w-full max-w-[var(--chat-max-w)] px-4 pb-3">
      {working && (
        <div className="text-muted-foreground mb-1.5 flex items-center gap-2 text-xs">
          <Loader2Icon className="size-3 animate-spin text-sky-400" />
          <span className="truncate">{working}</span>
        </div>
      )}
      <QueueChips queue={queue} />
      <CompletionMenu completion={completion} text={text} onKeys={onKeys} />
      <PromptInput
        onSubmit={({ text: submitted }) => sendWithAttachments(submitted, "default")}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        className="[&_[data-slot=input-group]]:rounded-2xl [&_[data-slot=input-group]]:border [&_[data-slot=input-group]]:bg-card [&_[data-slot=input-group]]:shadow-sm"
      >
        {(attachments.length > 0 || attachmentError) && (
          <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2 text-xs">
            {attachments.map((file, index) => (
              <span
                key={`${file.name}-${index}`}
                className="inline-flex max-w-[12rem] items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-0.5 text-xs"
                title={file.name}
              >
                <span className="truncate">{file.name}</span>
                <button
                  type="button"
                  className="text-muted-foreground shrink-0 hover:text-foreground"
                  aria-label={`移除 ${file.name}`}
                  onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
                >
                  ×
                </button>
              </span>
            ))}
            {attachmentError && <span role="alert" className="text-destructive">{attachmentError}</span>}
          </div>
        )}
        <PromptInputBody>
          <PromptInputTextarea
            data-omp-completion="1"
            placeholder="写给 Herdchestra…  Enter 发送，Shift+Enter 换行"
            onChange={() => {
              userEdited.current = true;
            }}
            className="min-h-16 px-4 pt-3 text-sm"
            disabled={blocked}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                Boolean(streaming || working) &&
                !text.trim() &&
                attachments.length === 0
              ) {
                event.preventDefault();
                onAbort();
              }
            }}
          />
        </PromptInputBody>
        <PromptInputFooter className="flex-nowrap gap-1.5 px-2 pb-2">
          <PromptInputTools className="min-w-0 flex-1 flex-wrap gap-y-1 sm:flex-nowrap sm:gap-y-0">
            <label
              className={`inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs hover:bg-accent/60 sm:px-2 ${blocked || capabilities?.canAttachments === false ? "pointer-events-none opacity-50" : ""}`}
              aria-label="添加附件"
              title={capabilities?.canAttachments === false ? "此实例不支持附件" : "添加附件"}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-3.5" aria-hidden="true">
                <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
              <span className="hidden sm:inline">Attach</span>
              <input
                type="file"
                className="hidden"
                disabled={blocked || capabilities?.canAttachments === false}
                multiple
                accept="image/png,image/jpeg,image/gif,image/webp,text/*,application/json,application/ld+json,application/xml,application/yaml,application/x-yaml,application/javascript"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  if (files.length > 10 || files.some((file) => file.size > 5 * 1024 * 1024) || files.reduce((n, file) => n + file.size, 0) > 10 * 1024 * 1024) {
                    setAttachmentError("附件超过大小限制");
                    return;
                  }
                  setAttachments(files);
                  setAttachmentError("");
                }}
              />
            </label>
            <ModelControlsBar
              modelKey={modelKey}
              models={models}
              thinkingLevel={thinkingLevel}
              thinkingLevels={levels}
              modes={modes}
              disabled={blocked}
              onModel={onModel}
              onThinking={onThinking}
              onMode={onMode}
            />
          </PromptInputTools>
          <PromptInputTools className="ml-auto flex-none [order:4]">
            {(() => {
              const hasContent = Boolean(text.trim() || attachments.length);
              const action = resolveComposerSubmit({
                working: Boolean(streaming || working),
                hasContent,
              });
              if (action === "stop") {
                return (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="icon"
                        className="size-8 rounded-full"
                        aria-label="停止生成"
                        title="停止生成"
                        onClick={onAbort}
                      >
                        <CircleStopIcon className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>停止生成（Enter）</TooltipContent>
                  </Tooltip>
                );
              }
              return (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="submit"
                      size="icon"
                      className="size-8 rounded-full"
                      disabled={blocked || action === "disabled"}
                      aria-label={action === "steer" ? "追加指令" : "发送"}
                      title={action === "steer" ? "发送并引导当前运行（Steer）" : "发送（Enter）"}
                    >
                      {action === "steer" ? (
                        <ArrowUpIcon className="size-4" />
                      ) : (
                        <SendIcon className="size-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {action === "steer" ? "发送并引导当前运行（Steer）" : "发送（Enter）"}
                  </TooltipContent>
                </Tooltip>
              );
            })()}
          </PromptInputTools>
        </PromptInputFooter>
      </PromptInput>
      {(() => {
        const hints = [
          capabilities?.canAttachments === false ? "此实例不支持附件" : null,
          capabilities?.canSlashCommands === false
            ? "此实例不支持斜杠命令、! 与 $ 终端命令"
            : null,
        ].filter(Boolean);
        if (!hints.length) return null;
        return (
          <p className="text-muted-foreground mt-1 px-1 text-[10px]">
            <SparklesIcon className="mr-1 inline size-3" />
            {hints.join("；")}
          </p>
        );
      })()}
    </div>
  );
}

function composerPropsEqual(a: ComposerProps, b: ComposerProps) {
  return (
    a.draft.rev === b.draft.rev &&
    a.draft.text === b.draft.text &&
    a.draft.origin === b.draft.origin &&
    a.modelKey === b.modelKey &&
    a.models === b.models &&
    a.thinkingLevel === b.thinkingLevel &&
    a.thinkingLevels === b.thinkingLevels &&
    a.modes === b.modes &&
    a.streaming === b.streaming &&
    a.working === b.working &&
    a.disabled === b.disabled &&
    a.capabilities === b.capabilities &&
    a.queue === b.queue &&
    a.completion === b.completion &&
    a.onKeys === b.onKeys &&
    a.onDraft === b.onDraft &&
    a.onSubmit === b.onSubmit &&
    a.onAbort === b.onAbort &&
    a.onModel === b.onModel &&
    a.onThinking === b.onThinking &&
    a.onMode === b.onMode
  );
}

export const ComposerDock = memo(function ComposerDock(props: ComposerProps) {
  const blocked = props.disabled || props.capabilities?.canCompose === false;
  return (
    <div className="shrink-0 border-t pt-2">
      {blocked ? (
        <div
          className="text-muted-foreground flex items-center gap-2 border-b px-4 py-2 text-xs"
          role="status"
        >
          {props.disabled ? (
            <>
              <Loader2Icon className="size-3.5 animate-spin" />
              正在启动或连接会话…
            </>
          ) : (
            "此实例不支持发送消息。"
          )}
        </div>
      ) : null}
      <PromptInputProvider initialInput={props.draft.text}>
        <ComposerForm {...props} blocked={blocked} />
      </PromptInputProvider>
    </div>
  );
}, composerPropsEqual);
