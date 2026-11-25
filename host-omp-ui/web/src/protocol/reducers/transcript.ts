import type {
  ServerFrame,
  ToolExecution,
  ToolStatus,
  UiMessage,
  WebState,
} from "../types";
import { asNumber, asString, capText, isRecord } from "../guards";
import { toolBlockId } from "../tool-view";
import { normalizeMessage } from "./normalize";
import { MessageLog } from "../message-log";
import { deriveIndexes, liveCommit, renderIndexes } from "./live";

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
    last.text = capText(last.text + delta);
    return;
  }
  message.blocks.push({ type, text: capText(delta) });
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

/**
 * The tool execution a `toolcall_*` frame produces.
 *
 * Extracted so the positional path and the whole-history path cannot drift:
 * they used to be one block of code, and a fast path that re-implemented the
 * argument accumulation would silently disagree with the slow one about
 * truncation, the `name` fallback, or where the arguments are parsed.
 */
function nextToolExecution(
  previous: ToolExecution | undefined,
  frame: ServerFrame,
  deltaKind: string,
  id: string,
  messageId: string | undefined,
): ToolExecution {
  const name = asString(frame.toolName ?? frame.name, "tool");
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
  return next;
}

/**
 * The positional path for `toolcall_*` frames.
 *
 * These frames are the second-highest-frequency stream: an agent streaming a
 * large `write` or `bash` call emits one per argument chunk. They used to take
 * the whole-history path — clone the whole sequence, find the target by
 * scanning, then rebuild the tree from the array — so a long session paid the
 * length of its history on every chunk. When the frame names a message that
 * exists, the target is already known: one id lookup, one replacement, one
 * tool entry.
 *
 * The whole-history path still runs whenever it is the only correct answer:
 * no message id, an id that names no message, or no tool call id.
 */
function toolCallFastPath(
  state: WebState,
  frame: ServerFrame,
  deltaKind: string,
  messageId: string | undefined,
): WebState | null {
  if (
    deltaKind !== "toolcall_start" &&
    deltaKind !== "toolcall_delta" &&
    deltaKind !== "toolcall_end"
  ) {
    return null;
  }
  const id = asString(frame.toolCallId ?? frame.id);
  if (!id || !messageId) return null;
  const baseIndexes = renderIndexes(state.liveSession.messages);
  // First occurrence, which is the message `find` picked on the slow path.
  const index = baseIndexes.positions.get(messageId) ?? -1;
  if (index < 0) return null;
  const target = state.liveSession.messages[index];
  if (!target) return null;

  const execution = nextToolExecution(
    state.toolExecutions[id],
    frame,
    deltaKind,
    id,
    messageId,
  );
  const messages = MessageLog.from(state.liveSession.messages).replace(
    index,
    attachToolBlock(target, id, execution.name, "running"),
  );
  // The frame attached one tool id and touched nothing else: no message id
  // changed, so the position map and the streaming positions still describe
  // this sequence.
  const attachedToolIds = new Set(baseIndexes.attachedToolIds);
  attachedToolIds.add(id);
  return liveCommit(
    state,
    {
      messages,
      indexes: {
        attachedToolIds,
        activeStreamingId: baseIndexes.activeStreamingId,
        positions: baseIndexes.positions,
        streamingAt: baseIndexes.streamingAt,
        duplicateIds: baseIndexes.duplicateIds,
      },
      streamRev: (state.streamRev ?? 0) + 1,
    },
    {
      toolExecutions: { ...state.toolExecutions, [id]: execution },
      // A tool call arrives inside a running turn, so it is never an idle
      // moment; the whole-history path answers the same for every kind here.
      streaming: true,
      meta: { ...state.meta, busy: true },
    },
  );
}

/**
 * The id of the last message that is an assistant and claims to be streaming,
 * or undefined.
 *
 * Walking backwards answers it in one step in the ordinary case — the stream is
 * the message at the end — and never allocates. The slow path below needs the
 * same answer to pick its target, so a frame without a `messageId` can be
 * resolved to that target's id here and then take the positional path instead.
 */
function lastStreamingAssistantId(
  messages: MessageLog | readonly UiMessage[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || !message.streaming) continue;
    // The positional path looks the target up through the id index, which
    // answers the *first* occurrence of an id. When two messages share one, that
    // is not the message found here, and the frame would edit the wrong one — so
    // a duplicated id keeps the slow path, which walks positions directly.
    const first = renderIndexes(messages).positions.get(message.id);
    return first === index ? message.id : undefined;
  }
  return undefined;
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
  ) ?? (
    // A stream frame that names no message still has one target: the assistant
    // message that is streaming. Resolving it here lets that frame take the
    // positional path below, which costs one trie descent instead of copying
    // the whole history twice — once to clone it and once to rebuild the tree.
    deltaKind === "text_delta" || deltaKind === "thinking_delta"
      ? lastStreamingAssistantId(state.liveSession.messages)
      : undefined
  );

  if (
    (deltaKind === "text_delta" || deltaKind === "thinking_delta") &&
    messageId
  ) {
    // One lookup for the whole frame instead of a scan of the history: the
    // position index is cached per array, so a delta costs the same whether the
    // session holds ten messages or ten thousand.
    const baseIndexes = renderIndexes(state.liveSession.messages);
    // A duplicated id has no single position, and the whole-history path marks
    // *every* message carrying the target's id as streaming. The positional path
    // can only reach the first, so this frame takes the path that can still
    // answer for all of them.
    if (!baseIndexes.duplicateIds.has(messageId)) {
      const index = baseIndexes.positions.get(messageId) ?? -1;
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
      // Replace one position in the persistent vector. The history keeps its
      // structure: only the path to this message is copied, so the cost of a
      // frame no longer grows with the session. Writing into the given sequence
      // instead would rewrite history under its readers — the previous state,
      // and any snapshot React still holds.
      let nextMessages = MessageLog.from(
        state.liveSession.messages,
      ).replace(index, message);
      // Clear the other streaming messages only when one exists. The test is
      // "is any other message streaming", not "is the target the last
      // streaming one": those differ exactly when the target is the last and
      // an earlier message still claims to stream. Counting positions rather
      // than ids also covers two messages that share an id.
      const streamingElsewhere =
        baseIndexes.streamingAt.size >
        (baseIndexes.streamingAt.has(index) ? 1 : 0);
      // The exact first index this frame changed. One message is replaced, and
      // when another message still claims to stream that one is rewritten too,
      // so the earliest such position is the answer. A consumer that grouped
      // the prefix before it can reuse that grouping without comparing
      // anything — the scan it used to run cost the length of the prefix on
      // every tick.
      let dirtyFrom = index;
      if (streamingElsewhere) {
        // The index already names every streaming position, including duplicate
        // message ids. Only those positions can need clearing.
        for (const itemIndex of baseIndexes.streamingAt) {
          if (itemIndex === index) continue;
          const item = nextMessages.at(itemIndex);
          if (!item?.streaming) continue;
          nextMessages = nextMessages.replace(itemIndex, { ...item, streaming: false });
          if (itemIndex < dirtyFrom) dirtyFrom = itemIndex;
        }
      }
      return liveCommit(
        state,
        {
          messages: nextMessages,
          // Positions carry over unchanged: this frame replaced one element and
          // altered no id, so the set and order of ids are the same.
          indexes: {
            attachedToolIds: baseIndexes.attachedToolIds,
            activeStreamingId: message.id,
            positions: baseIndexes.positions,
            // This frame leaves exactly one streaming message behind: after
            // the pass above, every other one was cleared. The array kept its
            // length and order, so the surviving position is still `index`.
            streamingAt: new Set([index]),
            // The frame changed which message streams, not which ids exist.
            duplicateIds: baseIndexes.duplicateIds,
          },
          // The array identity did not change, so this is the only signal that
          // the frame carried new text.
          streamRev: (state.streamRev ?? 0) + 1,
        },
        {
          // A text delta does not change tool execution state. Preserve its
          // identity so historical tool views need not re-render each frame.
          streaming: true,
          streamDirtyFrom: dirtyFrom,
        },
      );
    }

    }
  }

  const fast = toolCallFastPath(state, frame, deltaKind, messageId);
  if (fast) return fast;

  // Everything below is a boundary or fallback frame. These used to copy the
  // history into an array, mutate it, and rebuild the tree — three passes over
  // the session per event, which is what made a long conversation stutter on
  // every message boundary. They now derive a new `MessageLog` by replacing
  // only the messages the frame actually touches, and report the exact first
  // index they changed so a consumer can reuse its settled prefix.
  const baseSequence = state.liveSession.messages;
  const base = renderIndexes(baseSequence);
  let messages = MessageLog.from(baseSequence);
  const tools = { ...state.toolExecutions };
  const streaming = new Set<number>(base.streamingAt);
  const addedPositions = new Map<string, number>();
  const addedToolIds = new Set<string>();
  const addedDuplicates = new Set<string>();
  let dirtyFrom = Number.POSITIVE_INFINITY;

  const markDirty = (index: number): void => {
    if (index < dirtyFrom) dirtyFrom = index;
  };
  const write = (index: number, message: UiMessage): void => {
    messages = messages.replace(index, message);
    markDirty(index);
  };
  const positionOf = (id: string): number => {
    const added = addedPositions.get(id);
    return added !== undefined ? added : base.positions.get(id) ?? -1;
  };
  const appendMessage = (message: UiMessage): number => {
    const index = messages.length;
    messages = messages.append(message);
    markDirty(index);
    // `positions` answers the first occurrence of an id, as `findIndex` did, so
    // a later message that reuses one is recorded as a duplicate instead of
    // moving the answer.
    if (positionOf(message.id) < 0) addedPositions.set(message.id, index);
    else addedDuplicates.add(message.id);
    return index;
  };
  const setStreaming = (index: number, value: boolean): void => {
    const current = messages.at(index);
    if (!current || Boolean(current.streaming) === value) return;
    write(index, { ...current, streaming: value });
    if (value) streaming.add(index);
    else streaming.delete(index);
  };
  const lastIndexWhere = (predicate: (message: UiMessage) => boolean): number => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages.at(index);
      if (message && predicate(message)) return index;
    }
    return -1;
  };
  /**
   * The message a frame without a usable id lands on: the streaming assistant,
   * else the last assistant, else none — the order `ensureAssistant` used.
   */
  const assistantIndex = (): number => {
    const streamingIndex = lastIndexWhere(
      (message) => message.role === "assistant" && Boolean(message.streaming),
    );
    if (streamingIndex >= 0) return streamingIndex;
    return lastIndexWhere((message) => message.role === "assistant");
  };
  const toolIndex = (id: string): number => {
    // `attachedToolIds` answers whether any message carries this tool id, so the
    // scan runs only when one does.
    if (!base.attachedToolIds.has(id) && !addedToolIds.has(id)) return -1;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages.at(index);
      if (message?.blocks?.some((block) => toolBlockId(block) === id)) return index;
    }
    return -1;
  };
  const appendAssistant = (): number => {
    const index = appendMessage({
      id: `stream-${messages.length}`,
      role: "assistant",
      blocks: [],
      streaming: true,
    });
    streaming.add(index);
    return index;
  };

  if (deltaKind === "message_start" || deltaKind === "message") {
    const incoming = normalizeMessage(frame.message, messages.length);
    if (incoming) {
      // A new message is the only one that streams.
      for (const index of [...streaming]) setStreaming(index, false);
      const index = positionOf(incoming.id);
      const next: UiMessage = { ...incoming, streaming: true };
      if (index >= 0) {
        write(index, next);
        streaming.add(index);
      } else {
        streaming.add(appendMessage(next));
      }
    }
  } else if (deltaKind === "text_delta" || deltaKind === "thinking_delta") {
    // The positional path declined: no message id, an id that names nothing, or
    // a duplicated id. Resolve the target here, then replace only that message.
    let index = messageId ? positionOf(messageId) : -1;
    if (index < 0) index = assistantIndex();
    const previous = index >= 0 ? messages.at(index) : undefined;
    const blockIndex =
      asNumber(frame.blockIndex ?? frame.index) ?? previous?.blocks?.length ?? 0;
    const target: UiMessage = previous
      ? {
          ...previous,
          blocks: (previous.blocks ?? []).map((block) => ({ ...block })),
        }
      : { id: messageId ?? `stream-${messages.length}`, role: "assistant", blocks: [] };
    appendTextBlock(
      target,
      blockIndex,
      deltaKind === "thinking_delta" ? "thinking" : "text",
      asString(frame.delta ?? frame.text),
    );
    target.streaming = true;
    // Identity, not id: `normalizeMessages` does not deduplicate, so two
    // messages can share an id, and an id comparison would mark both as
    // streaming. The message this frame wrote keeps streaming; every other
    // message that claimed to stream is cleared by position.
    if (previous) {
      write(index, target);
      for (const other of [...streaming]) {
        if (other !== index) setStreaming(other, false);
      }
      streaming.add(index);
    } else {
      streaming.add(appendMessage(target));
    }
  } else if (
    deltaKind === "toolcall_start" ||
    deltaKind === "toolcall_delta" ||
    deltaKind === "toolcall_end"
  ) {
    const id = asString(frame.toolCallId ?? frame.id);
    if (id) {
      const execution = nextToolExecution(
        tools[id],
        frame,
        deltaKind,
        id,
        messageId || undefined,
      );
      tools[id] = execution;
      addedToolIds.add(id);
      let index = messageId ? positionOf(messageId) : -1;
      if (index < 0) index = toolIndex(id);
      if (index < 0) index = assistantIndex();
      if (index < 0) index = appendAssistant();
      const target = messages.at(index);
      if (target) write(index, attachToolBlock(target, id, execution.name, "running"));
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
      addedToolIds.add(id);
      let index = messageId ? positionOf(messageId) : -1;
      if (index < 0) index = toolIndex(id);
      if (index < 0) index = assistantIndex();
      if (index < 0) index = appendAssistant();
      const target = messages.at(index);
      if (target) write(index, attachToolBlock(target, id, tools[id].name, status));
      if (deltaKind === "tool_end") {
        // The result belongs to every block that carries the tool id — a tool
        // call block and its result block can live in different messages. The
        // scan allocates nothing; only a matched message is rewritten.
        for (let blockIndex = 0; blockIndex < messages.length; blockIndex += 1) {
          const message = messages.at(blockIndex);
          if (!message) continue;
          let changed = false;
          const blocks = (message.blocks ?? []).map((block) => {
            if (block.type === "toolCall" && block.id === id) {
              changed = true;
              return {
                ...block,
                result: frame.result,
                isError,
                status: isError ? ("failed" as const) : ("completed" as const),
              };
            }
            if (block.type === "tool" && block.toolCallId === id) {
              changed = true;
              return {
                ...block,
                result: frame.result,
                status: isError ? ("failed" as const) : ("completed" as const),
              };
            }
            return block;
          });
          if (changed) write(blockIndex, { ...message, blocks });
        }
      }
    }
  } else if (deltaKind === "message_end") {
    const index = messageId ? positionOf(messageId) : -1;
    if (index >= 0) {
      const message = messages.at(index);
      const incoming = normalizeMessage(frame.message, messages.length);
      if (message) {
        write(index, {
          ...message,
          streaming: false,
          ...(incoming && incoming.id === message.id && incoming.blocks?.length
            ? { blocks: incoming.blocks }
            : {}),
        });
        streaming.delete(index);
      }
    }
  } else if (deltaKind === "agent_end") {
    if (Array.isArray(frame.messages)) {
      for (const raw of frame.messages) {
        const incoming = normalizeMessage(raw, messages.length);
        if (!incoming) continue;
        const index = positionOf(incoming.id);
        if (index >= 0) {
          const current = messages.at(index);
          if (current) write(index, { ...current, ...incoming });
          if (incoming.streaming) streaming.add(index);
          else streaming.delete(index);
        } else {
          const appended = appendMessage(incoming);
          if (incoming.streaming) streaming.add(appended);
        }
      }
    }
    // The turn is over: nothing streams.
    for (const index of [...streaming]) setStreaming(index, false);
  }

  // Agent lifetime is bounded by agent_start/agent_end, not by a single
  // message. A message_end (or an intermediate snapshot) must never make the
  // UI look idle while the turn is still running.
  const streamingState =
    deltaKind === "agent_end"
      ? false
      : deltaKind === "message_end"
        ? Boolean(state.streaming) || Boolean(state.meta.busy)
        : true;

  // The exact first index this frame changed. A consumer that grouped the
  // prefix before it can reuse that grouping without comparing anything; the
  // full regroup it used to force cost the length of the session on every
  // boundary event. When the frame changed nothing, the answer is the end of
  // the sequence, which claims no dirty position.
  const changedIndex = Number.isFinite(dirtyFrom) ? dirtyFrom : messages.length;
  const sequenceReplaced = messages !== baseSequence;
  return liveCommit(
    state,
    {
      messages,
      indexes: deriveIndexes(
        base,
        {
          positions: addedPositions,
          toolIds: addedToolIds,
          streamingAt: streaming,
          duplicateIds: addedDuplicates,
        },
        messages,
      ),
      streamDirtyFrom: Math.min(changedIndex, messages.length),
      ...(sequenceReplaced
        ? { streamRev: (state.streamRev ?? 0) + 1 }
        : {}),
    },
    {
      toolExecutions: tools,
      streaming: streamingState,
      streamDirtyFrom: Math.min(changedIndex, messages.length),
      // Agent turn state is independent from individual message streaming.
      // Only agent_end closes the turn; any other agent event keeps it busy.
      meta: { ...state.meta, busy: deltaKind !== "agent_end" },
    },
  );
}
