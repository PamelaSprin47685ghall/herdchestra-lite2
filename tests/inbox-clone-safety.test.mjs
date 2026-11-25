// Two places where the closed mailbox meets a general-purpose copy, and both
// used to lose data silently or fail with the wrong error.
//
// 1. `push` detaches the entry before storing it. Detaching a cycle recursed
//    until the stack overflowed; keeping a `bigint` left an entry the snapshot
//    could not stringify at all.
// 2. `cloneValue` falls back when `structuredClone` refuses a mailbox. It used
//    to send the whole graph through JSON, so a `Date` became a string and a
//    `Map` became `{}` — values `structuredClone` handles perfectly well.

import { describe, expect, test } from "bun:test";

import {
  adoptInbox,
  createAppendOnlyInbox,
  isAppendOnlyInbox,
} from "../src/scope/append-only-inbox.mjs";
import { applyDelta } from "../src/scope/persistence.mjs";
import { createBracketLedger, enqueueRootMessage } from "../src/scope/forkjoin.mjs";

describe("detaching an entry for storage", () => {
  test("a cycle is refused at the write instead of overflowing the stack", () => {
    const inbox = createAppendOnlyInbox();
    const entry = { from: "/", message: "hello" };
    entry.self = entry;

    expect(() => inbox.push(entry)).toThrow(TypeError);
    expect(inbox).toHaveLength(0);
  });

  test("a self-referencing array inside an entry is refused too", () => {
    const inbox = createAppendOnlyInbox();
    const list = [];
    list.push(list);

    expect(() => inbox.push({ from: "/", message: "hello", list })).toThrow(TypeError);
    expect(inbox).toHaveLength(0);
  });

  test("a value JSON cannot hold is dropped; the rest of the entry survives", () => {
    const inbox = createAppendOnlyInbox();
    inbox.push({
      from: "/",
      message: "hello",
      fn: () => 1,
      big: 1n,
      sym: Symbol("s"),
    });

    expect(inbox[0]).toEqual({ from: "/", message: "hello" });
    // The stored entry must be writable to JSON, or every snapshot of the
    // ledger containing it would throw.
    expect(() => JSON.stringify(inbox)).not.toThrow();
  });

  test("the same object twice is a copy, not a cycle", () => {
    const inbox = createAppendOnlyInbox();
    const shared = { text: "same" };
    inbox.push({ from: "/", message: "hello", left: shared, right: shared });

    expect(inbox[0].left).toEqual({ text: "same" });
    expect(inbox[0].right).toEqual({ text: "same" });
  });

  test("the caller's own object is not frozen", () => {
    const inbox = createAppendOnlyInbox();
    const entry = { from: "/", message: "hello" };

    inbox.push(entry);
    // The mailbox keeps a detached copy; freezing the caller's object would make
    // unrelated code start throwing.
    expect(Object.isFrozen(entry)).toBe(false);
    entry.message = "changed";
    expect(inbox[0].message).toBe("hello");
  });
});

describe("cloning a graph that contains a mailbox", () => {
  test("a Date and a Map beside the mailbox keep their types", () => {
    const ledger = createBracketLedger();
    enqueueRootMessage(ledger, { message: "hello" });
    ledger.startedAt = new Date("2026-01-02T03:04:05.000Z");
    ledger.byId = new Map([["a", 1]]);
    ledger.tags = new Set(["x"]);

    const copy = applyDelta(ledger, [{ op: "set", path: ["note"], value: "kept" }]);

    expect(copy.note).toBe("kept");
    expect(copy.startedAt).toBeInstanceOf(Date);
    expect(copy.startedAt.toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect(copy.byId).toBeInstanceOf(Map);
    expect(copy.byId.get("a")).toBe(1);
    expect(copy.tags).toBeInstanceOf(Set);
    expect(copy.tags.has("x")).toBe(true);
  });

  test("the mailbox arrives as a plain array, disconnected from the original", () => {
    const ledger = createBracketLedger();
    enqueueRootMessage(ledger, { message: "hello" });

    const copy = applyDelta(ledger, []);

    expect(isAppendOnlyInbox(copy.rootInbox)).toBe(false);
    expect(copy.rootInbox.map((entry) => entry.message)).toEqual(["hello"]);
    expect(copy.rootInbox).not.toBe(ledger.rootInbox);
  });

  test("a ledger that refers to itself still clones", () => {
    const ledger = createBracketLedger();
    enqueueRootMessage(ledger, { message: "hello" });
    ledger.self = ledger;

    const copy = applyDelta(ledger, [{ op: "set", path: ["note"], value: "kept" }]);

    expect(copy.note).toBe("kept");
    expect(copy.self).toBe(copy);
    expect(copy.rootInbox.map((entry) => entry.message)).toEqual(["hello"]);
  });

  test("an adopted mailbox is replaced by a plain array too", () => {
    const ledger = { rootInbox: adoptInbox([{ from: "/", message: "one" }]), note: "a" };

    const copy = applyDelta(ledger, []);

    expect(copy.rootInbox).toEqual([{ from: "/", message: "one" }]);
    expect(isAppendOnlyInbox(copy.rootInbox)).toBe(false);
  });

  test("a value that cannot be cloned at all still fails", () => {
    // structuredClone refuses a function, and no mailbox is involved, so the
    // fallback must not turn this into a lossy copy.
    const ops = [{ op: "set", path: ["value"], value: { run: () => 1 } }];
    expect(() => applyDelta({ value: null }, ops)).toThrow();
  });
});
