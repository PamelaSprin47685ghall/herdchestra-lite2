// The root mailbox has one shape and two writers.
//
// `enqueueRootMessage` is the domain entry: it builds `{from, message, envelope}`
// and then calls `changed(ledger)`, which marks the structure *and* notifies
// every subscriber. The send path calls the silent `appendRootEnvelope` domain
// operation and then the root steer port.
//
// The difference is the notification, and it is load-bearing: `fork-registry`
// subscribes `notifyWaiters` to the ledger, so an extra `changed(ledger)` on
// this path would wake waiters that the send path has not woken. Replacing the
// hand-written push with `enqueueRootMessage` is therefore not behaviour
// preserving, and a quiet domain entry is the only correct consolidation.
//
// These cases pin the two halves: the entry the send path stores, and the fact
// that it notifies no subscriber.

import { expect, test } from "bun:test";

import { handleSendCall } from "../src/station/send-controls.mjs";
import {
  createBracketLedger,
  enqueueRootMessage,
  subscribeLedger,
} from "../src/scope/forkjoin.mjs";

/** The station shape the send path reads: ledger and identity by port. */
function stationFor(ledger, extra = {}) {
  return {
    state: { scopes: [], autopilot: false, relay: { generation: 0, fullFlow: false } },
    forkLedgerPort: () => ledger,
    forkIdentityPort: () => null,
    ...extra,
  };
}

test("a send to / stores the entry the domain function would build", () => {
  const ledger = createBracketLedger();
  const result = handleSendCall(stationFor(ledger), {
    id: "s-root",
    arguments: { target: "/", message: "  please review  " },
  });

  expect(result.isError).toBeUndefined();
  expect(ledger.rootInbox).toHaveLength(1);
  const entry = ledger.rootInbox[0];
  expect(entry).toEqual({
    from: "/",
    message: "please review",
    envelope: "[Message from /]\nplease review",
  });

  // The same message through the domain entry produces the same shape.
  const domain = createBracketLedger();
  const built = enqueueRootMessage(domain, { from: "/", message: "please review" });
  expect(library(entry)).toEqual(library(built.entry));
});

function library(entry) {
  return { from: entry.from, message: entry.message, envelope: entry.envelope };
}

test("the send path notifies no ledger subscriber", () => {
  const ledger = createBracketLedger();
  let notified = 0;
  subscribeLedger(ledger, () => {
    notified += 1;
  });

  handleSendCall(stationFor(ledger), {
    id: "s-root-2",
    arguments: { target: "/", message: "unread" },
  });

  // Zero, not "at most one": this path's notification is the root steer port,
  // not the ledger subscription. Any consolidation must keep it at zero.
  expect(notified).toBe(0);
  expect(ledger.rootInbox).toHaveLength(1);
});

test("a failed root mailbox push still marks prior initialization", async () => {
  const { registerConsumer, consumerPending, commitConsumer } = await import("../src/scope/ledger-cache.mjs");
  const ledger = createBracketLedger();
  const consumer = {};
  registerConsumer(ledger, consumer);
  commitConsumer(ledger, consumer, consumerPending(ledger, consumer).revision);
  let reads = 0;
  let stored = null;
  Object.defineProperty(ledger, "rootInbox", {
    configurable: true,
    get() {
      reads += 1;
      if (reads > 1) throw new Error("mailbox unavailable");
      return stored;
    },
    set(value) { stored = value; },
  });
  expect(() => handleSendCall(stationFor(ledger), {
    id: "s-root-throw", arguments: { target: "/", message: "hello" },
  })).toThrow("mailbox unavailable");
  // The container that was installed is the closed mailbox, not a bare array:
  // the field's value is what every later append is judged by.
  expect(stored).toHaveLength(0);
  expect(Array.isArray(stored)).toBe(true);
  expect(consumerPending(ledger, consumer).struct).toBe(true);
});

test("the domain entry is the one that notifies", () => {
  const ledger = createBracketLedger();
  let notified = 0;
  subscribeLedger(ledger, () => {
    notified += 1;
  });

  enqueueRootMessage(ledger, { from: "/", message: "hello" });

  expect(notified).toBe(1);
});
