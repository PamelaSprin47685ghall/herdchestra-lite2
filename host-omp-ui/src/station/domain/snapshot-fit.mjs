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

export function capMessage(message) {
  if (!message || typeof message !== "object") return message;
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

export function fitSnapshot(doc) {
  const requestedHasMore = doc.history?.hasMore === true;
  const initialMessageCount = doc.messages.length;
  let messageLimit = doc.messages.length;
  let toolLimit = Object.keys(doc.toolExecutions).length;
  let artifactLimit = doc.artifacts.length;
  while (
    sizeOf(doc) > MAX_SNAPSHOT_CHARS &&
    (messageLimit > 1 || toolLimit > 1 || artifactLimit > 1)
  ) {
    messageLimit = Math.max(1, Math.floor(messageLimit / 2));
    toolLimit = Math.max(1, Math.floor(toolLimit / 2));
    artifactLimit = Math.max(1, Math.floor(artifactLimit / 2));
    doc.messages = doc.messages.slice(-messageLimit);
    doc.toolExecutions = Object.fromEntries(Object.entries(doc.toolExecutions).slice(-toolLimit));
    doc.artifacts = doc.artifacts.slice(-artifactLimit);
  }
  if (sizeOf(doc) > MAX_SNAPSHOT_CHARS) {
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
