import { asString, isRecord } from "../../protocol/guards";
import type { AnyRecord } from "./shared";

type FormOption = { label: string; value: string };
export type FormField = {
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

export type FormValue = string | string[];

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

export function normalizeForm(payload: AnyRecord): {
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

export function initialValues(
  fields: FormField[],
  defaults: AnyRecord,
): Record<string, FormValue> {
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

export function fieldError(
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

export function serializeForm(
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
