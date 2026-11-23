import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpIcon,
  CircleStopIcon,
  CornerDownRightIcon,
  GitBranchIcon,
  Loader2Icon,
  SendIcon,
  SparklesIcon,
  ZapIcon,
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
import { Badge } from "@herd/deer-flow-ui/ui/badge";
import { Button } from "@herd/deer-flow-ui/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@herd/deer-flow-ui/ui/tooltip";
import { selectModeStatus, selectModelKey } from "../protocol/store";
import { formatThinkingLabel, groupModelsByProvider, modelNickname } from "../lib/model-display";
import { ModelPickerDialog } from "./ModelPickerDialog";
import type { DraftState, ModelRef, WebState } from "../protocol/types";
import type { InstanceCapabilities } from "../lib/instance-capabilities";

export type SubmitMode = "default" | "steer" | "followUp";

export type { ComposerAction } from "../lib/composer-action";
import {
  resolveComposerSubmit,
  type ComposerAction,
} from "../lib/composer-action";

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
  onDraft: (text: string) => void;
  onSubmit: (text: string, mode?: SubmitMode, attachments?: { name: string; mimeType: string; data: string }[]) => Promise<void>;
  onAbort: () => void;
  onModel: (provider: string, modelId: string) => void;
  onThinking: (level: string) => void;
  onMode: (mode: "plan" | "vibe", action: "enter" | "exit") => void;
};

function ModeToggle({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant={active ? "secondary" : "ghost"}
          className="h-7 gap-1 px-2 text-xs"
          onClick={onClick}
        >
          {icon}
          {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {active ? `退出 ${label} 模式` : `进入 ${label} 模式`}
      </TooltipContent>
    </Tooltip>
  );
}

type ModelControlsProps = {
  modelKey: string;
  models: ModelRef[];
  thinkingLevel: string | null;
  thinkingLevels: string[];
  modes: WebState["modes"];
  disabled: boolean;
  onModel: (provider: string, modelId: string) => void;
  onThinking: (level: string) => void;
  onMode: (mode: "plan" | "vibe", action: "enter" | "exit") => void;
};

function sameModels(a: ModelRef[], b: ModelRef[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((model, index) => {
    const other = b[index]!;
    return model.provider === other.provider && model.id === other.id && model.name === other.name;
  });
}

function modelControlsEqual(a: ModelControlsProps, b: ModelControlsProps) {
  return (
    a.modelKey === b.modelKey &&
    a.thinkingLevel === b.thinkingLevel &&
    a.disabled === b.disabled &&
    sameModels(a.models, b.models) &&
    a.thinkingLevels.length === b.thinkingLevels.length &&
    a.thinkingLevels.every((level, index) => level === b.thinkingLevels[index]) &&
    JSON.stringify(a.modes) === JSON.stringify(b.modes) &&
    a.onModel === b.onModel &&
    a.onThinking === b.onThinking &&
    a.onMode === b.onMode
  );
}

const ModelControlsBar = memo(function ModelControlsBar({
  modelKey,
  models,
  thinkingLevel,
  thinkingLevels,
  modes,
  disabled,
  onModel,
  onThinking,
  onMode,
}: ModelControlsProps) {
  const selectedKey = modelKey || "";
  const selectedModel =
    models.find((model) => selectModelKey(model) === selectedKey) ??
    (selectedKey
      ? ({
          provider: selectedKey.split("/")[0] ?? "",
          id: selectedKey.split("/").slice(1).join("/") || selectedKey,
          name: selectedKey.split("/").pop() ?? selectedKey,
        } as ModelRef)
      : null);
  const modelOptions =
    selectedModel && !models.some((model) => selectModelKey(model) === selectedKey)
      ? [...models, selectedModel]
      : models;
  const levels = thinkingLevels.length
    ? thinkingLevels
    : thinkingLevel
      ? [thinkingLevel]
      : [];
  const levelIndex = thinkingLevel ? Math.max(0, levels.indexOf(thinkingLevel)) : 0;
  const plan = selectModeStatus(modes, "plan");
  const vibe = selectModeStatus(modes, "vibe");
  const thinkingControl =
    levels.length === 0 ? null : levels.length === 1 ? (
      <span
        className="text-muted-foreground flex h-7 shrink-0 items-center px-2 text-xs whitespace-nowrap"
        title={`思考强度：${formatThinkingLabel(levels[0])}`}
      >
        {formatThinkingLabel(levels[0])}
      </span>
    ) : (
      <div
        className="flex h-7 shrink-0 items-center gap-2 px-2"
        title={`思考强度：${levels.map(formatThinkingLabel).join(" / ")}`}
      >
        <input
          type="range"
          min={0}
          max={levels.length - 1}
          step={1}
          value={Math.min(levelIndex, levels.length - 1)}
          onChange={(event) => {
            const next = levels[Number(event.target.value)];
            if (next) onThinking(next);
          }}
          disabled={disabled}
          aria-label="思考强度"
          className="h-1.5 w-20 cursor-pointer accent-[var(--brand)] disabled:cursor-not-allowed disabled:opacity-40"
        />
        <span className="text-muted-foreground min-w-[3.5rem] text-xs whitespace-nowrap">
          {formatThinkingLabel(thinkingLevel ?? levels[levelIndex] ?? levels[0])}
        </span>
      </div>
    );
  return (
    <>
      <div className="[order:-2]">
        <ModeToggle
          label="Plan"
          icon={<GitBranchIcon className="size-3.5" />}
          active={plan === "active"}
          onClick={() => onMode("plan", plan === "active" ? "exit" : "enter")}
        />
      </div>
      <div className="[order:-1]">
        <ModeToggle
          label="Vibe"
          icon={<ZapIcon className="size-3.5" />}
          active={vibe === "active"}
          onClick={() => onMode("vibe", vibe === "active" ? "exit" : "enter")}
        />
      </div>
      <div className="[order:1]">
        <ModelPickerDialog
          modelKey={selectedKey}
          models={modelOptions}
          disabled={disabled}
          onModel={onModel}
        />
      </div>
      <div className="[order:2]">{thinkingControl}</div>
    </>
  );
}, modelControlsEqual);

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
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  const text = controller.textInput.value;

  useEffect(() => {
    if (draft.rev === syncedRev.current) return;
    syncedRev.current = draft.rev;
    if (draft.origin === "web") return;
    if (controller.textInput.value !== draft.text) {
      controller.textInput.setInput(draft.text);
    }
  }, [controller, draft.rev, draft.origin, draft.text]);

  useEffect(() => {
    if (composing || text === draft.text) return;
    const timer = setTimeout(() => onDraftRef.current(text), 80);
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

  const plan = selectModeStatus(modes, "plan");
  const vibe = selectModeStatus(modes, "vibe");
  const queueCount = queue.steering.length + queue.followUp.length;
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
      {queueCount > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {queue.steering.map((item, index) => (
            <Badge
              key={`steer-${index}`}
              variant="secondary"
              className="max-w-[18rem] gap-1 text-[10px]"
              title={item}
            >
              <CornerDownRightIcon className="size-3" />
              <span className="truncate">steer: {item.slice(0, 48)}</span>
            </Badge>
          ))}
          {queue.followUp.map((item, index) => (
            <Badge
              key={`follow-${index}`}
              variant="outline"
              className="max-w-[18rem] gap-1 text-[10px]"
              title={item}
            >
              <span className="truncate">follow-up: {item.slice(0, 48)}</span>
            </Badge>
          ))}
        </div>
      )}
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
            placeholder="写给 omp…  Enter 发送，Shift+Enter 换行"
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
        <PromptInputFooter className="flex-wrap gap-1.5 px-2 pb-2">
          <PromptInputTools className="min-w-0 flex-wrap">
            <label
              className={`inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-xs hover:bg-accent/60 ${blocked || capabilities?.canAttachments === false ? "pointer-events-none opacity-50" : ""}`}
              aria-label="添加附件"
              title={capabilities?.canAttachments === false ? "此实例不支持附件" : "添加附件"}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-3.5" aria-hidden="true">
                <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
              Attach
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
              thinkingLevels={thinkingLevels}
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
