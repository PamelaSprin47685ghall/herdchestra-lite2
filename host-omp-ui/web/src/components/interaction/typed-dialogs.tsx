import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { BadgeCheckIcon } from "lucide-react";
import { MessageResponse } from "@herd/deer-flow-ui/ai-elements/message";
import { Badge } from "@herd/deer-flow-ui/ui/badge";
import { Button } from "@herd/deer-flow-ui/ui/button";
import { Input } from "@herd/deer-flow-ui/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@herd/deer-flow-ui/ui/select";
import { Textarea } from "@herd/deer-flow-ui/ui/textarea";
import { asNumber, asString, isRecord } from "../../protocol/guards";
import { stripAnsi } from "../../protocol/tool-view";
import type { InteractionRequest } from "../../protocol/types";
import {
  normalizeChoices,
  payloadRecord,
  payloadText,
  titleOf,
  type Respond,
} from "./shared";

export function DialogFooter({
  item,
  onRespond,
  children,
}: {
  item: InteractionRequest;
  onRespond: Respond;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {children}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => onRespond(item.id, { cancelled: true })}
      >
        取消
      </Button>
    </div>
  );
}

export function ApproveCard({
  item,
  onRespond,
}: {
  item: InteractionRequest;
  onRespond: Respond;
}) {
  const payload = payloadRecord(item);
  const full =
    asString(payload.full) ||
    asString(payload.message) ||
    asString(payload.question) ||
    payloadText(item);
  const choices = normalizeChoices(payload.choices);
  const fallback = [
    { label: "允许本次", value: "once" },
    ...(asString(payload.session)
      ? [{ label: asString(payload.session), value: "session" }]
      : []),
    { label: "拒绝", value: "deny" },
  ];
  const finalChoices = choices.length ? choices : fallback;
  return (
    <div className="space-y-3">
      {asString(payload.reason) && (
        <p className="text-sm">{asString(payload.reason)}</p>
      )}
      {full && (
        <pre className="bg-muted/40 max-h-72 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap">
          {stripAnsi(full)}
        </pre>
      )}
      <div className="flex flex-wrap gap-2">
        {finalChoices.map((choice) => (
          <Button
            key={choice.value}
            type="button"
            size="sm"
            disabled={choice.disabled}
            variant={
              choice.value === "deny" || choice.value.startsWith("grant:")
                ? "outline"
                : "default"
            }
            onClick={() =>
              onRespond(item.id, { value: choice.value, choice: choice.value })
            }
          >
            {choice.value.startsWith("grant:") && (
              <BadgeCheckIcon className="mr-1 size-3.5" />
            )}
            {choice.label}
          </Button>
        ))}
      </div>
      {Array.isArray(payload.grants) && payload.grants.length > 0 && (
        <p className="text-muted-foreground text-[10px]">
          带记忆的选项会写入 Herdchestra 的审批缓存；TUI 端会立即关闭。
        </p>
      )}
      <DialogFooter item={item} onRespond={onRespond} />
    </div>
  );
}

export function SelectCard({
  item,
  onRespond,
}: {
  item: InteractionRequest;
  onRespond: Respond;
}) {
  const payload = payloadRecord(item);
  const options = normalizeChoices(payload.options ?? payload.choices);
  const initialIndex = asNumber(payload.initialIndex) ?? 0;
  const checkedIndices = Array.isArray(payload.checkedIndices)
    ? payload.checkedIndices.map(Number)
    : [];
  const marker = payload.selectionMarker;
  const markableCount = Math.max(0, Math.min(options.length, asNumber(payload.markableCount) ?? options.length));
  const details = Array.isArray(payload.optionDetails) ? payload.optionDetails : [];
  const [active, setActive] = useState(initialIndex);
  if (!options.length) {
    return (
      <div className="space-y-2">
        <p className="text-muted-foreground text-sm">
          这个选择框没有可用的选项；请使用 TUI overlay 完成。
        </p>
        <DialogFooter item={item} onRespond={onRespond} />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {asString(payload.message) && (
        <p className="text-sm">{asString(payload.message)}</p>
      )}
      <div className="space-y-1.5">
        {options.map((option, index) => {
          // omp's select resolves one option at a time, including checkbox
          // toggles. The caller reopens it with authoritative checkedIndices;
          // do not accumulate a separate selection or invent an array result.
          const isMarkable = marker !== undefined && index < markableCount;
          const marked = marker === "checkbox"
            ? checkedIndices.includes(index)
            : marker === "radio" && active === index;
          const optionDetail = isRecord(details[index]) ? details[index] : {};
          const description = option.description || asString(optionDetail.description);
          return (
            <button
              key={`${option.value}-${index}`}
              type="button"
              disabled={option.disabled}
              className={`hover:bg-muted/60 flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition-colors ${
                active === index ? "ring-ring/40 ring-2" : ""
              }`}
              onMouseEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onClick={() =>
                onRespond(item.id, { value: option.value, choice: option.value })
              }
            >
              <span className="text-muted-foreground w-4 shrink-0 text-center text-xs" aria-hidden="true">
                {isMarkable ? (marker === "checkbox" ? (marked ? "☑" : "☐") : (marked ? "◉" : "○")) : ""}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block">{option.label}</span>
                {description && (
                  <span className="text-muted-foreground block text-xs">
                    {description}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {asString(payload.helpText) && (
        <p className="text-muted-foreground text-xs">{asString(payload.helpText)}</p>
      )}
      <DialogFooter item={item} onRespond={onRespond} />
    </div>
  );
}

export function ConfirmCard({
  item,
  onRespond,
}: {
  item: InteractionRequest;
  onRespond: Respond;
}) {
  const payload = payloadRecord(item);
  return (
    <div className="space-y-3">
      <p className="text-sm">
        {asString(payload.message) || asString(payload.question) || titleOf(item)}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          autoFocus
          onClick={() => onRespond(item.id, { value: true })}
        >
          确认
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onRespond(item.id, { value: false, cancelled: true })}
        >
          取消
        </Button>
      </div>
    </div>
  );
}

export function InputCard({
  item,
  onRespond,
}: {
  item: InteractionRequest;
  onRespond: Respond;
}) {
  const payload = payloadRecord(item);
  const [value, setValue] = useState(
    asString(payload.value ?? payload.initialValue ?? payload.prefill),
  );
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onRespond(item.id, { value });
      }}
    >
      <p className="text-sm">{titleOf(item)}</p>
      <Input
        autoFocus
        type={payload.secret === true ? "password" : "text"}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={asString(payload.placeholder) || undefined}
      />
      <DialogFooter item={item} onRespond={onRespond}>
        <Button type="submit" size="sm">
          提交
        </Button>
      </DialogFooter>
    </form>
  );
}

export function EditorCard({
  item,
  onRespond,
}: {
  item: InteractionRequest;
  onRespond: Respond;
}) {
  const payload = payloadRecord(item);
  const [value, setValue] = useState(
    asString(payload.prefill ?? payload.value ?? payload.initialValue),
  );
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onRespond(item.id, { value });
      }}
    >
      <p className="text-sm">{titleOf(item)}</p>
      <Textarea
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            onRespond(item.id, { value });
          }
        }}
        className="min-h-40 font-mono text-sm"
      />
      <DialogFooter item={item} onRespond={onRespond}>
        <Button type="submit" size="sm">
          提交（⌘/Ctrl+Enter）
        </Button>
      </DialogFooter>
    </form>
  );
}

export function PlanReviewCard({
  item,
  onRespond,
}: {
  item: InteractionRequest;
  onRespond: Respond;
}) {
  const payload = payloadRecord(item);
  const plan = asString(
    payload.planContent ?? payload.plan ?? payload.summary ?? payload.message,
  );
  const rawOptions = Array.isArray(payload.options) ? payload.options : [];
  const fallbackOptions = [
    { id: "execute", label: "Execute", disabled: false },
    { id: "compact", label: "Compact", disabled: false },
    { id: "keep", label: "Keep", disabled: false },
    { id: "refine", label: "Refine", disabled: false },
    { id: "save", label: "Save", disabled: false },
  ];
  const options = rawOptions.length
    ? rawOptions
        .map((raw) => {
          if (!isRecord(raw)) return null;
          const id = asString(raw.id);
          if (!id) return null;
          return {
            id,
            label: asString(raw.label, id),
            disabled: Boolean(raw.disabled),
          };
        })
        .filter(
          (option): option is { id: string; label: string; disabled: boolean } =>
            option !== null,
        )
    : fallbackOptions;
  const tiers = Array.isArray(payload.tiers)
    ? payload.tiers
        .map((raw) => {
          if (!isRecord(raw)) return null;
          const role = asString(raw.role);
          if (!role) return null;
          return {
            role,
            label: `${asString(raw.provider)}/${asString(raw.model)}${
              asString(raw.thinkingLevel) ? ` · ${asString(raw.thinkingLevel)}` : ""
            }`,
          };
        })
        .filter((tier): tier is { role: string; label: string } => tier !== null)
    : [];
  const [role, setRole] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState<string | null>(null);

  const choose = (choice: string) => {
    if (choice === "refine") {
      setPending("refine");
      return;
    }
    const input: Record<string, unknown> = {};
    if (role && (choice === "execute" || choice === "compact" || choice === "keep")) {
      input.role = role;
    }
    onRespond(item.id, {
      choice,
      input: Object.keys(input).length ? input : undefined,
    });
  };

  const submitRefine = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!feedback.trim()) {
      setError("Refine 需要填写反馈内容。");
      return;
    }
    setError(null);
    onRespond(item.id, {
      choice: "refine",
      input: { feedback: feedback.trim() },
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">
          {asString(payload.title, "计划评审")}
        </p>
        {asString(payload.planFilePath) && (
          <Badge variant="outline" className="font-mono text-[10px]">
            {asString(payload.planFilePath)}
          </Badge>
        )}
      </div>
      {plan ? (
        <div className="bg-muted/30 max-h-80 overflow-auto rounded-lg border p-3 text-sm">
          <MessageResponse>{plan}</MessageResponse>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">计划内容为空。</p>
      )}
      {tiers.length > 0 && (
        <label className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">执行档位</span>
          <Select
            value={role || "__default__"}
            onValueChange={(value) => setRole(value === "__default__" ? "" : value)}
          >
            <SelectTrigger className="h-8 w-full max-w-[280px] min-w-0 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__" className="text-xs">
                使用 overlay 当前档位
              </SelectItem>
              {tiers.map((tier) => (
                <SelectItem key={tier.role} value={tier.role} className="text-xs">
                  {tier.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      )}
      {pending === "refine" ? (
        <form className="space-y-2" onSubmit={submitRefine}>
          <Textarea
            autoFocus
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="告诉 Herdchestra 如何修改计划…"
            className="min-h-24 text-sm"
          />
          {error && <p className="text-destructive text-xs">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm">
              提交反馈
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setPending(null);
                setError(null);
              }}
            >
              返回
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {options.map((option) => (
            <Button
              key={option.id}
              type="button"
              size="sm"
              disabled={option.disabled}
              variant={option.id === "execute" ? "default" : "outline"}
              onClick={() => choose(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
