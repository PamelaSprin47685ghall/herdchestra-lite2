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

/**
 * One entry as a display message, or null when it shows nothing.
 *
 * This is the same projection `reconstructTranscriptFromEntries` performs, per
 * entry. A range rebuild needs it on its own, because it must be able to read a
 * single entry that lies outside the page it is building.
 */
function messageOfEntry(entry) {
  if (!entry) return null;
  if (entry.type === "message") return messageFromEntry(entry);
  if (entry.type === "custom_message") {
    return {
      id: entry.id,
      role: "custom",
      customType: entry.customType,
      text: typeof entry.content === "string" ? entry.content : textOf(entry.content),
      excludeFromContext: Boolean(entry.excludeFromContext),
      timestamp: entry.timestamp,
    };
  }
  if (entry.type === "branch_summary") {
    return {
      id: entry.id,
      role: "branchSummary",
      summary: entry.summary,
      blocks: [{ type: "text", text: entry.summary ?? "" }],
      timestamp: entry.timestamp,
    };
  }
  if (entry.type === "compaction") {
    return {
      id: entry.id,
      role: "compactionSummary",
      summary: entry.summary,
      blocks: [{ type: "text", text: entry.summary ?? "" }],
      timestamp: entry.timestamp,
    };
  }
  return null;
}

/**
 * Whether an entry projects to a message at all.
 *
 * Not every entry does: an entry without a `message` payload, and any type this
 * model does not display, contributes nothing. That is why a range cannot be
 * addressed by entry position — entry 7 may be the fifth message — and why the
 * index carries the entry position of each message instead.
 *
 * The branches below mirror `messageOfEntry`. Constructing each projection just
 * to ask whether it exists would cost one full projection per entry — blocks,
 * ANSI stripping, text joins — on every index build, which is the whole cost a
 * long session cannot afford twice. The tests pin this predicate against that
 * projection so the two cannot drift.
 */
function hasMessage(entry) {
  if (!entry) return false;
  if (entry.type === "message") return Boolean(entry.message);
  return (
    entry.type === "custom_message" ||
    entry.type === "branch_summary" ||
    entry.type === "compaction"
  );
}

/**
 * The index a branch has grown into.
 *
 * The host appends to its own array while the session runs, so a frame taken
 * after an append used to rebuild the whole index — one tour of every entry, on
 * every append. On a session of two hundred thousand entries that is tens of
 * milliseconds per frame, spent to learn one new position.
 *
 * Only the tail is read here. The three maps keep the meaning they have in a
 * full build: a first match wins for `idIndex`, `idOrdinals` names the first
 * entry that shows, and `resultIndex` takes the last result for a call id —
 * assignment order across the tail preserves all three, because every entry
 * before it was already folded in.
 *
 * A shorter array, or a different one, is not a growth: the caller gets a full
 * build. The returned object is new and the previous one keeps its own
 * `entryCount`, so a holder of the old index sees a length it does not describe
 * and rebuilds rather than reading a position past what it validated.
 */
export function extendHistoryIndex(index, entries) {
  const list = entries ?? [];
  if (!index || index.source !== list || list.length < index.entryCount) {
    return buildHistoryIndex(list);
  }
  if (list.length === index.entryCount) {
    // Equal length is not proof of no change. A branch can be rewound and
    // re-appended to the same length — that is what switching branches does —
    // and the result is a different conversation of the same size. Reusing the
    // index then resolves ids that no longer exist and answers -1 for the ones
    // that do, so a page request against a message that is right there reads as
    // a stale cursor. The last entry is the cheap anchor: an append keeps the
    // one it had, and a rewrite replaces it.
    const tail = list.length > 0 ? list[list.length - 1] : null;
    return index.tailRef === tail ? index : buildHistoryIndex(list);
  }
  for (let at = index.entryCount; at < list.length; at += 1) {
    const entry = list[at];
    if (!entry) continue;
    if (entry.id != null && !index.idIndex.has(entry.id)) index.idIndex.set(entry.id, at);
    if (entry.type === "message" && entry.message?.role === "toolResult") {
      index.resultIndex.set(entry.message.toolCallId, at);
    }
    if (hasMessage(entry)) {
      if (entry.id != null && !index.idOrdinals.has(entry.id)) {
        index.idOrdinals.set(entry.id, index.entryOfMessage.length);
      }
      index.entryOfMessage.push(at);
    }
  }
  return {
    ...index,
    entryCount: list.length,
    tailRef: list.length > 0 ? list[list.length - 1] : null,
  };
}

export function buildHistoryIndex(entries) {
  const list = entries ?? [];
  const idIndex = new Map();
  // Cursor ordinals, keyed by id, for the first entry that actually shows.
  //
  // `idIndex` answers "is this id anywhere in the branch", which is a question
  // about entries. A cursor asks a different one: "which message is this". An
  // entry that projects to nothing takes no ordinal, so letting it own the id
  // would resolve a cursor that `findIndex` over messages answers as missing —
  // a page request reported stale while the message sits right there.
  const idOrdinals = new Map();
  const resultIndex = new Map();
  // Message ordinal to entry position. The station speaks in messages — its
  // window, its cursor and its slice bounds are all message indices — so this
  // is the map that keeps an entry position from leaking into those bounds.
  const entryOfMessage = [];
  for (let at = 0; at < list.length; at += 1) {
    const entry = list[at];
    if (!entry) continue;
    if (entry.id != null && !idIndex.has(entry.id)) idIndex.set(entry.id, at);
    if (entry.type === "message" && entry.message?.role === "toolResult") {
      resultIndex.set(entry.message.toolCallId, at);
    }
    if (hasMessage(entry)) {
      // First entry that shows wins, which is what `findIndex` answers.
      if (entry.id != null && !idOrdinals.has(entry.id)) {
        idOrdinals.set(entry.id, entryOfMessage.length);
      }
      entryOfMessage.push(at);
    }
  }
  // The array this index describes, so a caller cannot silently use it against
  // another one. See the validity check in `reconstructRange`.
  return {
    idIndex,
    idOrdinals,
    resultIndex,
    entryOfMessage,
    source: list,
    entryCount: list.length,
    // The last entry this index was built against. It is a hint, not a proof:
    // a tail that changed means the branch was rewritten, so the index cannot be
    // reused; an unchanged tail only means nothing after the head moved. An edit
    // in the middle of a branch whose tail still matches is not detectable here
    // at O(1) — that case belongs to an explicit branch switch (`resetHistory`),
    // which is where the host says the conversation changed. Without another
    // owner of the array, a per-entry comparison is the only proof, and it costs
    // the whole branch on every frame, which is exactly what this index exists
    // to avoid.
    tailRef: list.length > 0 ? list[list.length - 1] : null,
  };
}

/**
 * The message ordinal of an entry position, or -1 when that entry is not shown.
 *
 * The id and result maps hold *entry* positions, because that is the only unit
 * the entries themselves have. Every bound the station applies — its window, its
 * cursor, its page slice — is a message ordinal. This is the conversion between
 * the two, and it uses the first match for a position exactly as `idIndex` keeps
 * the first entry for an id.
 */
export function messageOrdinalOfEntry(index, entryIndex) {
  const list = index?.entryOfMessage ?? [];
  let low = 0;
  let high = list.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const value = list[middle];
    if (value === entryIndex) return middle;
    if (value < entryIndex) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

/** The message ordinal for a message id, or -1 when no shown entry carries it. */
export function messageOrdinalOfId(index, id) {
  const ordinal = index?.idOrdinals?.get(id);
  if (ordinal !== undefined) return ordinal;
  // No entry that shows carries this id. `idIndex` may still know it — an entry
  // that projects to nothing — and `findIndex` over messages answered -1 for
  // exactly that shape, so a page request against it stays stale.
  return -1;
}

/**
 * Rebuild the display messages for entries `[from, to)` only.
 *
 * A page must show the same messages the whole-transcript rebuild would show for
 * that range. The one thing a page cannot answer from itself is a tool call whose
 * result sits on another page, so each call block is paired through
 * `resultIndex` and the result entry is rebuilt on its own. That is the same
 * entry the whole-transcript pass would have paired — the index keeps the last
 * result per call id, exactly as that pass does — so a cross-page result reads
 * the same as an in-page one.
 */
export function reconstructRange(entries, from, to, index) {
  const list = entries ?? [];
  // An index is only valid for the array it was built from. Accepting a stale one
  // would answer from positions that no longer exist — a page taken from the
  // wrong entry, with no error anywhere. A length change is the cheap signal; the
  // identity check catches a replaced array that happens to have the same length.
  const positions =
    index && index.source === list && index.entryCount === list.length
      ? index
      : buildHistoryIndex(list);
  // `from` and `to` are message ordinals, which is the only thing callers of
  // this kernel bound: the station slices its window and its pages by message.
  // An entry position would be the wrong unit here — an entry that projects to
  // nothing would shift every later index, so a page could start inside a turn
  // or skip a message that the whole rebuild shows.
  const total = positions.entryOfMessage.length;
  const start = Math.max(0, Math.min(Number.isInteger(from) ? from : 0, total));
  const end = Math.max(start, Math.min(Number.isInteger(to) ? to : total, total));
  const messages = [];
  // Entry position to the message built from it on *this* page. A result that
  // lands on the page must be the very object the page already holds, so a tool
  // call's `result` blocks are the same array as that tool result message's —
  // which is what the whole-transcript rebuild produces. Rebuilding the entry a
  // second time would give equal contents and a different identity, and a reader
  // that compares either way would see a difference the old code never had.
  const builtByEntry = new Map();
  // Results rebuilt from outside the page, kept per entry. Two tool calls can
  // name the same call id — a retried call, or two blocks that reuse an id — and
  // the whole-transcript pass gives every one of them the same `blocks` array,
  // because it pairs one message object. Rebuilding that entry per call would
  // give equal contents with different identities, and would pay the projection
  // once per call on a page whose result lives elsewhere.
  const rebuiltResults = new Map();
  for (let ordinal = start; ordinal < end; ordinal += 1) {
    const at = positions.entryOfMessage[ordinal];
    const message = messageOfEntry(list[at]);
    if (!message) continue;
    messages.push(message);
    builtByEntry.set(at, message);
  }
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.blocks) {
      if (block.type !== "toolCall") continue;
      const at = positions.resultIndex.get(block.id);
      if (at === undefined) continue;
      // A result on this page is the object the page already holds; one from
      // another page is rebuilt on its own, once per entry. Both give the same
      // contents, and the in-page case keeps the identity the whole-transcript
      // pass produced.
      let result = builtByEntry.get(at);
      if (result === undefined) {
        if (rebuiltResults.has(at)) {
          result = rebuiltResults.get(at);
        } else {
          result = messageOfEntry(list[at]);
          rebuiltResults.set(at, result);
        }
      }
      if (!result || result.role !== "toolResult") continue;
      block.result = result.blocks;
      block.resultText = result.text;
      block.isError = result.isError;
    }
  }
  return messages;
}

/**
 * The whole branch as display messages.
 *
 * This is the range rebuild over the whole branch. One projection, one
 * implementation: a page and a full rebuild cannot drift apart, and the pairing
 * rule a page relies on is the rule this path has always used.
 */
export function reconstructTranscriptFromEntries(entries) {
  const list = entries ?? [];
  return reconstructRange(list, 0, list.length);
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

// Appending a finalized message used to scan the whole transcript by id, so a
// long session paid O(n) per message. The map lives on the array itself, so a
// replaced array (session switch) starts clean; it is a symbol, so no clone,
// spread or JSON pass can see it.
const MESSAGE_INDEX = Symbol("herd.messageIndex");

// The holder carries the length it was built for: a message can be appended
// without an id, and a map-only size check would then rebuild on every append.
function messageIndex(messages) {
  const existing = messages[MESSAGE_INDEX];
  if (existing && existing.length === messages.length) return existing;
  const ids = new Map();
  for (let at = 0; at < messages.length; at += 1) {
    const id = messages[at]?.id;
    if (id != null && !ids.has(id)) ids.set(id, at);
  }
  const holder = { length: messages.length, ids };
  Object.defineProperty(messages, MESSAGE_INDEX, { value: holder, configurable: true });
  return holder;
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
      // Arguments arrive as many small deltas. A remembered block index keeps
      // each delta O(1) instead of scanning every block of the message again;
      // the id check falls back to a scan whenever the hint has gone stale.
      const blocks = next.streaming.blocks;
      const hint = next.blockIndex;
      const hinted = Number.isInteger(hint) ? blocks[hint] : undefined;
      const index = hinted?.type === "toolCall" && hinted.id === update.toolCallId
        ? hint
        : blocks.findIndex(
          (item) => item.type === "toolCall" && item.id === update.toolCallId,
        );
      const block = blocks[index];
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
      const messages = next.messages;
      const holder = messageIndex(messages);
      const index = finalized.id == null ? -1 : holder.ids.get(finalized.id) ?? -1;
      if (index < 0) {
        if (finalized.id != null) holder.ids.set(finalized.id, messages.length);
        messages.push(finalized);
        holder.length = messages.length;
      } else {
        messages[index] = finalized;
      }
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
      // One pass instead of scanning every step for every tool result, which
      // is quadratic inside a turn with many tool calls.
      // Keyed by whatever the step carries, `undefined` included: a tool result
      // without a call id matched the first step without an id before this pass
      // replaced the scan, and it still must.
      const stepByToolCall = new Map();
      for (const entry of steps) {
        if (entry.kind !== "tool") continue;
        if (!stepByToolCall.has(entry.id)) stepByToolCall.set(entry.id, entry);
      }
      for (const result of toolResults) {
        const step = stepByToolCall.get(result.toolCallId);
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

