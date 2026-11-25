// The fingerprint memo proves a message unchanged by walking its own data
// properties. An accessor is user code, so the walk must never treat one as
// inert: a getter can answer differently on every call, and it can change a
// field the walk has already compared. These tests pin the resulting rule —
// a message that carries an accessor, or an own `toJSON`, is re-serialized on
// every request, and its fingerprint always equals a fresh one.

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

function freshHash(message) {
  return createHash("sha256").update(JSON.stringify(message) ?? "null").digest("hex");
}

test("a mutating getter is evaluated once per request and never memoized", () => {
  const ledger = ledgerFor();
  let calls = 0;
  const message = {
    role: "user",
    content: "first",
    get tail() {
      calls += 1;
      // The getter edits a field `JSON.stringify` has already read. A memo that
      // kept the shape it walked would answer with the pre-edit text forever.
      message.content = `edited-${calls}`;
      return calls;
    },
  };
  const first = record(ledger, [message]);
  expect(calls).toBe(1);
  const second = record(ledger, [message]);
  expect(calls).toBe(2);
  // The edit is in the message from the next request on, so the fingerprint
  // must move with it.
  expect(second.messageHashes[0]).not.toBe(first.messageHashes[0]);
  // No fresh-hash comparison here on purpose: computing a reference digest
  // invokes the getter again, which mutates the message, so the reference would
  // describe a later state than the one recorded. The non-mutating cases below
  // carry that comparison.
});

test("an accessor message is re-serialized per request, not memoized", () => {
  const ledger = ledgerFor();
  let reads = 0;
  const message = {
    content: "body",
    get role() {
      reads += 1;
      return "user";
    },
  };
  // Nothing else in the fingerprint path reads `role`: `sliceChars` reads
  // `content`, and the shape builder refuses at the descriptor before touching
  // the value. So one read per request means the builder stayed out of it.
  record(ledger, [message]);
  expect(reads).toBe(1);
  record(ledger, [message]);
  expect(reads).toBe(2);
  record(ledger, [message]);
  expect(reads).toBe(3);
  expect(record(ledger, [message]).messageHashes[0]).toBe(freshHash(message));
});

test("an own toJSON accessor is not invoked merely to be refused", () => {
  const ledger = ledgerFor();
  let reads = 0;
  const message = {
    role: "user",
    content: "body",
    get toJSON() {
      reads += 1;
      return () => ({ role: "user", content: "body" });
    },
  };
  // `JSON.stringify` reads `toJSON` once and calls it; the shape builder must
  // not add a second read of its own.
  record(ledger, [message]);
  expect(reads).toBe(1);
  record(ledger, [message]);
  expect(reads).toBe(2);
});

test("an own data toJSON function keeps its answer authoritative", () => {
  const ledger = ledgerFor();
  let answer = "one";
  const message = {
    role: "user",
    content: "body",
    toJSON() {
      return { role: "user", content: answer };
    },
  };
  const first = record(ledger, [message]).messageHashes[0];
  answer = "two";
  const second = record(ledger, [message]).messageHashes[0];
  expect(second).toBe(freshHash(message));
  expect(second).not.toBe(first);
});

test("a hidden array index still feeds the digest", () => {
  const ledger = ledgerFor();
  const content = [{ type: "text", text: "a" }];
  const message = { role: "user", content };
  record(ledger, [message]);
  // `Object.keys` cannot see this index, but `JSON.stringify` emits it.
  Object.defineProperty(content, 1, { value: { type: "text", text: "b" }, enumerable: false });
  expect(record(ledger, [message]).messageHashes[0]).toBe(freshHash(message));
});

test("a hidden array index that changes is noticed", () => {
  const ledger = ledgerFor();
  const content = [{ type: "text", text: "a" }];
  Object.defineProperty(content, 1, { value: { type: "text", text: "b" }, enumerable: false });
  const message = { role: "user", content };
  record(ledger, [message]);
  content[1].text = "changed";
  expect(record(ledger, [message]).messageHashes[0]).toBe(freshHash(message));
});

test("a data message that gains an accessor stops being trusted", () => {
  const ledger = ledgerFor();
  const message = { role: "user", content: "plain" };
  record(ledger, [message]);
  let reads = 0;
  Object.defineProperty(message, "content", {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return "plain";
    },
  });
  const sent = record(ledger, [message]);
  expect(sent.messageHashes[0]).toBe(freshHash(message));
  // The walk reads the getter to compare it; whatever it reads is what the
  // digest was computed from, so the answer stays exact.
  expect(reads).toBeGreaterThan(0);
});

test("an equal-but-distinct plain message keeps a fresh-equivalent digest", () => {
  const ledger = ledgerFor();
  const first = { role: "user", content: [{ type: "text", text: "same" }] };
  record(ledger, [first]);
  const second = { role: "user", content: [{ type: "text", text: "same" }] };
  const sent = record(ledger, [second]);
  expect(sent.messageHashes[0]).toBe(freshHash(second));
  expect(sent.chars).toBe(sliceChars([second]));
});

test("a non-enumerable toJSON added after caching cannot leave a stale digest", () => {
  const ledger = ledgerFor();
  const message = { role: "user", content: "plain" };
  const first = record(ledger, [message]).messageHashes[0];
  expect(first).toBe(freshHash(message));
  // Hidden from `Object.keys`, so the key list alone still matches the shape —
  // while `JSON.stringify` now returns this function's answer instead.
  Object.defineProperty(message, "toJSON", {
    enumerable: false,
    configurable: true,
    value: () => ({ role: "user", content: "rewritten" }),
  });
  expect(JSON.stringify(message)).toBe('{"role":"user","content":"rewritten"}');
  const second = record(ledger, [message]).messageHashes[0];
  expect(second).toBe(freshHash(message));
  expect(second).not.toBe(first);
});

test("a non-enumerable toJSON replaced after caching cannot leave a stale digest", () => {
  const ledger = ledgerFor();
  const message = { role: "user", content: "plain" };
  Object.defineProperty(message, "toJSON", {
    enumerable: false,
    configurable: true,
    value: () => ({ role: "user", content: "one" }),
  });
  // An own `toJSON` is refused for memoization, so this request re-serializes.
  const first = record(ledger, [message]).messageHashes[0];
  Object.defineProperty(message, "toJSON", {
    enumerable: false,
    configurable: true,
    value: () => ({ role: "user", content: "two" }),
  });
  const second = record(ledger, [message]).messageHashes[0];
  expect(second).toBe(freshHash(message));
  expect(second).not.toBe(first);
});
