import type { ToolExecution, UiMessage } from "../protocol/types";
import {
  isToolBlock,
  mergeToolBlock,
  toolBlockId,
} from "../protocol/tool-view";

export type StepFormat = "markdown" | "pre";

export type StepEntry =
  | {
      key: string;
      kind: "thinking";
      text: string;
      format: StepFormat;
      messageId?: string;
      streaming: boolean;
    }
  | {
      key: string;
      kind: "text";
      text: string;
      format: StepFormat;
      messageId?: string;
      streaming: boolean;
    }
  | {
      key: string;
      kind: "input";
      text: string;
      format: StepFormat;
      messageId?: string;
      streaming: boolean;
    }
  | {
      key: string;
      kind: "tool";
      tool: ToolExecution;
      format: StepFormat;
      messageId?: string;
      streaming: boolean;
    };

function hasVisibleText(text: unknown): text is string {
  return typeof text === "string" && text.trim().length > 0;
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function isRealUser(message: UiMessage): boolean {
  return message.role === "user" && message.attribution === "user";
}

export interface StepSegment {
  id: string;
  steps: readonly StepEntry[];
}

export type TurnGroup =
  | { kind: "user"; id: string; message: UiMessage }
  | {
      kind: "processing";
      id: string;
      messages: UiMessage[];
      segments: readonly StepSegment[];
      totalSteps: number;
      hasStreamingStep: boolean;
      runningTools: number;
      steps: StepEntry[];
      body: string;
      streaming: boolean;
      bodyFinished: boolean;
      stepsFinished: boolean;
    }
  | { kind: "terminal"; id: string; message: UiMessage }
  | { kind: "boundary"; id: string; message: UiMessage }
  | { kind: "other"; id: string; message: UiMessage };

/**
 * Groups one user turn into a single processing block. Every intermediate
 * assistant text becomes a step; only the final assistant text is body.
 */
export function buildTurnGroups(messages: UiMessage[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let run: UiMessage[] = [];
  const flush = (allowBody = true) => {
    if (!run.length) return;
    const segments: StepSegment[] = [];
    const pairedToolIds = new Set<string>();
    let totalSteps = 0;
    let hasStreamingStep = false;
    let runningTools = 0;
    let body = "";
    let bodyFinished = true;
    let stepsFinished = true;
    run.forEach((message, index) => {
      const pairedResult =
        message.role === "toolResult" &&
        typeof message.toolCallId === "string" &&
        pairedToolIds.has(message.toolCallId);
      const built = pairedResult
        ? {
            steps: [] as StepEntry[],
            body: "",
            bodyFinished: true,
            stepsFinished: true,
            hasStreamingStep: false,
            runningTools: 0,
          }
        : buildSteps(message);
      for (const step of built.steps) {
        if (step.kind !== "tool") continue;
        pairedToolIds.add(step.tool.id);
        if (step.tool.toolCallId) pairedToolIds.add(step.tool.toolCallId);
      }
      if (built.steps.length) {
        segments.push({ id: message.id, steps: built.steps });
        totalSteps += built.steps.length;
      }
      hasStreamingStep = hasStreamingStep || built.hasStreamingStep;
      runningTools += built.runningTools;
      stepsFinished = stepsFinished && built.stepsFinished;
      if (allowBody && index === run.length - 1 && message.role === "assistant") {
        body = built.body;
        bodyFinished = built.bodyFinished;
      } else if (hasVisibleText(built.body)) {
        const step: StepEntry = {
          key: `body-${message.id}`,
          kind: "text",
          text: built.body,
          format:
            message.role === "toolResult" ||
            message.role === "developer" ||
            message.role === "user"
              ? "pre"
              : "markdown",
          messageId: message.id,
          streaming: false,
        };
        segments.push({ id: message.id, steps: [step] });
        totalSteps += 1;
      }
    });
    const group = {
      kind: "processing" as const,
      id: run[0].id,
      messages: run,
      segments,
      totalSteps,
      hasStreamingStep,
      runningTools,
      body,
      streaming: run.some((message) => message.streaming),
      bodyFinished,
      stepsFinished,
      steps: [] as StepEntry[],
    };
    Object.defineProperty(group, "steps", {
      get() {
        return segments.flatMap((segment) => segment.steps as StepEntry[]);
      },
    });
    groups.push(group);
    run = [];
  };
  for (const message of messages) {
    if (isRealUser(message)) {
      flush(true);
      groups.push({ kind: "user", id: message.id, message });
      continue;
    }
    if (message.role === "user") {
      run.push(message);
      continue;
    }
    if (
      message.role === "assistant" ||
      message.role === "developer" ||
      message.role === "custom"
    ) {
      run.push(message);
      continue;
    }
    if (message.role === "toolResult" && run.length) {
      run.push(message);
      continue;
    }
    flush();
    if (message.role === "bashExecution" || message.role === "pythonExecution") {
      groups.push({ kind: "terminal", id: message.id, message });
    } else if (
      message.role === "compactionSummary" ||
      message.role === "branchSummary"
    ) {
      groups.push({ kind: "boundary", id: message.id, message });
    } else {
      groups.push({ kind: "other", id: message.id, message });
    }
  }
  flush();
  return groups;
}

export function shouldShowStreamingFooter(group: TurnGroup): boolean {
  return (
    group.kind === "processing" &&
    group.streaming &&
    group.totalSteps === 0 &&
    group.body === ""
  );
}

/**
 * Whether the last step group should stay open. A group with running steps is
 * active. The last group stays active while the session is still streaming, or
 * while it has no final body yet, so gaps between message_end and the next
 * message/tool never collapse it by accident.
 */
export function isStepGroupActive({
  isLastGroup,
  sessionStreaming,
  hasBody,
  runningStepsOrTools,
}: {
  isLastGroup: boolean;
  sessionStreaming: boolean;
  hasBody: boolean;
  runningStepsOrTools: boolean;
}): boolean {
  if (runningStepsOrTools) return true;
  if (!isLastGroup) return false;
  return sessionStreaming || !hasBody;
}

export function flattenStepWindow(
  segments: readonly StepSegment[],
  start: number,
  end: number,
): StepEntry[] {
  const result: StepEntry[] = [];
  let offset = 0;
  for (const segment of segments) {
    const next = offset + segment.steps.length;
    if (next > start && offset < end) {
      const from = Math.max(0, start - offset);
      const to = Math.min(segment.steps.length, end - offset);
      result.push(...(segment.steps.slice(from, to) as StepEntry[]));
    }
    offset = next;
    if (offset >= end) break;
  }
  return result;
}

export function flattenAllSteps(group: Extract<TurnGroup, { kind: "processing" }>): StepEntry[] {
  return group.segments.flatMap((segment) => segment.steps as StepEntry[]);
}

const stepCache = new WeakMap<
  UiMessage,
  {
    signature: string;
    steps: StepEntry[];
    body: string;
    bodyFinished: boolean;
    stepsFinished: boolean;
    hasStreamingStep: boolean;
    runningTools: number;
  }
>();

function stepSignature(message: UiMessage): string {
  return JSON.stringify([message.id, message.role, message.attribution, message.streaming, message.blocks]);
}

export function stepWindow(
  total: number,
  running: boolean,
  open: boolean,
  visible: number,
): { start: number; count: number } {
  if (!open || total === 0) return { start: total, count: 0 };
  const size = running ? 12 : Math.max(30, visible);
  const start = Math.max(0, total - size);
  return { start, count: total - start };
}

export function buildSteps(message: UiMessage): {
  steps: StepEntry[];
  body: string;
  bodyFinished: boolean;
  stepsFinished: boolean;
  hasStreamingStep: boolean;
  runningTools: number;
} {
  const signature = stepSignature(message);
  const cached = stepCache.get(message);
  if (cached && cached.signature === signature) return cached;
  const result = computeSteps(message);
  stepCache.set(message, { signature, ...result });
  return result;
}

function computeSteps(message: UiMessage): {
  steps: StepEntry[];
  body: string;
  bodyFinished: boolean;
  stepsFinished: boolean;
  hasStreamingStep: boolean;
  runningTools: number;
} {
  const blocks = message.blocks ?? [];
  if (message.role === "custom") {
    const text = (message as UiMessage & { text?: string }).text;
    return {
      steps: hasVisibleText(text)
        ? [
            {
              key: `${message.id}-custom`,
              kind: "text",
              text,
              format: "pre",
              messageId: message.id,
              streaming: false,
            },
          ]
        : [],
      body: "",
      bodyFinished: !message.streaming,
      stepsFinished: true,
      hasStreamingStep: false,
      runningTools: 0,
    };
  }
  const steps: StepEntry[] = [];
  const seen = new Set<string>();
  let body = "";
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.type === "thinking") {
      const start = index;
      const parts: string[] = [];
      while (index < blocks.length) {
        const current = blocks[index];
        if (!current || current.type !== "thinking") break;
        if (hasVisibleText(current.text)) parts.push(current.text);
        index += 1;
      }
      index -= 1;
      if (parts.length) {
        steps.push({
          key: `${message.id}-think-${start}`,
          kind: "thinking",
          text: parts.join("\n"),
          format: "markdown",
          messageId: message.id,
          streaming: false,
        });
      }
      continue;
    }
    if (isToolBlock(block)) {
      const id = toolBlockId(block);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      steps.push({
        key: `tool-${id}`,
        kind: "tool",
        tool: mergeToolBlock(block, {}),
        format: "pre",
        messageId: message.id,
        streaming: false,
      });
      continue;
    }
    if (block.type === "text") {
      const start = index;
      const parts: string[] = [];
      while (index < blocks.length) {
        const current = blocks[index];
        if (!current || current.type !== "text") break;
        if (hasVisibleText(current.text)) parts.push(current.text);
        index += 1;
      }
      index -= 1;
      const text = parts.join("\n");
      if (!hasVisibleText(text)) continue;
      const forceSteps =
        message.role === "toolResult" ||
        message.role === "developer" ||
        (message.role === "user" && !isRealUser(message));
      const laterStep = blocks
        .slice(index + 1)
        .some((next) => next.type === "thinking" || isToolBlock(next));
      if (laterStep || forceSteps) {
        steps.push({
          key: `${message.id}-step-${start}`,
          kind: message.role === "user" ? "input" : "text",
          text,
          format: forceSteps ? "pre" : "markdown",
          messageId: message.id,
          streaming: false,
        });
      } else {
        body = text;
      }
    }
  }
  if (message.streaming && body === "" && steps.length > 0) {
    steps[steps.length - 1].streaming = true;
  }
  return {
    steps,
    body,
    bodyFinished: !(message.streaming && (body !== "" || steps.length === 0)),
    stepsFinished: !steps.some((step) => step.streaming),
    hasStreamingStep: steps.some((step) => step.streaming),
    runningTools: steps.filter(
      (step) => step.kind === "tool" && step.tool.status === "running",
    ).length,
  };
}
