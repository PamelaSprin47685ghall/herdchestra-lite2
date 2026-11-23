import { useState } from "react";
import {
  AlertTriangleIcon,
  BanIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleIcon,
  ListTodoIcon,
  Loader2Icon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { TodoItem, TodoPhase } from "../protocol/types";

function statusIcon(status: string | undefined) {
  switch (status) {
    case "completed":
      return <CheckCircle2Icon className="size-3.5 text-emerald-500" />;
    case "in_progress":
      return <Loader2Icon className="size-3.5 animate-spin text-sky-400" />;
    case "blocked":
      return <AlertTriangleIcon className="text-destructive size-3.5" />;
    case "abandoned":
      return <BanIcon className="text-muted-foreground size-3.5" />;
    case "waiting":
      return <CircleIcon className="size-3.5 text-amber-500" />;
    default:
      return <CircleIcon className="text-muted-foreground/50 size-3.5" />;
  }
}

function taskLabel(todo: TodoItem): string {
  return todo.content ?? todo.description ?? "";
}

export function TodoDock({
  todos,
  phases,
}: {
  todos: TodoItem[];
  phases: TodoPhase[];
}) {
  const groups: TodoPhase[] = phases.length
    ? phases
    : todos.length
      ? [{ name: "Todo", tasks: todos }]
      : [];
  const all = groups.flatMap((group) => group.tasks);
  const done = all.filter((todo) => todo.status === "completed").length;
  const active = all.some(
    (todo) => todo.status === "in_progress" || todo.status === "blocked",
  );
  const [open, setOpen] = useState(active);
  if (!all.length) return null;
  return (
    <div className="mx-auto w-full max-w-[var(--chat-max-w)] px-4">
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className="bg-card/70 mb-2 rounded-xl border shadow-sm"
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="hover:bg-muted/40 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm"
          >
            <ListTodoIcon className="text-muted-foreground size-4" />
            <span className="font-medium">待办</span>
            <Badge variant="secondary" className="text-[11px]">
              {done}/{all.length}
            </Badge>
            {active && (
              <span className="flex items-center gap-1 text-xs text-sky-500">
                <Loader2Icon className="size-3 animate-spin" /> 进行中
              </span>
            )}
            <ChevronDownIcon
              className={`text-muted-foreground ml-auto size-4 transition-transform ${open ? "rotate-180" : ""}`}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="max-h-56 space-y-2 overflow-auto border-t px-3 py-2">
            {groups.map((group, groupIndex) => (
              <div key={`${group.name ?? "group"}-${groupIndex}`}>
                {group.name && (
                  <div className="text-muted-foreground mb-1 text-[11px] font-medium tracking-wide uppercase">
                    {group.name}
                  </div>
                )}
                <ul className="space-y-1">
                  {group.tasks.map((todo, index) => (
                    <li
                      key={`${taskLabel(todo)}-${index}`}
                      className="flex items-start gap-2 text-sm"
                    >
                      <span className="mt-0.5">{statusIcon(todo.status)}</span>
                      <span
                        className={
                          todo.status === "completed"
                            ? "text-muted-foreground line-through"
                            : todo.status === "blocked"
                              ? "text-destructive"
                              : ""
                        }
                      >
                        {taskLabel(todo)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
