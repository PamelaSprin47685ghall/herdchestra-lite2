import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Badge } from "@herd/deer-flow-ui/ui/badge";
import { Button } from "@herd/deer-flow-ui/ui/button";
import { Input } from "@herd/deer-flow-ui/ui/input";
import { asString, isRecord } from "../../protocol/guards";
import type { InteractionRequest } from "../../protocol/types";
import { payloadRecord, type Respond } from "./shared";

type AskOption = { label: string; description?: string; preview?: string };

type AskQuestion = {
  id: string;
  question: string;
  header?: string;
  options: AskOption[];
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
            (option): option is AskOption =>
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

export function AskDialogCard({
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
