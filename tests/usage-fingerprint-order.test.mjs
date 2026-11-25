// Two rules the fingerprint memo must never break, both about code it does not
// own. First, matching a cached shape must not run anything: a property that was
// data when the shape was built can become an accessor afterwards, and reading
// it to compare would execute user code a second time per request. Second, the
// character count keeps its own pass, ahead of the digests, because that pass is
// not inert — `sliceChars` stringifies tool-call arguments.
//
// Each test reads an observable trace (how often user code ran, in what order)
// rather than an internal flag, so it stays honest if the memo is rewritten.

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { createUsageLedger } from "../src/scope/usage-ledger.mjs";
import { createState } from "../src/scope/state.mjs";
import { sliceChars } from "../src/transcript/index.mjs";

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

function record(ledger, messages) {
  ledger.noteSentContext({ key: "model", messages });
  return ledger.sentContext;
}

const freshHash = (message) =>
  createHash("sha256").update(JSON.stringify(message) ?? "null").digest("hex");

test("a property that becomes an accessor is never run by the cached match", () => {
  const ledger = ledgerFor();
  const message = { role: "user", content: "plain" };
  const first = record(ledger, [message]).messageHashes[0];
  expect(first).toBe(freshHash(message));

  // Nothing about the message changes except how `content` is stored.
  let reads = 0;
  Object.defineProperty(message, "content", {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return "plain";
    },
  });

  record(ledger, [message]);
  // Two reads, both the caller's own: `sliceChars` counts the content, then
  // `JSON.stringify` serializes it. A comparison that read `value.content`
  // instead of its descriptor would add a third of its own.
  expect(reads).toBe(2);
  record(ledger, [message]);
  expect(reads).toBe(4);
});

test("an accessor nested in a cached message is never run by the cached match", () => {
  const ledger = ledgerFor();
  const block = { type: "text", text: "hello" };
  const message = { role: "assistant", content: [block] };
  record(ledger, [message]);

  let reads = 0;
  Object.defineProperty(block, "text", {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return "hello";
    },
  });

  const sent = record(ledger, [message]);
  // `JSON.stringify` reads it once; `sliceChars` reads it once.
  expect(reads).toBe(2);
  expect(sent.messageHashes[0]).toBe(
    createHash("sha256")
      .update('{"role":"assistant","content":[{"type":"text","text":"hello"}]}')
      .digest("hex"),
  );
});

test("a swapped-in Getter whose value differs still moves the digest", () => {
  const ledger = ledgerFor();
  const message = { role: "user", content: "before" };
  const first = record(ledger, [message]).messageHashes[0];
  Object.defineProperty(message, "content", {
    enumerable: true,
    configurable: true,
    get: () => "after",
  });
  const second = record(ledger, [message]).messageHashes[0];
  expect(second).not.toBe(first);
  expect(second).toBe(
    createHash("sha256").update('{"role":"user","content":"after"}').digest("hex"),
  );
});

test("the character count still takes its own pass, before the digests", () => {
  const ledger = ledgerFor();
  const trace = [];
  const args = {
    command: "ls",
    toJSON() {
      trace.push("chars:args");
      return { command: "ls" };
    },
  };
  const message = {
    role: "assistant",
    content: [{ type: "toolCall", id: "c1", name: "bash", arguments: args }],
    toJSON() {
      trace.push("digest:message");
      return { role: "assistant", content: [] };
    },
  };

  const sent = record(ledger, [message]);
  // The count reads the tool-call arguments first; the digest pass follows.
  expect(trace).toEqual(["chars:args", "digest:message"]);
  expect(sent.chars).toBe(JSON.stringify({ command: "ls" }).length);
});

test("a message edited after its digest keeps the counted characters in step", () => {
  const ledger = ledgerFor();
  const message = {
    role: "assistant",
    content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
  };
  expect(record(ledger, [message]).chars).toBe(sliceChars([message]));
  message.content[0].arguments = { command: "ls -la" };
  const sent = record(ledger, [message]);
  expect(sent.chars).toBe(sliceChars([message]));
  expect(sent.messageHashes[0]).toBe(freshHash(message));
});

test("a repeated request costs one count pass and no serialization of unchanged bodies", () => {
  const ledger = ledgerFor();
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: "body ".repeat(20) + index }],
  }));
  const first = record(ledger, messages);
  const second = record(ledger, messages);
  expect(second.messageHashes).toEqual(first.messageHashes);
  expect(second.chars).toBe(first.chars);
  expect(second.chars).toBe(sliceChars(messages));
});
