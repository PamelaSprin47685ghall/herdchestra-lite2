import { describe, test, expect } from "bun:test";
import { createBracketLedger } from "../src/scope/forkjoin.mjs";
import { planLedgerEntry } from "../src/scope/persistence.mjs";

// The mailbox comparison has a scalar fast path and a deep fallback. Both must
// answer what the deep comparison answered, because the answer decides whether a
// new root message appends its suffix or rewrites the whole mailbox — on a long
// session that is one message versus gigabytes, every second.

const plan = (ledger, previous) => planLedgerEntry({ brackets: ledger }, previous);

describe("a mailbox entry that carries nested data", () => {
  test("appending keeps every earlier entry's verdict and writes only the suffix", () => {
    const ledger = createBracketLedger();
    ledger.rootInbox.push({ from: "/a", envelope: "one", message: { text: "hello" } });
    const baseline = plan(ledger, null);

    ledger.rootInbox.push({ from: "/b", envelope: "two", message: { text: "again" } });
    const next = plan(ledger, baseline.brackets);

    expect(next.entry.rootInboxAppend).toEqual([
      { from: "/b", envelope: "two", message: { text: "again" } },
    ]);
    expect(next.entry.rootInbox).toBeUndefined();
  });

  test("an in-place nested edit raises at the write", () => {
    const ledger = createBracketLedger();
    ledger.rootInbox.push({ from: "/a", envelope: "one", message: { text: "hello" } });
    plan(ledger, null);

    expect(() => {
      ledger.rootInbox[0].message.text = "corrected";
    }).toThrow(TypeError);
    expect(ledger.rootInbox[0].message.text).toBe("hello");
  });

  test("a replaced array is still compared by content", () => {
    const ledger = createBracketLedger();
    ledger.rootInbox.push({ from: "/a", envelope: "one" });
    const baseline = plan(ledger, null);

    // A caller may hand in a fresh list; reordering it is a whole rewrite.
    ledger.rootInbox = [ledger.rootInbox[0], { from: "/b", envelope: "two" }];
    ledger.rootInbox.reverse();
    const next = plan(ledger, baseline.brackets);

    expect(next.entry.rootInbox).toEqual([
      { from: "/b", envelope: "two" },
      { from: "/a", envelope: "one" },
    ]);
    expect(next.entry.rootInboxAppend).toBeUndefined();
  });
});

describe("a scalar entry whose value is not JSON data", () => {
  test("drops what the deep copy dropped instead of carrying it into the snapshot", () => {
    const ledger = createBracketLedger();
    const entry = { from: "/a", envelope: "one", message: "text", extra: () => 1 };
    ledger.rootInbox.push(entry);
    const baseline = plan(ledger, null);

    expect(() => JSON.stringify(baseline.brackets)).not.toThrow();
    expect(JSON.parse(JSON.stringify(baseline.brackets.rootInbox))).toEqual([
      { from: "/a", envelope: "one", message: "text" },
    ]);

    ledger.rootInbox.push({ from: "/b", envelope: "two", message: "more" });
    const next = plan(ledger, baseline.brackets);
    expect(next.entry.rootInboxAppend).toHaveLength(1);
  });

  test("a bigint field does not reach JSON.stringify", () => {
    const ledger = createBracketLedger();
    ledger.rootInbox.push({ from: "/a", envelope: "one", message: 1n });
    const baseline = plan(ledger, null);
    expect(() => JSON.stringify(baseline.brackets.rootInbox)).not.toThrow();
    expect(baseline.brackets.rootInbox[0]).toEqual({ from: "/a", envelope: "one" });
  });

  test("two non-finite numbers are the same value, as JSON makes them", () => {
    const ledger = createBracketLedger();
    ledger.rootInbox.push({ from: "/a", envelope: "one", message: Number.NaN });
    const baseline = plan(ledger, null);

    // The stored copy froze NaN as NaN; a second policy for non-finite numbers
    // would rewrite the whole mailbox on an append that changed nothing.
    ledger.rootInbox.push({ from: "/b", envelope: "two" });
    const next = plan(ledger, baseline.brackets);

    expect(next.entry.rootInboxAppend).toHaveLength(1);
  });

  test("an undefined field counts as absent, as it does in JSON", () => {
    const ledger = createBracketLedger();
    ledger.rootInbox.push({ from: "/a", envelope: "one", message: undefined });
    const baseline = plan(ledger, null);

    ledger.rootInbox.push({ from: "/b", envelope: "two" });
    const next = plan(ledger, baseline.brackets);
    expect(next.entry.rootInboxAppend).toHaveLength(1);
  });
});
