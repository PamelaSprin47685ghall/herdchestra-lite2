import { expect, test } from "bun:test";
import { createUsageLedger } from "../src/scope/usage-ledger.mjs";
import { createState } from "../src/scope/state.mjs";

test("prepared context records stable message fingerprints", () => {
  const ledger = createUsageLedger({
    state: createState(),
    contextMessages: () => [],
    persist() {},
    noteError() {},
    modelKeyOf: () => "model",
    actualModelOf: () => null,
  });
  const message = { role: "user", content: [{ type: "text", text: "hello" }] };
  ledger.noteSentContext({ key: "model", messages: [message], frontier: 1 });
  const fingerprint = ledger.sentContext.messageHashes[0];
  expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  ledger.noteSentContext({ key: "model", messages: [structuredClone(message)], frontier: 1 });
  expect(ledger.sentContext.messageHashes[0]).toBe(fingerprint);
  ledger.noteSentContext({ key: "model", messages: [{ ...message, role: "assistant" }], frontier: 1 });
  expect(ledger.sentContext.messageHashes[0]).not.toBe(fingerprint);
});

test("watermark uses only entries after the latest measured assistant", () => {
  const ledger = createUsageLedger({
    state: createState(), contextMessages: () => [], persist() {}, noteError() {},
    modelKeyOf: () => "model", actualModelOf: () => null,
  });
  ledger.lastTotalInput = 100;
  ledger.lastOutputTokens = 4;
  ledger.lastUsageModelKey = "model";
  const measured = { role: "assistant", usage: { input: 100 } };
  const custom = { role: "custom", content: "ignored" };
  expect(ledger.currentContextTokens([measured])).toBe(104);
  expect(ledger.currentContextTokens([
    { role: "user", content: "old" }, measured, custom,
  ])).toBe(104);
  // The last measured assistant, not the first, defines the pending suffix.
  expect(ledger.currentContextTokens([
    measured, { role: "user", content: "old" }, measured,
  ])).toBe(104);
  // A measured message at the tail does not license skipping the rest: the
  // value is the same, but the caller's elements are still all read, in index
  // order, exactly as before. A counting view pins that.
  const visited = [];
  const counted = new Proxy([{ role: "user" }, measured], {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) visited.push(Number(key));
      return Reflect.get(target, key, receiver);
    },
  });
  expect(ledger.currentContextTokens(counted)).toBe(104);
  expect(visited).toContain(0);
  expect(visited).toContain(1);
});

test("fingerprints follow nested in-place changes and branch replacement", () => {
  const ledger = createUsageLedger({
    state: createState(), contextMessages: () => [], persist() {}, noteError() {},
    modelKeyOf: () => "model", actualModelOf: () => null,
  });
  const first = { role: "user", content: [{ type: "text", text: "before" }] };
  const second = { role: "assistant", content: [{ type: "text", text: "answer" }] };
  const record = (messages) => {
    ledger.noteSentContext({ key: "model", messages, frontier: messages.length });
    return ledger.sentContext.messageHashes.slice();
  };
  const original = record([first, second]);
  first.content[0].text = "after";
  const edited = record([first, second]);
  expect(edited[0]).not.toBe(original[0]);
  expect(edited[1]).toBe(original[1]);
  const branch = record([first, { role: "assistant", content: "other" }]);
  expect(branch[0]).toBe(edited[0]);
  expect(branch[1]).not.toBe(edited[1]);
  expect(record([first])).toEqual([edited[0]]);
});
