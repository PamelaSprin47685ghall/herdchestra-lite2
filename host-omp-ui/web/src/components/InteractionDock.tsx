import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  BadgeCheckIcon,
  CircleHelpIcon,
  ClipboardListIcon,
  ListChecksIcon,
  MessageSquareIcon,
  ShieldAlertIcon,
  SparklesIcon,
  TextCursorInputIcon,
} from "lucide-react";
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
import { asNumber, asString, isRecord } from "../protocol/guards";
import { stripAnsi } from "../protocol/tool-view";
import type { InteractionError, InteractionRequest } from "../protocol/types";

type AnyRecord = Record<string, unknown>;
type Respond = (requestId: string, payload: Record<string, unknown>) => void;

/* ------------------------------------------------------------------ *
 * Shared readers
 * ------------------------------------------------------------------ */

function payloadRecord(item: InteractionRequest): AnyRecord {
  return isRecord(item.payload) ? item.payload : {};
}

function payloadText(item: InteractionRequest): string {
  return typeof item.payload === "string" ? item.payload : "";
}

function titleOf(item: InteractionRequest): string {
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

const KIND_LABEL: Record<string, string> = {
  formDialog: "表单",
  askDialog: "Ask",
  approve: "工具审批",
  select: "选择",
  confirm: "确认",
  input: "输入",
  editor: "编辑器",
  plan_review: "Plan Review",
};

function KindIcon({ kind }: { kind: string }) {
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

function normalizeChoices(raw: unknown): Array<{
  label: string;
  value: string;
  description?: string;
  disabled?: boolean;
}> {
  if (!Array.isArray(raw)) return [];
  const choices: Array<{
    label: string;
    value: string;
    description?: string;
    disabled?: boolean;
  }> = [];
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

/* ------------------------------------------------------------------ *
 * Form dialog
 * ------------------------------------------------------------------ */

type FormOption = { label: string; value: string };
type FormField = {
  name: string;
  label: string;
  question: string;
  type: string;
  required: boolean;
  placeholder?: string;
  options: FormOption[];
  allowOther: boolean;
  multiple: boolean;
  min?: string;
  max?: string;
  minlength?: string;
  maxlength?: string;
  pattern?: string;
  value?: string | string[];
  hidden?: boolean;
};

type FormValue = string | string[];

function normalizeField(raw: unknown): FormField | null {
  if (!isRecord(raw)) return null;
  const name = asString(raw.name);
  if (!name) return null;
  const rawOptions = Array.isArray(raw.options) ? raw.options : [];
  const options: FormOption[] = [];
  for (const entry of rawOptions) {
    if (!isRecord(entry)) continue;
    const value = asString(entry.value, asString(entry.label));
    if (!value) continue;
    options.push({ value, label: asString(entry.label, value) });
  }
  const value = Array.isArray(raw.value)
    ? raw.value.map(String)
    : typeof raw.value === "string"
      ? raw.value
      : undefined;
  return {
    name,
    label: asString(raw.label ?? raw.question, name),
    question: asString(raw.question ?? raw.label, name),
    type: asString(raw.type, "text"),
    required: raw.required === true,
    placeholder: asString(raw.placeholder) || undefined,
    options,
    allowOther: raw.allowOther === true,
    multiple: raw.multiple === true,
    min: asString(raw.min) || undefined,
    max: asString(raw.max) || undefined,
    minlength: asString(raw.minlength) || undefined,
    maxlength: asString(raw.maxlength) || undefined,
    pattern: asString(raw.pattern) || undefined,
    value,
    hidden: raw.hidden === true || raw.type === "hidden",
  };
}

function normalizeForm(payload: AnyRecord): {
  contexts: unknown[];
  fields: FormField[];
  defaults: AnyRecord;
} {
  const form = isRecord(payload.form) ? payload.form : {};
  return {
    contexts: Array.isArray(form.contexts) ? form.contexts : [],
    fields: Array.isArray(form.fields)
      ? form.fields
          .map(normalizeField)
          .filter((field): field is FormField => field !== null)
      : [],
    defaults: isRecord(form.defaults) ? form.defaults : {},
  };
}

function initialValues(fields: FormField[], defaults: AnyRecord): Record<string, FormValue> {
  const values: Record<string, FormValue> = {};
  for (const field of fields) {
    const fromDefaults = Object.prototype.hasOwnProperty.call(defaults, field.name)
      ? defaults[field.name]
      : undefined;
    const raw = fromDefaults ?? field.value;
    if (field.type === "checkbox" || (field.type === "select" && field.multiple)) {
      values[field.name] = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
    } else {
      values[field.name] = Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
    }
  }
  return values;
}

function optionLabel(field: FormField, value: string): string {
  return field.options.find((option) => option.value === value)?.label ?? value;
}

function fieldError(
  field: FormField,
  value: FormValue,
  other: string,
): string | undefined {
  if (field.hidden) return undefined;
  if (field.type === "radio") {
    if (value === "__other__") {
      if (!other.trim()) return "请填写“其他”内容";
      return undefined;
    }
    if (!value) return field.required ? "必填" : undefined;
    return undefined;
  }
  if (field.type === "checkbox") {
    const selected = Array.isArray(value) ? value : value ? [value] : [];
    if (!selected.length && !other.trim()) {
      return field.required ? "至少选择一项" : undefined;
    }
    return undefined;
  }
  if (field.type === "select") {
    const selected = Array.isArray(value) ? value : value ? [value] : [];
    if (!selected.length) return field.required ? "必填" : undefined;
    return undefined;
  }
  const text = typeof value === "string" ? value : value.join(",");
  if (!text.trim()) return field.required ? "必填" : undefined;
  if (field.type === "number") {
    const number = Number(text);
    if (!Number.isFinite(number)) return "请输入数字";
    if (field.min !== undefined && number < Number(field.min)) {
      return `不能小于 ${field.min}`;
    }
    if (field.max !== undefined && number > Number(field.max)) {
      return `不能大于 ${field.max}`;
    }
  }
  if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    return "请输入合法邮箱";
  }
  if (field.type === "url") {
    try {
      const url = new URL(text);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return "请输入 http(s) 链接";
      }
    } catch {
      return "请输入合法链接";
    }
  }
  if (field.minlength && text.length < Number(field.minlength)) {
    return `至少 ${field.minlength} 个字符`;
  }
  if (field.maxlength && text.length > Number(field.maxlength)) {
    return `最多 ${field.maxlength} 个字符`;
  }
  if (field.pattern) {
    try {
      if (!new RegExp(`^(?:${field.pattern})$`).test(text)) {
        return "格式不匹配";
      }
    } catch {
      // An invalid pattern is ignored, exactly as omp does.
    }
  }
  return undefined;
}

function serializeForm(
  fields: FormField[],
  values: Record<string, FormValue>,
  others: Record<string, string>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.name];
    const other = others[field.name]?.trim() ?? "";
    if (field.hidden) {
      const hidden = Array.isArray(value) ? value[0] : value;
      if (hidden !== undefined && hidden !== "") data[field.name] = hidden;
      continue;
    }
    if (field.type === "radio") {
      if (value === "__other__") {
        if (other) data[field.name] = other;
      } else if (typeof value === "string" && value) {
        data[field.name] = value;
      }
      continue;
    }
    if (field.type === "checkbox") {
      const selected = Array.isArray(value) ? [...value] : value ? [value] : [];
      if (other) selected.push(other);
      if (selected.length) data[field.name] = selected;
      continue;
    }
    if (field.type === "select") {
      if (field.multiple) {
        const selected = Array.isArray(value) ? value : value ? [value] : [];
        if (selected.length) data[field.name] = selected;
      } else if (typeof value === "string" && value) {
        data[field.name] = value;
      }
      continue;
    }
    if (typeof value === "string" && (value.trim() || field.required)) {
      data[field.name] = value;
    }
  }
  return data;
}

function Contexts({ contexts }: { contexts: unknown[] }) {
  if (!contexts.length) return null;
  return (
    <div className="text-muted-foreground space-y-2 text-sm">
      {contexts.map((raw, index) => {
        const context = isRecord(raw) ? raw : {};
        const type = asString(context.type);
        if (type === "list" && Array.isArray(context.items)) {
          return (
            <ul key={index} className="list-disc space-y-1 pl-5">
              {context.items.map((entry, itemIndex) => (
                <li key={itemIndex}>{String(entry)}</li>
              ))}
            </ul>
          );
        }
        if (type === "table" && Array.isArray(context.rows)) {
          return (
            <div key={index} className="overflow-auto">
              <table className="w-full border-collapse text-xs">
                <tbody>
                  {context.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-b">
                      {Array.isArray(row) &&
                        row.map((cell, cellIndex) => (
                          <td key={cellIndex} className="border px-2 py-1">
                            {String(cell)}
                          </td>
                        ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (type === "pre") {
          return (
            <pre
              key={index}
              className="bg-muted/40 max-h-48 overflow-auto rounded-md border p-2 font-mono text-xs whitespace-pre-wrap"
            >
              {asString(context.text)}
            </pre>
          );
        }
        return (
          <p key={index} className="whitespace-pre-wrap">
            {asString(context.text)}
          </p>
        );
      })}
    </div>
  );
}

function FormControl({
  field,
  value,
  other,
  error,
  onChange,
  onOther,
}: {
  field: FormField;
  value: FormValue;
  other: string;
  error?: string;
  onChange: (value: FormValue) => void;
  onOther: (value: string) => void;
}) {
  const label = (
    <span className="text-sm font-medium">
      {field.label}
      {field.required && <span className="text-destructive"> *</span>}
    </span>
  );
  if (field.hidden) return null;

  if (field.type === "radio" || field.type === "checkbox") {
    const selected = Array.isArray(value) ? value : value ? [value] : [];
    const isMulti = field.type === "checkbox";
    return (
      <fieldset className="space-y-2" aria-invalid={Boolean(error)}>
        <legend>{label}</legend>
        <div className="flex flex-col gap-1.5">
          {field.options.map((option) => (
            <label
              key={option.value}
              className="hover:bg-muted/40 flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm"
            >
              <input
                type={isMulti ? "checkbox" : "radio"}
                name={field.name}
                checked={
                  isMulti ? selected.includes(option.value) : value === option.value
                }
                onChange={() => {
                  if (isMulti) {
                    onChange(
                      selected.includes(option.value)
                        ? selected.filter((entry) => entry !== option.value)
                        : [...selected, option.value],
                    );
                  } else {
                    onChange(option.value);
                    onOther("");
                  }
                }}
                className="accent-primary"
              />
              <span>{option.label}</span>
            </label>
          ))}
          {field.allowOther && (
            <div className="hover:bg-muted/40 flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type={isMulti ? "checkbox" : "radio"}
                  name={field.name}
                  checked={isMulti ? Boolean(other) : value === "__other__"}
                  onChange={(event) => {
                    if (!event.target.checked) {
                      onChange(isMulti ? selected : "");
                      onOther("");
                      return;
                    }
                    if (!isMulti) onChange("__other__");
                  }}
                  className="accent-primary"
                />
                <span className="text-muted-foreground">其他</span>
              </label>
              <Input
                value={other}
                onChange={(event) => {
                  onOther(event.target.value);
                  if (!isMulti && event.target.value) onChange("__other__");
                }}
                placeholder="自由输入"
                className="h-7 flex-1 text-xs"
              />
            </div>
          )}
        </div>
        {error && <p className="text-destructive text-xs">{error}</p>}
      </fieldset>
    );
  }

  if (field.type === "select") {
    if (field.multiple) {
      return (
        <label className="block space-y-1">
          {label}
          <select
            multiple
            value={Array.isArray(value) ? value : value ? [value] : []}
            onChange={(event) =>
              onChange(
                Array.from(
                  event.currentTarget.selectedOptions,
                  (option) => option.value,
                ),
              )
            }
            className="border-input bg-background min-h-24 w-full rounded-md border px-2 py-1 text-sm"
          >
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {error && <p className="text-destructive text-xs">{error}</p>}
        </label>
      );
    }
    return (
      <label className="block space-y-1">
        {label}
        <Select
          value={typeof value === "string" && value ? value : undefined}
          onValueChange={onChange}
        >
          <SelectTrigger className="w-full" aria-invalid={Boolean(error)}>
            <SelectValue placeholder={field.placeholder ?? "请选择"} />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {error && <p className="text-destructive text-xs">{error}</p>}
      </label>
    );
  }

  if (field.type === "textarea") {
    return (
      <label className="block space-y-1">
        {label}
        <Textarea
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          aria-invalid={Boolean(error)}
          className="min-h-24"
        />
        {error && <p className="text-destructive text-xs">{error}</p>}
      </label>
    );
  }

  return (
    <label className="block space-y-1">
      {label}
      <Input
        type={
          field.type === "number" ||
          field.type === "date" ||
          field.type === "email" ||
          field.type === "url"
            ? field.type
            : "text"
        }
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.placeholder}
        aria-invalid={Boolean(error)}
      />
      {error && <p className="text-destructive text-xs">{error}</p>}
    </label>
  );
}

function FormDialogCard({
  item,
  error,
  onRespond,
}: {
  item: InteractionRequest;
  error?: InteractionError;
  onRespond: Respond;
}) {
  const payload = payloadRecord(item);
  const { contexts, fields, defaults } = useMemo(
    () => normalizeForm(payload),
    [payload],
  );
  const [values, setValues] = useState<Record<string, FormValue>>(() =>
    initialValues(fields, defaults),
  );
  const [others, setOthers] = useState<Record<string, string>>({});
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const serverErrors = error?.errors ?? {};
  const generalError =
    Object.keys(serverErrors).length > 0
      ? undefined
      : error?.message || (error?.code ? `提交失败：${error.code}` : undefined);

  useEffect(() => {
    setSubmitted(false);
  }, [error]);

  useEffect(() => {
    if (!submitted) return;
    const timer = setTimeout(() => setSubmitted(false), 2000);
    return () => clearTimeout(timer);
  }, [submitted]);

  if (!fields.length) {
    return (
      <div className="space-y-2">
        <p className="text-muted-foreground text-sm">
          这个表单没有可渲染的字段（HTML 原样内容不会注入页面）。
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onRespond(item.id, { cancelled: true })}
        >
          取消
        </Button>
      </div>
    );
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    for (const field of fields) {
      const message = fieldError(
        field,
        values[field.name] ?? "",
        others[field.name] ?? "",
      );
      if (message) nextErrors[field.name] = message;
    }
    setLocalErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    setSubmitted(true);
    onRespond(item.id, {
      data: serializeForm(fields, values, others),
    });
  };

  return (
    <form className="space-y-4" onSubmit={submit}>
      <Contexts contexts={contexts} />
      {generalError && (
        <p className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-sm">
          {generalError}
        </p>
      )}
      {Object.entries(serverErrors)
        .filter(([key]) => !fields.some((field) => field.name === key))
        .map(([key, message]) => (
          <p
            key={key}
            className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-xs"
          >
            {key}: {message}
          </p>
        ))}
      {fields.map((field) => (
        <FormControl
          key={field.name}
          field={field}
          value={values[field.name] ?? ""}
          other={others[field.name] ?? ""}
          error={localErrors[field.name] ?? serverErrors[field.name]}
          onChange={(value) =>
            setValues((current) => ({ ...current, [field.name]: value }))
          }
          onOther={(value) =>
            setOthers((current) => ({ ...current, [field.name]: value }))
          }
        />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={submitted}>
          {submitted ? "提交中…" : "提交"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onRespond(item.id, { cancelled: true })}
        >
          取消
        </Button>
        <span className="text-muted-foreground ml-auto text-[10px]">
          TUI 与 Web 先答者胜；约束由两端共同校验
        </span>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * Ask dialog
 * ------------------------------------------------------------------ */

type AskQuestion = {
  id: string;
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string; preview?: string }>;
  multi: boolean;
  recommended?: number;
};

function normalizeQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw)) return [];
  const questions: AskQuestion[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = asString(entry.id);
    if (!id) continue;
    const options = Array.isArray(entry.options)
      ? entry.options
          .map((option) => {
            if (typeof option === "string") return { label: option };
            if (!isRecord(option)) return null;
            const label = asString(option.label);
            return label
              ? {
                  label,
                  description: asString(option.description) || undefined,
                  preview: asString(option.preview) || undefined,
                }
              : null;
          })
          .filter(
            (option): option is { label: string; description?: string; preview?: string } =>
              option !== null,
          )
      : [];
    questions.push({
      id,
      question: asString(entry.question, id),
      header: asString(entry.header) || undefined,
      options,
      multi: entry.multi === true,
      recommended:
        typeof entry.recommended === "number" ? entry.recommended : undefined,
    });
  }
  return questions;
}

function AskDialogCard({
  item,
  onRespond,
}: {
  item: InteractionRequest;
  onRespond: Respond;
}) {
  const payload = payloadRecord(item);
  const questions = useMemo(
    () => normalizeQuestions(payload.questions ?? item.payload),
    [payload.questions, item.payload],
  );
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    for (const question of questions) {
      if (
        !(selected[question.id] ?? []).length &&
        !(custom[question.id] ?? "").trim()
      ) {
        setError(`请回答：${question.question}`);
        return;
      }
    }
    setError(null);
    onRespond(item.id, {
      answers: questions.map((question) => ({
        id: question.id,
        question: question.question,
        options: question.options.map((option) => option.label),
        multi: question.multi,
        selectedOptions: selected[question.id] ?? [],
        customInput: (custom[question.id] ?? "").trim() || undefined,
      })),
    });
  };

  if (!questions.length) {
    return (
      <p className="text-muted-foreground text-sm">
        没有可显示的问题；请在 TUI 中回答。
      </p>
    );
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      {questions.map((question) => {
        const picked = selected[question.id] ?? [];
        return (
          <fieldset key={question.id} className="space-y-2">
            <legend className="text-sm font-medium">
              {question.header && (
                <span className="text-muted-foreground mr-1">
                  {question.header} ·
                </span>
              )}
              {question.question}
              {question.multi && (
                <Badge variant="outline" className="ml-2 text-[10px]">
                  多选
                </Badge>
              )}
            </legend>
            <div className="space-y-1.5">
              {question.options.map((option, index) => {
                const checked = picked.includes(option.label);
                return (
                  <label
                    key={`${question.id}-${option.label}-${index}`}
                    className="hover:bg-muted/40 flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-1.5 text-sm"
                  >
                    <input
                      type={question.multi ? "checkbox" : "radio"}
                      name={question.id}
                      checked={checked}
                      onChange={() => {
                        const next = question.multi
                          ? checked
                            ? picked.filter((entry) => entry !== option.label)
                            : [...picked, option.label]
                          : [option.label];
                        setSelected((current) => ({
                          ...current,
                          [question.id]: next,
                        }));
                        if (!question.multi) {
                          setCustom((current) => ({
                            ...current,
                            [question.id]: "",
                          }));
                        }
                      }}
                      className="accent-primary mt-0.5"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        {option.label}
                        {question.recommended === index && (
                          <Badge variant="secondary" className="text-[10px]">
                            推荐
                          </Badge>
                        )}
                      </span>
                      {option.description && (
                        <span className="text-muted-foreground block text-xs">
                          {option.description}
                        </span>
                      )}
                      {option.preview && (
                        <span className="text-muted-foreground mt-1 block rounded bg-muted/40 p-1.5 font-mono text-[10px] whitespace-pre-wrap">
                          {option.preview}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
            <Input
              value={custom[question.id] ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                setCustom((current) => ({
                  ...current,
                  [question.id]: value,
                }));
                if (!question.multi && value) {
                  setSelected((current) => ({
                    ...current,
                    [question.id]: [],
                  }));
                }
              }}
              placeholder="其他（自由输入）"
              className="text-sm"
            />
          </fieldset>
        );
      })}
      {error && <p className="text-destructive text-xs">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm">
          提交
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onRespond(item.id, { cancelled: true })}
        >
          取消
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * Typed dialogs
 * ------------------------------------------------------------------ */

function DialogFooter({
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

function ApproveCard({
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
          带记忆的选项会写入 omp 的审批缓存；TUI 端会立即关闭。
        </p>
      )}
      <DialogFooter item={item} onRespond={onRespond} />
    </div>
  );
}

function SelectCard({
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

function ConfirmCard({
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

function InputCard({
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

function EditorCard({
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

function PlanReviewCard({
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
            placeholder="告诉 omp 如何修改计划…"
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

/* ------------------------------------------------------------------ *
 * Dock
 * ------------------------------------------------------------------ */

function InteractionBody({
  item,
  error,
  onRespond,
}: {
  item: InteractionRequest;
  error?: InteractionError;
  onRespond: Respond;
}) {
  switch (item.kind) {
    case "formDialog":
      return <FormDialogCard item={item} error={error} onRespond={onRespond} />;
    case "askDialog":
      return <AskDialogCard item={item} onRespond={onRespond} />;
    case "approve":
      return <ApproveCard item={item} onRespond={onRespond} />;
    case "plan_review":
      return <PlanReviewCard item={item} onRespond={onRespond} />;
    case "select":
      return <SelectCard item={item} onRespond={onRespond} />;
    case "confirm":
      return <ConfirmCard item={item} onRespond={onRespond} />;
    case "input":
      return <InputCard item={item} onRespond={onRespond} />;
    case "editor":
      return <EditorCard item={item} onRespond={onRespond} />;
    default:
      return (
        <div className="space-y-2">
          <p className="text-muted-foreground text-sm">
            这个交互类型需要在 TUI overlay 中完成（{item.kind}）。
          </p>
          <pre className="bg-muted/40 max-h-40 overflow-auto rounded-md border p-2 font-mono text-xs whitespace-pre-wrap">
            {JSON.stringify(item.payload, null, 2)}
          </pre>
          <DialogFooter item={item} onRespond={onRespond} />
        </div>
      );
  }
}

export function InteractionDock({
  items,
  errors,
  onRespond,
}: {
  items: InteractionRequest[];
  errors: Record<string, InteractionError>;
  onRespond: Respond;
}) {
  if (!items.length) return null;
  return (
    <div className="mx-auto max-h-[45vh] w-full max-w-[var(--chat-max-w)] space-y-2 overflow-y-auto px-4 pb-2">
      {items.map((item) => {
        const error = errors[item.id];
        return (
          <section
            key={item.id}
            className="bg-card overflow-hidden rounded-xl border shadow-sm"
          >
            <div className="bg-muted/40 text-muted-foreground flex items-center gap-2 border-b px-3 py-1.5 text-xs">
              <KindIcon kind={item.kind} />
              <span className="font-medium">{KIND_LABEL[item.kind] ?? item.kind}</span>
              <span className="truncate opacity-70">{titleOf(item)}</span>
              <Badge variant="outline" className="ml-auto text-[10px]">
                Web / TUI 先答者胜
              </Badge>
            </div>
            <div className="p-3">
              {error && item.kind !== "formDialog" && (
                <p className="bg-destructive/10 text-destructive mb-2 rounded-md px-3 py-1.5 text-xs">
                  {error.message || error.code || "交互提交失败"}
                </p>
              )}
              <InteractionBody item={item} error={error} onRespond={onRespond} />
            </div>
          </section>
        );
      })}
    </div>
  );
}
