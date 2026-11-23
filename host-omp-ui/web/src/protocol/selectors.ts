import type {
  ArtifactItem,
  DisplayGroup,
  ModelRef,
  UsageState,
  WebState,
  WidgetEntry,
} from "./types";
import { argsOf, basename, languageFor, resultText } from "./tool-view";
import { asNumber, isRecord } from "./guards";
import { normalizeWidgetEntries } from "./reducers/widgets";

export function selectDisplayGroups(state: WebState): DisplayGroup[] {
  const groups: DisplayGroup[] = [];
  for (const message of state.messages) {
    if (message.role === "user") {
      groups.push({ kind: "user", id: message.id, messages: [message] });
      continue;
    }
    if (message.role === "bashExecution" || message.role === "pythonExecution") {
      groups.push({ kind: "terminal", id: message.id, messages: [message] });
      continue;
    }
    if (
      message.role === "compactionSummary" ||
      message.role === "branchSummary"
    ) {
      groups.push({ kind: "boundary", id: message.id, messages: [message] });
      continue;
    }
    const blocks = message.blocks ?? [];
    const hasTool = blocks.some(
      (block) => block.type === "tool" || block.type === "toolCall",
    );
    const hasText = blocks.some(
      (block) => block.type === "text" && block.text.length > 0,
    );
    if (hasTool && !hasText) {
      groups.push({ kind: "processing", id: message.id, messages: [message] });
    } else if (hasText) {
      groups.push({ kind: "assistant", id: message.id, messages: [message] });
    } else {
      groups.push({ kind: "other", id: message.id, messages: [message] });
    }
  }
  return groups;
}

/**
 * Snapshot artifacts are only rebuilt on session hydrate. During a live turn
 * they are stale, so merge file tools from the transcript with the snapshot
 * list. Path is the stable identity the tool cards already use.
 */
function selectArtifacts(state: WebState): ArtifactItem[] {
  const byPath = new Map<string, ArtifactItem>();
  for (const artifact of state.artifacts) {
    byPath.set(artifact.path ?? artifact.id, artifact);
  }
  for (const message of state.liveSession.messages.length
    ? state.liveSession.messages
    : state.messages) {
    for (const block of message.blocks ?? []) {
      if (block.type !== "tool" && block.type !== "toolCall") continue;
      const id = block.type === "toolCall" ? block.id : block.toolCallId;
      const execution = state.toolExecutions[id];
      const name = execution?.name ?? block.name;
      if (
        name !== "read" &&
        name !== "write" &&
        name !== "edit" &&
        name !== "apply_patch"
      ) {
        continue;
      }
      const args = argsOf({
        args: execution?.args ?? block.args,
        argsText:
          execution?.argsText ??
          (block.type === "toolCall" ? block.argsText : undefined),
      });
      const path = typeof args.path === "string" ? args.path : "";
      if (!path) continue;
      const content =
        name === "read"
          ? resultText(
              execution?.result ?? execution?.partialResult ?? block.result,
            )
          : name === "write"
            ? String(args.content ?? "")
            : name === "apply_patch"
              ? String(args.patch ?? "")
              : String(args.new_string ?? args.newText ?? "");
      const previous =
        name === "edit"
          ? String(args.old_string ?? args.oldText ?? "")
          : undefined;
      const existing = byPath.get(path);
      const blockError = block.type === "toolCall" ? block.isError : false;
      byPath.set(path, {
        id: existing?.id ?? path,
        path,
        name: existing?.name ?? basename(path),
        kind: name === "apply_patch" ? "edit" : name,
        language: languageFor(path),
        content: content || existing?.content || "",
        previous: previous ?? existing?.previous,
        diff: existing?.diff ?? null,
        isError: Boolean(execution?.isError || blockError || existing?.isError),
      });
    }
  }
  return Array.from(byPath.values());
}

export function selectActiveArtifact(state: WebState): ArtifactItem | null {
  return selectArtifactById(state, state.activeArtifactId);
}

function selectArtifactById(
  state: WebState,
  id: string | null,
): ArtifactItem | null {
  if (!id) return null;
  const artifacts = selectArtifacts(state);
  return (
    artifacts.find((item) => item.id === id) ??
    artifacts.find((item) => item.path === id) ??
    null
  );
}

export type UsageView = {
  percent: number;
  tokens: number | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  contextWindow: number | null;
  cost: number | null;
};

export function selectUsage(state: WebState): UsageView {
  const usage = state.usage;
  const tokenValue = usage?.tokens;
  const tokenRecord = isRecord(tokenValue) ? tokenValue : undefined;
  const context = usage?.context;
  const input = asNumber(tokenRecord?.input) ?? 0;
  const output = asNumber(tokenRecord?.output) ?? 0;
  const cacheRead = asNumber(tokenRecord?.cacheRead) ?? 0;
  const cacheWrite = asNumber(tokenRecord?.cacheWrite) ?? 0;
  const summed = input + output + cacheRead + cacheWrite;
  const total =
    typeof tokenValue === "number"
      ? tokenValue
      : asNumber(tokenRecord?.total) ?? (summed > 0 ? summed : null);
  const contextTokens =
    asNumber(context?.tokens) ?? asNumber(context?.token_count) ?? 0;
  const contextWindow =
    asNumber(usage?.contextWindow) ??
    asNumber(context?.contextWindow) ??
    asNumber(context?.max_context_tokens) ??
    null;
  const percentFromContext =
    contextTokens > 0 && contextWindow
      ? (contextTokens / contextWindow) * 100
      : 0;
  const cost = isRecord(usage?.cost)
    ? asNumber(usage.cost.total)
    : asNumber(usage?.cost);
  return {
    percent: Math.max(
      0,
      Math.min(
        100,
        Math.round(
          asNumber(usage?.percent) ??
            asNumber(context?.percent) ??
            percentFromContext,
        ),
      ),
    ),
    tokens: total ?? (contextTokens || null),
    input,
    output,
    cacheRead,
    cacheWrite,
    contextWindow,
    cost: cost ?? null,
  };
}

export function selectModelKey(model: ModelRef | null): string {
  return model ? `${model.provider}/${model.id}` : "";
}

export function selectModeStatus(
  modes: WebState["modes"] | null | undefined,
  mode: "plan" | "vibe" | "goal" | "loop",
): string {
  const entry = isRecord(modes) ? modes[mode] : undefined;
  if (isRecord(entry) && typeof entry.status === "string") return entry.status;
  if (typeof entry === "string") return entry;
  return "inactive";
}

export function selectWorkingText(state: WebState): string | null {
  const working = state.meta.setWorkingMessage;
  if (typeof working === "string" && working.trim()) return working.trim();
  const status = state.meta.setStatus;
  return typeof status === "string" && status.trim() ? status.trim() : null;
}

export function selectWidgetList(state: WebState): WidgetEntry[] {
  return normalizeWidgetEntries(state.widgets);
}
