// Turns omp's persisted session entries and live agent events into one ordered
// transcript model. Persisted roles are camelCase; matching snake_case here
// would silently drop every tool result.

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

const MAX_STORED_TEXT = 128 * 1024;
const MAX_ARGS_TEXT = 64 * 1024;

function capStoredText(value, limit = MAX_STORED_TEXT) {
  if (typeof value !== "string" || value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… [truncated]`;
}

function capStoredValue(value, limit = MAX_STORED_TEXT) {
  if (typeof value === "string") return capStoredText(value, limit);
  if (Array.isArray(value)) return value.map((item) => capStoredValue(item, limit));
  if (value && typeof value === "object") {
    const next = {};
    for (const [key, item] of Object.entries(value)) next[key] = capStoredValue(item, limit);
    return next;
  }
  return value;
}

function capMessageTexts(message) {
  if (!message || typeof message !== "object") return message;
  if (Array.isArray(message.blocks)) {
    for (const block of message.blocks) {
      if (typeof block?.text === "string") {
        const capped = capStoredText(block.text);
        if (capped !== block.text) {
          block.text = capped;
          block.truncated = true;
        }
      }
    }
  }
  for (const key of ["text", "output", "content", "summary"]) {
    if (typeof message[key] === "string") message[key] = capStoredText(message[key]);
  }
  return message;
}

function blocksOf(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text ?? "" };
    if (block.type === "thinking") {
      return { type: "thinking", text: block.thinking ?? block.text ?? "" };
    }
    if (block.type === "toolCall") {
      return {
        type: "toolCall",
        id: block.id,
        name: block.name,
        args: block.arguments ?? block.args ?? {},
      };
    }
    if (block.type === "image") return { type: "image", ...block };
    return { ...block };
  });
}

const ANSI_RE = /\u001b\[[0-?]*[ -\/]*[@-~]/g;
function stripAnsi(value) {
  return typeof value === "string" ? value.replace(ANSI_RE, "") : value;
}
function cleanBlocks(blocks) {
  return blocks.map((block) =>
    block && typeof block.text === "string" ? { ...block, text: stripAnsi(block.text) } : block,
  );
}

function messageFromEntry(entry) {
  const message = entry.message;
  if (!message) return null;
  const role = message.role;
  const base = {
    id: entry.id,
    role,
    attribution: message.attribution ?? null,
    synthetic: message.synthetic === true,
    herdSkill: message.herdSkill === true,
    timestamp: message.timestamp ?? entry.timestamp,
  };
  if (role === "user" || role === "assistant" || role === "developer") {
    return { ...base, blocks: cleanBlocks(blocksOf(message.content)), text: stripAnsi(textOf(message.content)) };
  }
  if (role === "toolResult") {
    return {
      ...base,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: Boolean(message.isError),
      blocks: cleanBlocks(blocksOf(message.content)),
      text: stripAnsi(textOf(message.content)),
    };
  }
  if (role === "bashExecution") {
    const output = stripAnsi(message.output ?? "");
    return {
      ...base,
      command: stripAnsi(message.command),
      output,
      exitCode: message.exitCode,
      blocks: [{ type: "text", text: output }],
    };
  }
  if (role === "pythonExecution") {
    const output = stripAnsi(message.output ?? "");
    return {
      ...base,
      code: stripAnsi(message.code),
      output,
      blocks: [{ type: "text", text: output }],
    };
  }
  if (role === "fileMention") {
    return { ...base, path: message.path, content: message.content };
  }
  return { ...base, blocks: blocksOf(message.content), text: textOf(message.content) };
}

export function reconstructTranscriptFromEntries(entries) {
  const messages = [];
  for (const entry of entries ?? []) {
    if (!entry) continue;
    if (entry.type === "message") {
      const message = messageFromEntry(entry);
      if (message) messages.push(message);
      continue;
    }
    if (entry.type === "custom_message") {
      messages.push({
        id: entry.id,
        role: "custom",
        customType: entry.customType,
        text: typeof entry.content === "string" ? entry.content : textOf(entry.content),
        excludeFromContext: Boolean(entry.excludeFromContext),
        timestamp: entry.timestamp,
      });
      continue;
    }
    if (entry.type === "branch_summary") {
      messages.push({
        id: entry.id,
        role: "branchSummary",
        summary: entry.summary,
        blocks: [{ type: "text", text: entry.summary ?? "" }],
        timestamp: entry.timestamp,
      });
      continue;
    }
    if (entry.type === "compaction") {
      messages.push({
        id: entry.id,
        role: "compactionSummary",
        summary: entry.summary,
        blocks: [{ type: "text", text: entry.summary ?? "" }],
        timestamp: entry.timestamp,
      });
    }
  }

  const results = new Map();
  for (const message of messages) {
    if (message.role === "toolResult") results.set(message.toolCallId, message);
  }
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.blocks) {
      if (block.type !== "toolCall") continue;
      const result = results.get(block.id);
      if (result) {
        block.result = result.blocks;
        block.resultText = result.text;
        block.isError = result.isError;
      }
    }
  }
  return messages;
}

function upsertBlock(blocks, type, text) {
  const last = blocks[blocks.length - 1];
  const delta = String(text ?? "");
  if (last && last.type === type) {
    const current = typeof last.text === "string" ? last.text : "";
    const room = Math.max(0, MAX_STORED_TEXT - current.length);
    if (room === 0) {
      last.truncated = true;
      return blocks.length - 1;
    }
    if (delta.length > room) {
      last.text = `${current}${delta.slice(0, room)}\n… [truncated]`;
      last.truncated = true;
    } else {
      last.text = `${current}${delta}`;
    }
    return blocks.length - 1;
  }
  const truncated = delta.length > MAX_STORED_TEXT;
  blocks.push({
    type,
    text: truncated ? `${delta.slice(0, MAX_STORED_TEXT)}\n… [truncated]` : delta,
    ...(truncated ? { truncated: true } : {}),
  });
  return blocks.length - 1;
}

function streamingFrom(event) {
  return {
    id: event.message?.id,
    role: event.message?.role ?? "assistant",
    attribution: event.message?.attribution ?? null,
    synthetic: event.message?.synthetic === true,
    herdSkill: event.message?.herdSkill === true,
    blocks: [],
    timestamp: event.message?.timestamp,
  };
}

export function applyAgentEvent(state, event) {
  const next = {
    messages: state.messages ?? [],
    streaming: state.streaming ?? null,
    toolExecutions: state.toolExecutions ?? {},
  };
  if (!event) return next;

  if (event.type === "message_start") {
    next.streaming = streamingFrom(event);
    return next;
  }

  if (event.type === "message_update") {
    if (!next.streaming) {
      next.streaming = streamingFrom(event);
    }
    const update = event.assistantMessageEvent;
    if (!update) return next;
    if (update.type === "thinking_delta") {
      next.blockIndex = upsertBlock(next.streaming.blocks, "thinking", update.delta ?? "");
    } else if (update.type === "text_delta") {
      next.blockIndex = upsertBlock(next.streaming.blocks, "text", update.delta ?? "");
    } else if (update.type === "toolcall_start") {
      next.streaming.blocks.push({
        type: "toolCall",
        id: update.toolCallId,
        name: update.toolName,
        args: {},
        argsText: "",
      });
      next.blockIndex = next.streaming.blocks.length - 1;
    } else if (update.type === "toolcall_delta") {
      const index = next.streaming.blocks.findIndex(
        (item) => item.type === "toolCall" && item.id === update.toolCallId,
      );
      const block = next.streaming.blocks[index];
      if (block) {
        const current = typeof block.argsText === "string" ? block.argsText : "";
        const room = Math.max(0, MAX_ARGS_TEXT - current.length);
        const raw = String(update.argumentsDelta ?? "");
        if (room > 0) block.argsText = current + raw.slice(0, room);
        if (raw.length > room) block.truncated = true;
        next.blockIndex = index;
      }
    } else if (update.type === "toolcall_end") {
      const index = next.streaming.blocks.findIndex(
        (item) => item.type === "toolCall" && item.id === update.toolCallId,
      );
      const block = next.streaming.blocks[index];
      if (block) {
        if (update.arguments !== undefined) block.args = update.arguments;
        else if (block.argsText) {
          try {
            block.args = JSON.parse(block.argsText);
          } catch {
            block.args = block.args ?? {};
          }
        }
        block.args = capStoredValue(block.args ?? {}, MAX_ARGS_TEXT);
        delete block.argsText;
        next.blockIndex = index;
      }
    }
    return next;
  }

  if (event.type === "message_end") {
    const raw = event.message;
    const finalized = raw?.role && (typeof raw.content === "string" || raw.content?.length)
      ? messageFromEntry({ id: raw.id ?? next.streaming?.id ?? `${raw.role}:${raw.timestamp ?? "message"}:${next.messages.length}`, message: raw })
      : next.streaming
        ? { ...next.streaming, attribution: raw?.attribution ?? next.streaming.attribution ?? null }
        : next.streaming;
    if (finalized) {
      capMessageTexts(finalized);
      const index = finalized.id == null ? -1 : next.messages.findIndex((message) => message.id === finalized.id);
      if (index < 0) next.messages.push(finalized);
      else next.messages[index] = finalized;
    }
    next.streaming = null;
    return next;
  }

  if (
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_update" ||
    event.type === "tool_execution_end"
  ) {
    const id = event.toolCallId;
    const current = next.toolExecutions[id] ?? { toolCallId: id };
    if (event.type === "tool_execution_start") {
      next.toolExecutions[id] = {
        ...current,
        toolName: event.toolName,
        args: capStoredValue(event.args, MAX_ARGS_TEXT),
        status: "running",
      };
    } else if (event.type === "tool_execution_update") {
      next.toolExecutions[id] = {
        ...current,
        toolName: event.toolName,
        partialResult: capStoredValue(event.partialResult, MAX_STORED_TEXT),
        status: "running",
      };
    } else {
      next.toolExecutions[id] = {
        ...current,
        toolName: event.toolName,
        result: capStoredValue(event.result, MAX_STORED_TEXT),
        isError: Boolean(event.isError),
        status: "completed",
      };
    }
  }
  return next;
}

function hasVisibleText(text) {
  return typeof text === "string" && text.trim().length > 0;
}

export function isRealUser(item) {
  return item?.role === "user" && item.attribution === "user" && item.synthetic !== true;
}

function stepFromBlock(block, message) {
  if (block.type === "thinking" && hasVisibleText(block.text)) {
    return { kind: "thinking", text: block.text, messageId: message.id };
  }
  if (block.type === "toolCall") {
    return {
      kind: "tool",
      id: block.id,
      name: block.name,
      args: block.args ?? {},
      messageId: message.id,
    };
  }
  if (block.type === "text" && hasVisibleText(block.text)) {
    return { kind: "text", text: block.text, mode: "step", messageId: message.id };
  }
  return null;
}

function lastStepIndexIn(blocks) {
  return blocks.reduce(
    (last, block, index) => (block.type === "thinking" || block.type === "toolCall" ? index : last),
    -1,
  );
}

// A user message opens a turn. Inside one turn, thinking, tool calls and
// intermediate text are all steps; only the final assistant's trailing text
// is the answer body. A transcript segment with no user message keeps the
// legacy boundary: a text-only assistant message is a standalone answer.
export function groupTranscriptForDisplay(items) {
  const groups = [];
  let turn = [];
  let turnHasUser = false;

  const emit = (segment, allowBody) => {
    if (!segment || segment.length === 0) return;
    const assistants = segment.filter((item) => item.role === "assistant");
    const toolResults = segment.filter((item) => item.role === "toolResult");
    const lastAssistant = assistants[assistants.length - 1];
    let bodyText = null;
    if (allowBody && lastAssistant) {
      const blocks = lastAssistant.blocks ?? [];
      const lastStepIndex = lastStepIndexIn(blocks);
      const trailing = blocks
        .slice(lastStepIndex + 1)
        .filter((block) => block.type === "text" && hasVisibleText(block.text));
      if (trailing.length > 0) bodyText = trailing[trailing.length - 1].text;
    }
    const steps = [];
    const cards = [];
    for (const message of segment) {
      if (message.role === "user" && !isRealUser(message)) {
        if (hasVisibleText(message.text)) {
          steps.push({
            kind: message.herdSkill === true ? "text" : "input",
            text: message.text,
            messageId: message.id,
          });
        }
        continue;
      }
      if (message.role === "custom") {
        const customBlocks = message.blocks ?? [];
        const customSteps = customBlocks
          .map((block) => stepFromBlock(block, message))
          .filter(Boolean);
        if (customSteps.length > 0) steps.push(...customSteps);
        else if (hasVisibleText(message.text)) {
          steps.push({ kind: "text", text: message.text, mode: "step", messageId: message.id });
        }
        continue;
      }
      if (message.role !== "assistant") continue;
      const blocks = message.blocks ?? [];
      const taskCalls = blocks.filter(
        (block) => block.type === "toolCall" && block.name === "task",
      );
      const nonTaskBlocks = blocks.filter(
        (block) => block.type === "thinking" || block.type === "text"
          || (block.type === "toolCall" && block.name !== "task"),
      );
      if (taskCalls.length > 0 && nonTaskBlocks.length === 0) {
        cards.push({ kind: "subagent_card", message, items: taskCalls });
        continue;
      }
      const isBody = allowBody && message === lastAssistant && bodyText !== null;
      const lastStepIndex = lastStepIndexIn(blocks);
      for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        if (isBody && block.type === "text" && index > lastStepIndex) continue;
        const step = stepFromBlock(block, message);
        if (step) steps.push(step);
      }
    }
    if (steps.length > 0) {
      const group = { kind: "step_group", steps };
      for (const result of toolResults) {
        const step = steps.find(
          (entry) => entry.kind === "tool" && entry.id === result.toolCallId,
        );
        if (step) step.toolResult = result;
        else {
          group.items = group.items ?? [];
          group.items.push(result);
        }
      }
      groups.push(group);
    }
    for (const card of cards) groups.push(card);
    if (allowBody && lastAssistant && bodyText !== null) {
      groups.push({ kind: "assistant_message", message: lastAssistant });
    }
  };

  const flushTurn = (allowBody) => {
    if (turn.length === 0) return;
    if (turnHasUser) {
      emit(turn, allowBody);
      turn = [];
      return;
    }
    let segment = [];
    for (const item of turn) {
      if (item.role === "assistant") {
        const blocks = item.blocks ?? [];
        const hasText = blocks.some(
          (block) => block.type === "text" && hasVisibleText(block.text),
        );
        const hasStep = blocks.some(
          (block) => block.type === "thinking" || block.type === "toolCall",
        );
        if (hasText && !hasStep) {
          emit(segment, true);
          groups.push({ kind: "assistant_message", message: item });
          segment = [];
          continue;
        }
      }
      segment.push(item);
    }
    emit(segment, true);
    turn = [];
  };

  for (const item of items ?? []) {
    if (!item || !item.role) continue;
    if (item.role === "user" && isRealUser(item)) {
      flushTurn(true);
      turnHasUser = true;
      const hasVisible = (item.blocks ?? []).some(
        (block) => block.type === "text" && hasVisibleText(block.text),
      ) || hasVisibleText(item.text);
      if (hasVisible) groups.push({ kind: "user_message", message: item });
      continue;
    }
    if (item.role === "user") {
      turn.push(item);
      continue;
    }
    if (item.role === "bashExecution" || item.role === "pythonExecution") {
      flushTurn();
      turnHasUser = false;
      groups.push({ kind: "terminal_run", message: item });
      continue;
    }
    if (item.role === "compactionSummary" || item.role === "branchSummary") {
      flushTurn();
      turnHasUser = false;
      groups.push({ kind: "boundary_summary", message: item });
      continue;
    }
    if (item.role === "assistant" || item.role === "toolResult" || item.role === "custom") {
      turn.push(item);
    }
  }
  flushTurn(true);
  return groups;
}

