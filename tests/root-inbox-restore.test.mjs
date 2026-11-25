// A root message has no fork record to live in, so the snapshot's `rootInbox`
// is its only copy. These tests pin that a reload reads it back: the mailbox
// comes back as a closed mailbox with the same entries in the same order, and
// the restored ledger can still take and append to it.

import { expect, test } from "bun:test";

import {
  appendRootEnvelope,
  createBracketLedger,
  enqueueRootMessage,
  restoreLedgerChecked,
  serializeLedgerShared,

} from "../src/scope/forkjoin.mjs";
import { isAppendOnlyInbox } from "../src/scope/append-only-inbox.mjs";

function ledgerWithRootMessages(messages) {
  const ledger = createBracketLedger();
  for (const message of messages) enqueueRootMessage(ledger, message);
  return ledger;
}

test("a root message survives a snapshot and restore", () => {
  const ledger = ledgerWithRootMessages([
    { from: "fork-a", message: "first" },
    { from: "fork-b", message: "second" },
  ]);
  const restored = restoreLedgerChecked(serializeLedgerShared(ledger));
  expect(restored.ok).toBe(true);
  expect(restored.ledger.rootInbox.length).toBe(2);
  expect(restored.ledger.rootInbox.map((entry) => entry.message)).toEqual(["first", "second"]);
  expect(restored.ledger.rootInbox[0].from).toBe("fork-a");
});

test("the restored mailbox is a closed mailbox, not a plain array", () => {
  const ledger = ledgerWithRootMessages([{ from: "fork-a", message: "hello" }]);
  const restored = restoreLedgerChecked(serializeLedgerShared(ledger)).ledger;
  expect(isAppendOnlyInbox(restored.rootInbox)).toBe(true);
  // A closed mailbox refuses a write that is not an append, so the restored
  // container cannot quietly stop matching the snapshot it came from.
  expect(() => {
    restored.rootInbox[0] = { message: "replaced" };
  }).toThrow(TypeError);
});

test("the root can still append, and the appended message survives a second reload", () => {
  const ledger = ledgerWithRootMessages([{ from: "fork-a", message: "pending" }]);
  const restored = restoreLedgerChecked(serializeLedgerShared(ledger)).ledger;
  appendRootEnvelope(restored, { from: "fork-b", message: "after" });
  expect(restored.rootInbox.map((entry) => entry.message)).toEqual(["pending", "after"]);
  const again = restoreLedgerChecked(serializeLedgerShared(restored));
  expect(again.ok).toBe(true);
  expect(again.ledger.rootInbox.map((entry) => entry.message)).toEqual(["pending", "after"]);
});

test("a snapshot without a mailbox restores an empty one", () => {
  const ledger = createBracketLedger();
  const value = serializeLedgerShared(ledger);
  delete value.rootInbox;
  const restored = restoreLedgerChecked(value);
  expect(restored.ok).toBe(true);
  expect(restored.ledger.rootInbox.length).toBe(0);
  expect(isAppendOnlyInbox(restored.ledger.rootInbox)).toBe(true);
});
