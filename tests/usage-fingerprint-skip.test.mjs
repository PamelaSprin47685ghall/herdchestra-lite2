import { expect, test } from "bun:test";
import { createUsageLedger } from "../src/scope/usage-ledger.mjs";
import { createState } from "../src/scope/state.mjs";

// The message fingerprints are computed for every request. Skipping them was
// tried and reverted: a list that was skipped still becomes the next sample's
// `prior`, so the gap outlives the condition that produced it. These cases pin
// that nothing — an unsent sample, a new model, a bumped revision — leaves the
// field as null, and that an in-place edit still changes the fingerprint.

function ledgerFor(state) {
  return createUsageLedger({
    state,
    contextMessages: () => [],
    persist() {},
    noteError() {},
    modelKeyOf: () => "model",
    actualModelOf: () => null,
  });
}

const message = { role: "user", content: [{ type: "text", text: "hello" }] };
const header = { key: "h1" };

const unsentSample = (ledger) => ({
  key: "model",
  chars: 1,
  totalInput: 0,
  sent: false,
  headerKey: "h1",
  revision: ledger.contextRevision,
  epoch: 0,
  messageHashes: ["stale"],
});

test("a request keeps its fingerprints on the first call and without header evidence", () => {
  const ledger = ledgerFor(createState());
  ledger.noteSentContext({ key: "model", messages: [message], frontier: 1 });
  expect(Array.isArray(ledger.sentContext.messageHashes)).toBe(true);
  expect(ledger.sentContext.messageHashes[0]).toMatch(/^[0-9a-f]{64}$/);
});

test("a switch of model does not drop the fingerprints", () => {
  const ledger = ledgerFor(createState());
  ledger.noteSentContext({ key: "model", messages: [message], frontier: 1, header });
  ledger.noteSentContext({ key: "other", messages: [message], frontier: 1, header });
  expect(Array.isArray(ledger.sentContext.messageHashes)).toBe(true);
});

test("a revision change does not drop the fingerprints", () => {
  const ledger = ledgerFor(createState());
  ledger.noteSentContext({ key: "model", messages: [message], frontier: 1, header });
  ledger.contextRevision += 1;
  ledger.noteSentContext({ key: "model", messages: [message], frontier: 1, header });
  expect(Array.isArray(ledger.sentContext.messageHashes)).toBe(true);
});

test("an unsent prior sample does not suppress them", () => {
  // A skipped list would still become the next sample's `prior`, so the cost
  // lands on a later request instead of going away. Every request computes its
  // own fingerprints, whatever the previous sample looked like.
  const ledger = ledgerFor(createState());
  ledger.lastSample = unsentSample(ledger);
  ledger.noteSentContext({ key: "model", messages: [message], frontier: 1, header });
  expect(Array.isArray(ledger.sentContext.messageHashes)).toBe(true);
  expect(ledger.sentContext.messageHashes[0]).toMatch(/^[0-9a-f]{64}$/);
  expect(ledger.sentContext.chars).toBeGreaterThan(0);
});

test("the fingerprints follow an in-place edit of a message", () => {
  // The reason the fingerprints cannot be cached by object identity: the same
  // message object can be rewritten between requests.
  const ledger = ledgerFor(createState());
  const edited = { role: "user", content: [{ type: "text", text: "before" }] };
  ledger.noteSentContext({ key: "model", messages: [edited], frontier: 1, header });
  const first = ledger.sentContext.messageHashes[0];
  edited.content[0].text = "after";
  ledger.noteSentContext({ key: "model", messages: [edited], frontier: 1, header });
  expect(ledger.sentContext.messageHashes[0]).not.toBe(first);
});
