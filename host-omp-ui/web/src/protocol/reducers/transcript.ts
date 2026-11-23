import type {
  ServerFrame,
  ToolExecution,
  ToolStatus,
  UiMessage,
  WebState,
} from "../types";
import { asNumber, asString, capText, isRecord } from "../guards";
import { toolBlockId } from "../tool-view";
import { cloneMessages, normalizeMessage } from "./normalize";
import { liveCommit } from "./live";

function ensureAssistant(
  messages: UiMessage[],
  id: string | undefined,
): UiMessage {
  if (id) {
    const found = messages.find((message) => message.id === id);
    if (found) {
      const updated = { ...found, blocks: (found.blocks ?? []).map((block) => ({ ...block })), streaming: true };
      messages[messages.indexOf(found)] = updated;
      return updated;
    }
  }
  const streaming = [...messages].reverse().find(
    (message) => message.role === "assistant" && message.streaming,
  );
  const fallback = streaming ?? [...messages].reverse().find((message) => message.role === "assistant");
  if (fallback) {
    const updated = { ...fallback, blocks: (fallback.blocks ?? []).map((block) => ({ ...block })) };
    messages[messages.indexOf(fallback)] = updated;
    return updated;
  }
  const created: UiMessage = {
    id: id ?? `stream-${messages.length}`,
    role: "assistant",
    blocks: [],
    streaming: true,
  };
  messages.push(created);
  return created;
}

function appendTextBlock(
  message: UiMessage,
  index: number,
  type: "text" | "thinking",
  delta: string,
): void {
  message.blocks ??= [];
  const current = message.blocks[index];
  if (current && current.type === type) {
    current.text = capText(current.text + delta);
    return;
  }
  // A reconciler may reuse blockIndex after finishing a tool call. Appending
  // preserves the earlier text instead of overwriting it.
  const last = message.blocks[message.blocks.length - 1];
  if (last && last.type === type && index >= message.blocks.length) {
    last.text += delta;
    return;
  }
  message.blocks.push({ type, text: delta });
}

function attachToolBlock(
  message: UiMessage,
  id: string,
  name: string,
  status: ToolStatus,
): UiMessage {
  const blocks = (message.blocks ?? []).map((block) => {
    if (block.type === "toolCall" && block.id === id) {
      return { ...block, name: block.name || name, status };
    }
    if (block.type === "tool" && block.toolCallId === id) {
      return { ...block, name: block.name || name, status };
    }
    return block;
  });
  const found = blocks.some(
    (block) =>
      (block.type === "toolCall" && block.id === id) ||
      (block.type === "tool" && block.toolCallId === id),
  );
  if (!found) blocks.push({ type: "tool", toolCallId: id, name, status });
  return { ...message, blocks };
}

function findToolMessage(messages: UiMessage[], id: string): UiMessage | undefined {
  for (const message of messages) {
    if (
      message.blocks?.some((block) => toolBlockId(block) === id)
    ) {
      return message;
    }
  }
  return undefined;
}

function updateBlockResult(
  messages: UiMessage[],
  id: string,
  result: unknown,
  isError: boolean,
): void {
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    let changed = false;
    const blocks = (message.blocks ?? []).map((block) => {
      if (block.type === "toolCall" && block.id === id) {
        changed = true;
        return {
          ...block,
          result,
          isError,
          status: isError ? ("failed" as const) : ("completed" as const),
        };
      }
      if (block.type === "tool" && block.toolCallId === id) {
        changed = true;
        return {
          ...block,
          result,
          status: isError ? ("failed" as const) : ("completed" as const),
        };
      }
      return block;
    });
    if (changed) messages[messageIndex] = { ...message, blocks };
  }
}

export function applyDelta(state: WebState, frame: ServerFrame): WebState {
  const seq = asNumber(frame.seq);
  if (seq !== undefined && seq <= state.transcriptSeq) return state;
  const next = applyDeltaInner(state, frame);
  return seq !== undefined ? { ...next, transcriptSeq: Math.max(next.transcriptSeq, seq) } : next;
}

function applyDeltaInner(state: WebState, frame: ServerFrame): WebState {
  const deltaKind =
    asString(frame.kind) ||
    (frame.type === "transcript.delta" ? "" : frame.type);
  const messageId = asString(
    frame.messageId ?? (isRecord(frame.message) ? frame.message.id : undefined),
  );

  if (
    (deltaKind === "text_delta" || deltaKind === "thinking_delta") &&
    messageId
  ) {
    const index = state.liveSession.messages.findIndex(
      (message) => message.id === messageId,
    );
    if (index >= 0) {
      const previous = state.liveSession.messages[index];
      const blockIndex =
        asNumber(frame.blockIndex ?? frame.index) ??
        previous.blocks?.length ??
        0;
      // Copy only the block that this delta will mutate; history stays shared.
      const blocks = (previous.blocks ?? []).slice();
      if (blockIndex < blocks.length) {
        blocks[blockIndex] = { ...blocks[blockIndex] };
      } else if (blocks.length > 0) {
        blocks[blocks.length - 1] = { ...blocks[blocks.length - 1] };
      }
      const message: UiMessage = {
        ...previous,
        blocks,
        streaming: true,
      };
      appendTextBlock(
        message,
        blockIndex,
        deltaKind === "thinking_delta" ? "thinking" : "text",
        asString(frame.delta ?? frame.text),
      );
      const messages = state.liveSession.messages.map((item, itemIndex) => {
        if (itemIndex === index) return message;
        return item.streaming ? { ...item, streaming: false } : item;
      });
      return liveCommit(
        state,
        { messages },
        { toolExecutions: { ...state.toolExecutions }, streaming: true },
      );
    }
  }

  const messages = cloneMessages(state.liveSession.messages);
  const tools = { ...state.toolExecutions };

  if (deltaKind === "message_start" || deltaKind === "message") {
    const incoming = normalizeMessage(frame.message, messages.length);
    if (incoming) {
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (message.streaming) messages[index] = { ...message, streaming: false };
      }
      const index = messages.findIndex((message) => message.id === incoming.id);
      const next = { ...incoming, streaming: true };
      if (index >= 0) messages[index] = next;
      else messages.push(next);
    }
  } else if (deltaKind === "text_delta" || deltaKind === "thinking_delta") {
    const message = ensureAssistant(messages, messageId || undefined);
    const index = asNumber(frame.blockIndex ?? frame.index) ?? message.blocks?.length ?? 0;
    appendTextBlock(
      message,
      index,
      deltaKind === "thinking_delta" ? "thinking" : "text",
      asString(frame.delta ?? frame.text),
    );
    for (let i = 0; i < messages.length; i += 1) {
      const item = messages[i];
      const streaming = item.id === message.id;
      if (Boolean(item.streaming) !== streaming) messages[i] = { ...item, streaming };
    }
  } else if (
    deltaKind === "toolcall_start" ||
    deltaKind === "toolcall_delta" ||
    deltaKind === "toolcall_end"
  ) {
    const id = asString(frame.toolCallId ?? frame.id);
    if (id) {
      const name = asString(frame.toolName ?? frame.name, "tool");
      const previous = tools[id];
      const argsDelta = asString(frame.delta ?? frame.argsDelta);
      const joinedArgs =
        deltaKind === "toolcall_delta"
          ? `${previous?.argsText ?? ""}${argsDelta}`
          : previous?.argsText;
      const argsText =
        joinedArgs && joinedArgs.length > 64 * 1024
          ? `${joinedArgs.slice(0, 64 * 1024)}\n… [truncated]`
          : joinedArgs;
      const next: ToolExecution = {
        ...(previous ?? {
          id,
          name,
          status: "running" as const,
          toolCallId: id,
          toolName: name,
        }),
        id,
        name: name === "tool" && previous?.name ? previous.name : name,
        status: "running",
        argsText: deltaKind === "toolcall_end" ? undefined : argsText,
        args:
          deltaKind === "toolcall_end"
            ? frame.args ?? previous?.args
            : previous?.args ?? frame.args,
        messageId: messageId || previous?.messageId,
      };
      if (deltaKind === "toolcall_end" && next.args === undefined) {
        const rawArgs = argsText ?? "";
        if (rawArgs) {
          try {
            next.args = JSON.parse(rawArgs);
          } catch {
            // The streamed arguments may be incomplete or truncated.
          }
        }
      }
      tools[id] = next;
      const target =
        (messageId ? messages.find((message) => message.id === messageId) : undefined) ??
        findToolMessage(messages, id) ??
        ensureAssistant(messages, undefined);
      messages[messages.indexOf(target)] = attachToolBlock(target, id, next.name, "running");
    }
  } else if (
    deltaKind === "tool_start" ||
    deltaKind === "tool_update" ||
    deltaKind === "tool_end"
  ) {
    const id = asString(frame.toolCallId ?? frame.id);
    if (id) {
      const name = asString(frame.toolName ?? frame.name, "tool");
      const previous = tools[id];
      const isError = Boolean(frame.isError);
      const status = isError
        ? "failed"
        : deltaKind === "tool_end"
          ? "completed"
          : "running";
      tools[id] = {
        ...(previous ?? { id, name }),
        id,
        name: previous?.name && previous.name !== "tool" ? previous.name : name,
        status,
        isError,
        args: frame.args ?? previous?.args,
        partialResult:
          deltaKind === "tool_update" ? frame.partialResult : previous?.partialResult,
        result:
          deltaKind === "tool_end" ? frame.result : previous?.result,
        messageId: messageId || previous?.messageId,
      };
      const target =
        (messageId ? messages.find((message) => message.id === messageId) : undefined) ??
        findToolMessage(messages, id) ??
        ensureAssistant(messages, undefined);
      messages[messages.indexOf(target)] = attachToolBlock(target, id, tools[id].name, status);
      if (deltaKind === "tool_end") {
        updateBlockResult(messages, id, frame.result, isError);
      }
    }
  } else if (deltaKind === "message_end") {
    const index = messages.findIndex((item) => item.id === messageId);
    if (index >= 0) {
      const message = messages[index];
      const incoming = normalizeMessage(frame.message, messages.length);
      messages[index] = {
        ...message,
        streaming: false,
        ...(incoming && incoming.id === message.id && incoming.blocks?.length
          ? { blocks: incoming.blocks }
          : {}),
      };
    }
  } else if (deltaKind === "agent_end") {
    if (Array.isArray(frame.messages)) {
      for (const raw of frame.messages) {
        const incoming = normalizeMessage(raw, messages.length);
        if (!incoming) continue;
        const index = messages.findIndex((item) => item.id === incoming.id);
        if (index >= 0) messages[index] = { ...messages[index], ...incoming };
        else messages.push(incoming);
      }
    }
    for (let index = 0; index < messages.length; index += 1) {
      if (messages[index].streaming) {
        messages[index] = { ...messages[index], streaming: false };
      }
    }
  }

  // Agent lifetime is bounded by agent_start/agent_end, not by a single
  // message. A message_end (or an intermediate snapshot) must never make the
  // UI look idle while the turn is still running.
  const streaming =
    deltaKind === "agent_end"
      ? false
      : deltaKind === "message_end"
        ? Boolean(state.streaming) || Boolean(state.meta.busy)
        : true;

  return liveCommit(
    state,
    { messages },
    {
      toolExecutions: tools,
      streaming,
      // Agent turn state is independent from individual message streaming.
      // Only agent_end closes the turn; any other agent event keeps it busy.
      meta: { ...state.meta, busy: deltaKind !== "agent_end" },
    },
  );
}
