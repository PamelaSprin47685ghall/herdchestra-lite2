// The fingerprint memo answers "is this still the same message?" from a shape
// walk instead of a re-serialization. These tests pin the exact edges where a
// key list alone would lie: an array's length, a non-enumerable own property,
// and an own `toJSON` whose answer lives outside the message. Each case fails
// on an implementation that trusts `Object.keys` alone, and each passes only
// when the memo answers what a fresh hash answers.

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

function fresh(message) {
  return {
    hash: createHash("sha256").update(JSON.stringify(message) ?? "null").digest("hex"),
    chars: sliceChars([message]),
  };
}

function record(ledger, messages) {
  ledger.noteSentContext({ key: "model", messages });
  return ledger.sentContext;
}

function expectFresh(ledger, message) {
  const sent = record(ledger, [message]);
  const expected = fresh(message);
  expect(sent.messageHashes[0]).toBe(expected.hash);
  expect(sent.chars).toBe(expected.chars);
}

test("an array that grows a trailing hole is a different message", () => {
  const ledger = ledgerFor();
  const message = { role: "user", content: [{ type: "text", text: "a" }] };
  expectFresh(ledger, message);
  // No key appears or disappears, yet `JSON.stringify` now emits a `null`.
  message.content.length = 2;
  expect(JSON.stringify(message.content)).toBe('[{"type":"text","text":"a"},null]');
  expectFresh(ledger, message);
});

test("an array that shrinks by length is a different message", () => {
  const ledger = ledgerFor();
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
  };
  expectFresh(ledger, message);
  message.content.length = 1;
  expectFresh(ledger, message);
});

test("an own toJSON whose answer lives outside the message is never memoized", () => {
  const ledger = ledgerFor();
  let answer = 1;
  const message = {
    role: "user",
    toJSON() {
      return { role: "user", answer };
    },
  };
  expectFresh(ledger, message);
  answer = 2;
  expectFresh(ledger, message);
});

test("a non-enumerable property still feeds the character count", () => {
  const ledger = ledgerFor();
  const content = [{ type: "text", text: "a" }];
  const message = { role: "user" };
  Object.defineProperty(message, "content", { value: content, enumerable: false });
  expectFresh(ledger, message);
  // `Object.keys` cannot see `content`, so a shape made of keys alone would
  // keep the old count; `sliceChars` reads the property directly.
  content[0].text = "aaaaa";
  expectFresh(ledger, message);
});

test("a non-enumerable property added after the first request is seen", () => {
  const ledger = ledgerFor();
  const message = { role: "user", content: "a" };
  expectFresh(ledger, message);
  Object.defineProperty(message, "extra", { value: 1, enumerable: false });
  expectFresh(ledger, message);
});

test("a cyclic message throws the serialization error, not a stack overflow", () => {
  const ledger = ledgerFor();
  const message = { role: "user", content: "a" };
  message.self = message;
  expect(() => record(ledger, [message])).toThrow(TypeError);
});

test("a deeply nested message still gets the digest a fresh hash gives", () => {
  const ledger = ledgerFor();
  let node = { text: "leaf" };
  for (let depth = 0; depth < 60; depth += 1) node = { child: node };
  const message = { role: "user", content: node };
  expectFresh(ledger, message);
  node.child.child.text = "changed";
  expectFresh(ledger, message);
});

test("every edit of a randomized transcript answers the fresh hash", () => {
  const ledger = ledgerFor();
  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = (list) => list[Math.floor(next() * list.length)];

  const messages = [
    { role: "user", content: "opening" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "answer" },
        { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
      ],
    },
    { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "out" }] },
  ];

  for (let round = 0; round < 60; round += 1) {
    const target = pick(messages);
    const kind = Math.floor(next() * 6);
    if (kind === 0) target.content = `${target.content ?? ""}${round}`;
    else if (kind === 1) target.timestamp = round;
    else if (kind === 2 && Array.isArray(target.content)) {
      target.content.push({ type: "text", text: `p${round}` });
    } else if (kind === 3 && Array.isArray(target.content)) {
      target.content.length = Math.max(0, target.content.length - 1);
    } else if (kind === 4) target.stack = { round };
    else delete target.note;
    const sent = record(ledger, messages);
    expect(sent.messageHashes).toEqual(messages.map((message) => fresh(message).hash));
    expect(sent.chars).toBe(sliceChars(messages));
  }
});
