import { useEffect, useMemo, useState } from "react";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { selectModelKey } from "../protocol/store";
import {
  groupModelsByProvider,
  modelNickname,
  type ModelGroup,
} from "../lib/model-display";
import type { ModelRef } from "../protocol/types";

type Props = {
  modelKey: string;
  models: ModelRef[];
  disabled?: boolean;
  onModel: (provider: string, id: string) => void;
};

function providerOf(model: ModelRef | null | undefined): string {
  const raw = (model?.provider || "other").trim();
  return raw.split("/")[0] || raw || "other";
}

export function ModelPickerDialog({ modelKey, models, disabled, onModel }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeProvider, setActiveProvider] = useState("");

  const selected =
    models.find((model) => selectModelKey(model) === modelKey) ??
    (modelKey
      ? ({
          provider: modelKey.split("/")[0] ?? "",
          id: modelKey.split("/").slice(1).join("/") || modelKey,
          name: modelKey.split("/").pop() ?? modelKey,
        } as ModelRef)
      : null);
  const allModels = useMemo(
    () =>
      selected && !models.some((model) => selectModelKey(model) === modelKey)
        ? [...models, selected]
        : models,
    [models, modelKey, selected],
  );
  const groups = useMemo(
    () => groupModelsByProvider(allModels, selected),
    [allModels, selected],
  );
  const currentProvider = providerOf(selected);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveProvider(currentProvider || groups[0]?.provider || "");
    // Only reset when the dialog opens; typing must not wipe the query.
  }, [open]);

  const needle = query.trim().toLowerCase();
  const matches = (model: ModelRef) => {
    if (!needle) return true;
    const label = modelNickname(model, allModels).toLowerCase();
    const key = selectModelKey(model).toLowerCase();
    return label.includes(needle) || key.includes(needle);
  };
  const searching = needle.length > 0;
  const visibleGroups: ModelGroup[] = searching
    ? groups
        .map((group) => ({ ...group, models: group.models.filter(matches) }))
        .filter((group) => group.models.length > 0)
    : groups.filter((group) => group.provider === activeProvider);
  const firstMatch = visibleGroups[0]?.models[0];

  const choose = (model: ModelRef) => {
    onModel(model.provider, model.id);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="选择模型"
          title={modelNickname(selected, allModels) || undefined}
          className="hover:bg-accent/60 flex h-7 max-w-[240px] items-center gap-1 rounded-md px-2 text-xs disabled:pointer-events-none disabled:opacity-50"
        >
          <span className="truncate">{modelNickname(selected, allModels) || "模型"}</span>
          <ChevronDownIcon className="text-muted-foreground size-3 shrink-0" />
        </button>
      </DialogTrigger>
      <DialogContent className="bg-card border-border text-foreground gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="text-sm">选择模型</DialogTitle>
        </DialogHeader>
        <div className="border-b px-3 py-2">
          <div className="bg-muted/40 flex items-center gap-2 rounded-md px-2">
            <SearchIcon className="text-muted-foreground size-3.5 shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && firstMatch) {
                  event.preventDefault();
                  choose(firstMatch);
                }
              }}
              placeholder="搜索模型或供应商…"
              aria-label="搜索模型"
              className="placeholder:text-muted-foreground/60 h-8 w-full bg-transparent text-xs outline-none"
            />
          </div>
        </div>
        <div className="grid h-[380px] max-h-[60vh] grid-cols-1 sm:grid-cols-[180px_1fr]">
          <div className="border-border/70 min-h-0 overflow-y-auto border-b p-2 sm:border-b-0 sm:border-r">
            {groups.map((group) => (
              <button
                key={group.provider}
                type="button"
                onClick={() => {
                  setQuery("");
                  setActiveProvider(group.provider);
                }}
                className={`mb-0.5 flex w-full items-center justify-between gap-2 rounded-md border-l-2 px-2.5 py-1.5 text-left text-xs ${
                  !searching && group.provider === activeProvider
                    ? "bg-accent border-brand font-medium"
                    : "hover:bg-accent/50 border-transparent"
                }`}
              >
                <span className="truncate">{group.provider}</span>
                <span className="text-muted-foreground/60 text-[10px] tabular-nums">
                  {group.models.length}
                </span>
              </button>
            ))}
          </div>
          <div className="min-h-0 overflow-y-auto p-1.5">
            {visibleGroups.length === 0 ? (
              <p className="text-muted-foreground px-3 py-6 text-xs">没有匹配的模型</p>
            ) : (
              visibleGroups.map((group) => (
                <div key={group.provider} className="mb-1">
                  {searching && (
                    <p className="text-muted-foreground/70 px-2.5 pt-2 pb-1 text-[10px] font-medium tracking-wide">
                      {group.provider}
                    </p>
                  )}
                  {group.models.map((model) => {
                    const key = selectModelKey(model);
                    const active = key === modelKey;
                    const label = modelNickname(model, allModels);
                    const sub = model.id.includes("/")
                      ? model.id.split("/").slice(0, -1).join("/")
                      : "";
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => choose(model)}
                        title={`${model.provider}/${model.id}`}
                        className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left hover:bg-accent/60 ${
                          active ? "bg-accent/70" : ""
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs">{label}</span>
                          {sub && (
                            <span className="text-muted-foreground/70 block truncate text-[11px]">
                              {sub}
                            </span>
                          )}
                        </span>
                        {active && <CheckIcon className="text-brand size-3.5 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
