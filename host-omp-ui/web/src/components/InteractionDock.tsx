import { Badge } from "@herd/deer-flow-ui/ui/badge";
import type { InteractionError, InteractionRequest } from "../protocol/types";
import { AskDialogCard } from "./interaction/ask-dialog";
import { FormDialogCard } from "./interaction/form-dialog";
import { KIND_LABEL, KindIcon, titleOf, type Respond } from "./interaction/shared";
import {
  ApproveCard,
  ConfirmCard,
  DialogFooter,
  EditorCard,
  InputCard,
  PlanReviewCard,
  SelectCard,
} from "./interaction/typed-dialogs";

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
