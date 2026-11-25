import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createUsageLedger } from "../src/scope/usage-ledger.mjs";
import { createState } from "../src/scope/state.mjs";
import { sliceChars } from "../src/transcript/index.mjs";

// The fingerprints are memoized by shape, not by identity: an unchanged
// message keeps its digest without being re-serialized, and any edit that
// could change the digest is still caught. These cases pin that the memo
// answers exactly what a fresh serialization answers.

function ledgerFor() {
  return createUsageLedger({
    state: createState(),
    contextMessages: () => [],
    persist() {},
    noteError() {},
    modelKeyOf: () => "model",
    actualModelOf: () => null,
  });
}

const digest = (message) =>
  createHash("sha256").update(JSON.stringify(message) ?? "null").digest("hex");

function record(ledger, messages) {
  ledger.noteSentContext({ key: "model", messages });
  return ledger.sentContext;
}

test("a memoized fingerprint equals a fresh serialization on every call", () => {
  const ledger = ledgerFor();
  const messages = [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 5 },
    { role: "toolResult", toolCallId: "c1", content: "out" },
  ];
  for (let round = 0; round < 4; round += 1) {
    const sent = record(ledger, messages);
    expect(sent.messageHashes).toEqual(messages.map(digest));
    expect(sent.chars).toBe(sliceChars(messages));
  }
});

test("an added key is visible to the memo", () => {
  const ledger = ledgerFor();
  const message = { role: "user", content: "before" };
  const first = record(ledger, [message]).messageHashes[0];
  message.extra = 1;
  expect(record(ledger, [message]).messageHashes[0]).toBe(digest(message));
  expect(record(ledger, [message]).messageHashes[0]).not.toBe(first);
});

test("a deleted key is visible to the memo", () => {
  const ledger = ledgerFor();
  const message = { role: "user", content: "text", timestamp: 4 };
  record(ledger, [message]);
  delete message.timestamp;
  expect(record(ledger, [message]).messageHashes[0]).toBe(digest(message));
});

test("a nested array edit is visible to the memo", () => {
  const ledger = ledgerFor();
  const message = { role: "user", content: [{ type: "text", text: "a" }] };
  record(ledger, [message]);
  message.content.push({ type: "text", text: "b" });
  const sent = record(ledger, [message]);
  expect(sent.messageHashes[0]).toBe(digest(message));
  expect(sent.chars).toBe(sliceChars([message]));
});

test("payable characters follow a tool-call argument rewrite", () => {
  const ledger = ledgerFor();
  const message = {
    role: "assistant",
    content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
  };
  record(ledger, [message]);
  message.content[0].arguments = { command: "ls -la" };
  expect(record(ledger, [message]).chars).toBe(sliceChars([message]));
});

test("a replaced message object keeps the answer a fresh hash gives", () => {
  const ledger = ledgerFor();
  const first = { role: "user", content: "same" };
  const second = { role: "user", content: "same" };
  record(ledger, [first]);
  const sent = record(ledger, [second]);
  // Equal content, different objects: the memo may reuse the text it already
  // hashed only when the walk proves it, and either way the digest is the same.
  expect(sent.messageHashes[0]).toBe(digest(second));
});
