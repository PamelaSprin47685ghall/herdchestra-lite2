// A `toJSON` installed on `Object.prototype` or `Array.prototype` rewrites the
// text `JSON.stringify` emits for every plain message at once, while the own
// shape of each message stays byte-identical. A memo that only compared keys
// would hand back a digest for text that is no longer produced — and the patch
// can arrive *after* the memo was built, so the check cannot live only in the
// builder.
//
// These tests pin both halves: a patched prototype invalidates the memo, and the
// check itself runs no user code (a `get toJSON()` is read exactly as often as
// the serialization reads it, no more).

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

/** Install `descriptor` as an own `toJSON` on `proto`, then always remove it. */
function withPatchedPrototype(proto, descriptor, body) {
  Object.defineProperty(proto, "toJSON", { configurable: true, ...descriptor });
  try {
    return body();
  } finally {
    delete proto.toJSON;
  }
}

test("a toJSON added to Object.prototype cannot leave a cached digest standing", () => {
  const ledger = ledgerFor();
  const message = { role: "user", content: "plain" };
  const before = record(ledger, [message]).messageHashes[0];
  expect(before).toBe(freshHash(message));

  withPatchedPrototype(Object.prototype, { enumerable: false, value: () => "rewritten" }, () => {
    // The message object is untouched; only what serialization asks of it changed.
    expect(JSON.stringify(message)).toBe('"rewritten"');
    const sent = record(ledger, [message]);
    expect(sent.messageHashes[0]).toBe(freshHash(message));
    expect(sent.messageHashes[0]).not.toBe(before);
  });
});

test("a toJSON added to Array.prototype cannot leave a cached digest standing", () => {
  const ledger = ledgerFor();
  const message = { role: "assistant", content: [{ type: "text", text: "a" }] };
  const before = record(ledger, [message]).messageHashes[0];
  expect(before).toBe(freshHash(message));

  withPatchedPrototype(Array.prototype, { enumerable: false, value: () => "array-rewritten" }, () => {
    expect(JSON.stringify(message)).toBe(
      '{"role":"assistant","content":"array-rewritten"}',
    );
    const sent = record(ledger, [message]);
    expect(sent.messageHashes[0]).toBe(freshHash(message));
    expect(sent.messageHashes[0]).not.toBe(before);
  });
});

test("the prototype check runs no user code", () => {
  const ledger = ledgerFor();
  const message = { role: "user", content: "plain" };
  record(ledger, [message]);

  let reads = 0;
  withPatchedPrototype(
    Object.prototype,
    {
      enumerable: false,
      get() {
        reads += 1;
        return () => "rewritten";
      },
    },
    () => {
      // Nothing has been asked of the message yet.
      expect(reads).toBe(0);
      // One serialization per request reads the getter once. The memo's own
      // checks must add nothing: a second read would be a side effect on
      // message state that the caller never asked for.
      record(ledger, [message]);
      expect(reads).toBe(1);
      record(ledger, [message]);
      expect(reads).toBe(2);
      record(ledger, [message]);
      expect(reads).toBe(3);
    },
  );
});

test("a clean prototype after the patch restores memoization, not staleness", () => {
  const ledger = ledgerFor();
  const message = { role: "user", content: "plain" };
  record(ledger, [message]);

  withPatchedPrototype(Object.prototype, { enumerable: false, value: () => "rewritten" }, () => {
    record(ledger, [message]);
  });

  // No `toJSON` anywhere now, so the digest follows the message again, and the
  // memo built before the patch is still a true statement about it.
  const sent = record(ledger, [message]);
  expect(sent.messageHashes[0]).toBe(freshHash(message));
  expect(sent.chars).toBe(sliceChars([message]));
});

test("a non-callable toJSON on the prototype changes nothing to invalidate", () => {
  const ledger = ledgerFor();
  const message = { role: "user", content: "plain" };
  const before = record(ledger, [message]).messageHashes[0];

  withPatchedPrototype(Object.prototype, { enumerable: false, value: "not a function" }, () => {
    // `JSON.stringify` only calls a callable `toJSON`; a data string is never
    // called, so the text — and the digest — stay as they were.
    expect(JSON.stringify(message)).toBe('{"role":"user","content":"plain"}');
    expect(record(ledger, [message]).messageHashes[0]).toBe(before);
  });
});

test("a null-prototype message is fingerprinted instead of crashing the walk", () => {
  const ledger = ledgerFor();
  const nested = Object.create(null);
  nested.type = "text";
  nested.text = "nested";
  const message = Object.create(null);
  message.role = "user";
  message.content = [nested];
  // `Object.getPrototypeOf` is null here, so a prototype check that asks a
  // descriptor of that nothing throws; the message is still perfectly
  // serializable, and its digest must follow its content.
  expect(record(ledger, [message]).messageHashes[0]).toBe(freshHash(message));
  nested.text = "edited";
  expect(record(ledger, [message]).messageHashes[0]).toBe(freshHash(message));
});

test("a null-prototype message that gains a toJSON is still re-serialized", () => {
  const ledger = ledgerFor();
  const message = Object.create(null);
  message.role = "user";
  message.content = "plain";
  const before = record(ledger, [message]).messageHashes[0];
  Object.defineProperty(message, "toJSON", {
    enumerable: false,
    configurable: true,
    value: () => "rewritten",
  });
  const after = record(ledger, [message]).messageHashes[0];
  expect(after).toBe(freshHash(message));
  expect(after).not.toBe(before);
});

test("an array node inherits a toJSON patched onto Object.prototype", () => {
  const ledger = ledgerFor();
  const message = { role: "assistant", content: [{ type: "text", text: "a" }] };
  const before = record(ledger, [message]).messageHashes[0];
  expect(before).toBe(freshHash(message));

  withPatchedPrototype(Object.prototype, { enumerable: false, value: () => "rewritten" }, () => {
    // The array itself carries no `toJSON`; it reaches this one through
    // `Array.prototype` → `Object.prototype`, exactly as `JSON.stringify` does.
    expect(JSON.stringify(message.content)).toBe('"rewritten"');
    const sent = record(ledger, [message]);
    expect(sent.messageHashes[0]).toBe(freshHash(message));
    expect(sent.messageHashes[0]).not.toBe(before);
  });
});
