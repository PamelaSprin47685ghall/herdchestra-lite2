import { CornerDownRightIcon } from "lucide-react";
import { Badge } from "@herd/deer-flow-ui/ui/badge";
import type { CompletionState } from "../../protocol/types";

export function QueueChips({
  queue,
}: {
  queue: { steering: string[]; followUp: string[] };
}) {
  const queueCount = queue.steering.length + queue.followUp.length;
  if (queueCount === 0) return null;
  return (
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
  );
}

export function CompletionMenu({
  completion,
  text,
  onKeys,
}: {
  completion: CompletionState;
  text: string;
  onKeys: (data: string) => void;
}) {
  if (!(completion.open && completion.items.length > 0 && text.startsWith("/"))) {
    return null;
  }
  return (
    <div className="mb-1.5 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="text-muted-foreground flex items-center justify-between border-b px-3 py-1 text-[10px]">
        <span>斜杠补全 · TUI 状态镜像</span>
        <span className="font-mono">{completion.prefix}</span>
      </div>
      <div className="max-h-[13rem] overflow-y-auto py-1">
        {completion.items.map((item, index) => (
          <button
            key={`${item.value}-${index}`}
            type="button"
            disabled={item.disabled}
            className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-xs disabled:opacity-40 ${
              index === completion.selectedIndex
                ? "bg-accent text-accent-foreground"
                : "text-foreground hover:bg-accent/50"
            }`}
            onMouseDown={(event) => {
              event.preventDefault();
              const current = completion.selectedIndex;
              const delta = current < 0 ? index : index - current;
              const key = delta > 0 ? "\u001b[B" : "\u001b[A";
              for (let i = 0; i < Math.abs(delta); i += 1) onKeys(key);
              onKeys("\r");
            }}
          >
            <span className="font-mono text-[11px] whitespace-nowrap">{item.label}</span>
            {item.description && (
              <span className="text-muted-foreground truncate">{item.description}</span>
            )}
            {item.hint && (
              <span className="text-muted-foreground ml-auto shrink-0 text-[10px]">
                {item.hint}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
