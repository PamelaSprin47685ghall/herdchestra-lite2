// Pure snapshot shaping: cap oversized text so one browser frame cannot carry an
// unbounded transcript, then trim history until the frame fits. No I/O, no host
// imports, no station state. The station hands in a plain document and gets the
// same object back, trimmed.

import { groupTranscriptForDisplay } from "./transcript-model.mjs";

const MAX_SNAPSHOT_CHARS = 8 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 128 * 1024;
const MAX_TOOL_CHARS = 128 * 1024;
const MAX_ARGS_CHARS = 64 * 1024;
const MAX_ARTIFACT_CHARS = 128 * 1024;

function cappedText(value, limit) {
  if (typeof value !== "string" || value.length <= limit) return { text: value, truncated: false };
  return { text: `${value.slice(0, limit)}\n… [truncated]`, truncated: true };
}

function capValue(value, limit) {
  if (typeof value === "string") return cappedText(value, limit).text;
  if (Array.isArray(value)) return value.map((item) => capValue(item, limit));
  if (value && typeof value === "object") {
    const next = {};
    for (const [key, item] of Object.entries(value)) next[key] = capValue(item, limit);
    return next;
  }
  return value;
}

function capArgs(entry) {
  if (entry.args && typeof entry.args === "object") {
    const args = JSON.stringify(entry.args);
    if (args.length > MAX_ARGS_CHARS) {
      entry.args = { truncated: true, preview: args.slice(0, MAX_ARGS_CHARS) };
      entry.truncated = true;
    }
  }
}

function capBlock(block) {
  if (!block || typeof block !== "object") return block;
  const next = { ...block };
  if (typeof next.text === "string") {
    const capped = cappedText(next.text, MAX_MESSAGE_CHARS);
    next.text = capped.text;
    if (capped.truncated) next.truncated = true;
  }
  if (Array.isArray(next.result)) next.result = next.result.map(capBlock);
  if (typeof next.resultText === "string") next.resultText = capValue(next.resultText, MAX_TOOL_CHARS);
  capArgs(next);
  return next;
}

// A snapshot frame reprocesses the same message objects turn after turn. The cap
// is idempotent over an input object, so remember the shaped copy: a growing
// transcript otherwise pays one deep clone of every block on every frame.
const cappedMessages = new WeakMap();
const cappedTools = new WeakMap();
// The shaped copies above are immutable by construction, so their measured size
// is too. Without this cache every frame walks the whole window again — up to
// 128KB per message — to answer a number that cannot have changed.
const measuredSizes = new WeakMap();

export function capMessage(message) {
  if (!message || typeof message !== "object") return message;
  const cached = cappedMessages.get(message);
  if (cached) return cached;
  const next = shapeMessage(message);
  cappedMessages.set(message, next);
  return next;
}

function shapeMessage(message) {
  const next = { ...message };
  if (Array.isArray(next.blocks)) next.blocks = next.blocks.map(capBlock);
  for (const key of ["text", "output", "content", "summary", "command"]) {
    if (typeof next[key] === "string") {
      const capped = cappedText(next[key], MAX_MESSAGE_CHARS);
      next[key] = capped.text;
      if (capped.truncated) next.truncated = true;
    }
  }
  if (Array.isArray(next.result)) next.result = next.result.map(capBlock);
  return next;
}

export function capTool(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const cached = cappedTools.get(entry);
  if (cached) return cached;
  const next = shapeTool(entry);
  cappedTools.set(entry, next);
  return next;
}

function shapeTool(entry) {
  const next = { ...entry };
  for (const key of ["result", "partialResult"]) {
    if (typeof next[key] === "string") {
      const capped = cappedText(next[key], MAX_TOOL_CHARS);
      next[key] = capped.text;
      if (capped.truncated) next.truncated = true;
    } else if (next[key] && typeof next[key] === "object") {
      next[key] = capValue(next[key], MAX_TOOL_CHARS);
    }
  }
  capArgs(next);
  return next;
}

export function capArtifact(artifact) {
  if (!artifact || typeof artifact !== "object") return artifact;
  const next = { ...artifact };
  if (typeof next.content === "string") {
    const capped = cappedText(next.content, MAX_ARTIFACT_CHARS);
    next.content = capped.text;
    if (capped.truncated) next.truncated = true;
  }
  return next;
}

function sizeOf(value) {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((total, item) => total + sizeOf(item), 0);
  if (value && typeof value === "object") return Object.values(value).reduce((total, item) => total + sizeOf(item), 0);
  return 0;
}

// Measure a shaped item once. A primitive is measured directly; an object is
// cached by identity, exactly as `capMessage` caches its shaped copy.
function measureSize(value) {
  if (!value || typeof value !== "object") return sizeOf(value);
  const cached = measuredSizes.get(value);
  if (cached !== undefined) return cached;
  const size = sizeOf(value);
  measuredSizes.set(value, size);
  return size;
}

function sum(values) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

export function fitSnapshot(doc) {
  const requestedHasMore = doc.history?.hasMore === true;
  const initialMessageCount = doc.messages.length;
  // Measure each trimmable section once. The shrink loop only removes items
  // from the front, so its remaining size follows by subtraction instead of a
  // full document rescan per halving round.
  const messageSizes = doc.messages.map(measureSize);
  const toolKeys = Object.keys(doc.toolExecutions);
  const toolSizes = toolKeys.map((key) => measureSize(doc.toolExecutions[key]));
  const artifactSizes = doc.artifacts.map(measureSize);
  let messageTotal = sum(messageSizes);
  let toolTotal = sum(toolSizes);
  let artifactTotal = sum(artifactSizes);
  let messageLimit = messageSizes.length;
  let toolLimit = toolKeys.length;
  let artifactLimit = artifactSizes.length;
  // The three sections above were measured item by item. Subtracting them from
  // a second measurement of the whole document is the same number, but only
  // while `sizeOf(doc)` walks exactly those three properties plus the rest —
  // an assumption nothing states. Sum the remaining properties directly: the
  // value is identical, and it no longer depends on a subtraction cancelling
  // out. This walks the frame window the station hands in, not the session.
  let restTotal = 0;
  for (const [key, value] of Object.entries(doc)) {
    if (key === "messages" || key === "toolExecutions" || key === "artifacts") continue;
    restTotal += sizeOf(value);
  }
  let total = restTotal + messageTotal + toolTotal + artifactTotal;
  // Each round removes a prefix, so the dropped items are consecutive. Track
  // how far the prefix has advanced: subtracting from index 0 every round
  // would subtract already-removed items again and under-count the document.
  let messageDropped = 0;
  let toolDropped = 0;
  let artifactDropped = 0;
  while (
    total > MAX_SNAPSHOT_CHARS &&
    (messageLimit > 1 || toolLimit > 1 || artifactLimit > 1)
  ) {
    const nextMessageLimit = Math.max(1, Math.floor(messageLimit / 2));
    const nextToolLimit = Math.max(1, Math.floor(toolLimit / 2));
    const nextArtifactLimit = Math.max(1, Math.floor(artifactLimit / 2));
    const messageKeepFrom = messageSizes.length - nextMessageLimit;
    const toolKeepFrom = toolKeys.length - nextToolLimit;
    const artifactKeepFrom = artifactSizes.length - nextArtifactLimit;
    for (; messageDropped < messageKeepFrom; messageDropped += 1) {
      messageTotal -= messageSizes[messageDropped];
    }
    for (; toolDropped < toolKeepFrom; toolDropped += 1) {
      toolTotal -= toolSizes[toolDropped];
    }
    for (; artifactDropped < artifactKeepFrom; artifactDropped += 1) {
      artifactTotal -= artifactSizes[artifactDropped];
    }
    messageLimit = nextMessageLimit;
    toolLimit = nextToolLimit;
    artifactLimit = nextArtifactLimit;
    total = restTotal + messageTotal + toolTotal + artifactTotal;
  }
  if (messageLimit < messageSizes.length) doc.messages = doc.messages.slice(-messageLimit);
  if (toolLimit < toolKeys.length) {
    doc.toolExecutions = Object.fromEntries(
      toolKeys.slice(-toolLimit).map((key) => [key, doc.toolExecutions[key]]),
    );
  }
  if (artifactLimit < artifactSizes.length) doc.artifacts = doc.artifacts.slice(-artifactLimit);
  if (total > MAX_SNAPSHOT_CHARS) {
    doc.surface = capValue(doc.surface, MAX_MESSAGE_CHARS);
    doc.sessions = Array.isArray(doc.sessions) ? doc.sessions.slice(-50) : doc.sessions;
    doc.widgets = Array.isArray(doc.widgets)
      ? doc.widgets.slice(-50).map((widget) => ({
          ...widget,
          lines: Array.isArray(widget.lines)
            ? widget.lines.slice(-50).map((line) => capValue(line, MAX_MESSAGE_CHARS))
            : widget.lines,
        }))
      : doc.widgets;
  }
  doc.displayGroups = groupTranscriptForDisplay(doc.messages);
  doc.history = {
    hasMore: requestedHasMore || doc.messages.length < initialMessageCount,
    oldestId: doc.messages[0]?.id ?? null,
  };
  return doc;
}
