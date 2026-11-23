import {
  CircleHelpIcon,
  ClipboardListIcon,
  ListChecksIcon,
  MessageSquareIcon,
  ShieldAlertIcon,
  SparklesIcon,
  TextCursorInputIcon,
} from "lucide-react";
import { asString, isRecord } from "../../protocol/guards";
import type { InteractionRequest } from "../../protocol/types";

export type AnyRecord = Record<string, unknown>;
export type Respond = (requestId: string, payload: Record<string, unknown>) => void;

export function payloadRecord(item: InteractionRequest): AnyRecord {
  return isRecord(item.payload) ? item.payload : {};
}

export function payloadText(item: InteractionRequest): string {
  return typeof item.payload === "string" ? item.payload : "";
}

export const KIND_LABEL: Record<string, string> = {
  formDialog: "表单",
  askDialog: "Ask",
  approve: "工具审批",
  select: "选择",
  confirm: "确认",
  input: "输入",
  editor: "编辑器",
  plan_review: "Plan Review",
};

export function titleOf(item: InteractionRequest): string {
  const payload = payloadRecord(item);
  return (
    asString(payload.title) ||
    asString(payload.question) ||
    asString(payload.message) ||
    payloadText(item) ||
    KIND_LABEL[item.kind] ||
    item.kind
  );
}

export function KindIcon({ kind }: { kind: string }) {
  const className = "size-3.5";
  switch (kind) {
    case "approve":
      return <ShieldAlertIcon className={className} />;
    case "formDialog":
      return <ClipboardListIcon className={className} />;
    case "askDialog":
      return <CircleHelpIcon className={className} />;
    case "select":
      return <ListChecksIcon className={className} />;
    case "input":
    case "editor":
      return <TextCursorInputIcon className={className} />;
    case "plan_review":
      return <SparklesIcon className={className} />;
    default:
      return <MessageSquareIcon className={className} />;
  }
}

type Choice = {
  label: string;
  value: string;
  description?: string;
  disabled?: boolean;
};

export function normalizeChoices(raw: unknown): Choice[] {
  if (!Array.isArray(raw)) return [];
  const choices: Choice[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry) {
      choices.push({ label: entry, value: entry });
      continue;
    }
    if (!isRecord(entry)) continue;
    const label = asString(entry.label ?? entry.title ?? entry.value);
    if (!label) continue;
    const value = asString(entry.value ?? entry.id ?? label);
    choices.push({
      label,
      value,
      description: asString(entry.description) || undefined,
      disabled: Boolean(entry.disabled),
    });
  }
  return choices;
}
