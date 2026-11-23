import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
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
import { asString, isRecord } from "../../protocol/guards";
import type { InteractionError, InteractionRequest } from "../../protocol/types";
import { payloadRecord, type Respond } from "./shared";
import {
  fieldError,
  initialValues,
  normalizeForm,
  serializeForm,
  type FormField,
  type FormValue,
} from "./form-model";

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

export function FormDialogCard({
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
