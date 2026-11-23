import { memo, type ReactNode } from "react";
import { GitBranchIcon, ZapIcon } from "lucide-react";
import { Button } from "@herd/deer-flow-ui/ui/button";
import { selectModeStatus, selectModelKey } from "../../protocol/store";
import { formatThinkingLabel } from "../../lib/model-display";
import { ModelPickerDialog } from "../ModelPickerDialog";
import type { ModelRef, WebState } from "../../protocol/types";

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
    <Button
      type="button"
      size="sm"
      variant={active ? "secondary" : "ghost"}
      className="h-7 shrink-0 gap-1 px-1.5 text-xs sm:px-2"
      aria-label={label}
      onClick={onClick}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </Button>
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

function synthesizeModel(key: string): ModelRef {
  const parts = key.split("/");
  return {
    provider: parts[0] ?? "",
    id: parts.slice(1).join("/") || key,
    name: parts[parts.length - 1] ?? key,
  } as ModelRef;
}

function modelControlsEqual(a: ModelControlsProps, b: ModelControlsProps) {
  return (
    a.modelKey === b.modelKey &&
    a.thinkingLevel === b.thinkingLevel &&
    a.disabled === b.disabled &&
    sameModels(a.models, b.models) &&
    a.thinkingLevels.length === b.thinkingLevels.length &&
    a.thinkingLevels.every((level, index) => level === b.thinkingLevels[index]) &&
    (a.modes === b.modes || JSON.stringify(a.modes) === JSON.stringify(b.modes)) &&
    a.onModel === b.onModel &&
    a.onThinking === b.onThinking &&
    a.onMode === b.onMode
  );
}

export const ModelControlsBar = memo(function ModelControlsBar({
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
  const knownModel = models.find((model) => selectModelKey(model) === selectedKey);
  const selectedModel =
    knownModel ?? (selectedKey ? synthesizeModel(selectedKey) : null);
  const modelOptions =
    selectedModel && !knownModel
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
        className="flex h-7 min-w-[52px] flex-1 shrink-0 items-center gap-1 px-1 sm:gap-2 sm:px-2"
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
          className="h-1.5 min-w-[44px] flex-1 cursor-pointer accent-[var(--brand)] disabled:cursor-not-allowed disabled:opacity-40 sm:max-w-[28vw]"
        />
        <span className="text-muted-foreground hidden text-xs whitespace-nowrap sm:inline sm:min-w-[3.5rem]">
          {formatThinkingLabel(thinkingLevel ?? levels[levelIndex] ?? levels[0])}
        </span>
      </div>
    );
  return (
    <>
      <div className="shrink-0 [order:-2]">
        <ModeToggle
          label="Plan"
          icon={<GitBranchIcon className="size-3.5" />}
          active={plan === "active"}
          onClick={() => onMode("plan", plan === "active" ? "exit" : "enter")}
        />
      </div>
      <div className="shrink-0 [order:-1]">
        <ModeToggle
          label="Vibe"
          icon={<ZapIcon className="size-3.5" />}
          active={vibe === "active"}
          onClick={() => onMode("vibe", vibe === "active" ? "exit" : "enter")}
        />
      </div>
      <div className="flex min-w-0 w-full items-center [order:1] sm:w-auto sm:flex-1">
        <ModelPickerDialog
          modelKey={selectedKey}
          models={modelOptions}
          disabled={disabled}
          onModel={onModel}
        />
        {thinkingControl}
      </div>
    </>
  );
}, modelControlsEqual);
