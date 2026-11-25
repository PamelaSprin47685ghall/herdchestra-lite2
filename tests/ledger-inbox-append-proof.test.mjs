// Root inbox journal behavior: append suffixes when the previous contents are
// unchanged, and replace the list when an earlier message was edited.
// Until ownership is enforced, comparing existing contents is necessary.

import { describe, expect, test } from "bun:test";

import {
  createState,
  createBracketLedger,
  registerFork,
  planLedgerEntry,
  foldStateChain,
  markLedgerStructDirty,
} from "../src/scope/index.mjs";
// `registerLedger` starts the snapshot cache; it is not re-exported from the
// barrel, and the planner needs the ledger tracked or every write is a rebuild.
import { registerLedger } from "../src/scope/ledger-cache.mjs";

function freshState() {
  const state = createState();
  state.brackets = createBracketLedger();
  registerLedger(state.brackets);
  return state;
}

function register(state, forkId) {
  const registered = registerFork(state.brackets, {
    forkId,
    ownerId: "root",
    fsm: "one state",
    depth: 0,
    budget: { read: 1 },
    profession: "You are a tester.",
  });
  expect(registered.ok).toBe(true);
  return registered.fork;
}

/** What the send path does: push one envelope, then mark the structure. */
function deliver(state, message) {
  state.brackets.rootInbox.push({ from: "/api", message, envelope: message });
  markLedgerStructDirty(state.brackets);
}

function messages(ledger) {
  return (ledger.rootInbox ?? []).map((item) => item.message);
}

describe("an append in the steady state", () => {
  test("writes only the new suffix", () => {
    const state = freshState();
    register(state, "a");
    deliver(state, "first");
    const base = planLedgerEntry(state, null);
    expect(base.entry.full).toBe(true);
    expect(base.entry.rootInbox.map((item) => item.message)).toEqual(["first"]);

    deliver(state, "second");
    deliver(state, "third");
    const next = planLedgerEntry(state, base.brackets);

    expect(next.refused).toBeUndefined();
    // The journal already holds "first"; only the two new envelopes travel.
    expect(next.entry.rootInbox).toBeUndefined();
    expect(next.entry.rootInboxAppend.map((item) => item.message)).toEqual([
      "second",
      "third",
    ]);

    const restored = foldStateChain([base.entry, next.entry]);
    expect(messages(restored.brackets)).toEqual(["first", "second", "third"]);
  });

  test("the proof holds over many writes without repeating the history", () => {
    const state = freshState();
    register(state, "a");
    deliver(state, "m0");
    let plan = planLedgerEntry(state, null);
    const entries = [plan.entry];
    let previous = plan.brackets;

    for (let index = 1; index < 40; index += 1) {
      deliver(state, `m${index}`);
      plan = planLedgerEntry(state, previous);
      expect(plan.entry).toBeTruthy();
      // One appended envelope per write, however long the mailbox has grown.
      expect(plan.entry.rootInboxAppend).toHaveLength(1);
      expect(plan.entry.rootInbox).toBeUndefined();
      entries.push(plan.entry);
      previous = plan.brackets;
    }

    expect(messages(foldStateChain(entries).brackets)).toEqual(
      Array.from({ length: 40 }, (_, index) => `m${index}`),
    );
  });

  test("repeated identical messages stay, in order", () => {
    const state = freshState();
    register(state, "a");
    deliver(state, "same");
    const base = planLedgerEntry(state, null);
    deliver(state, "same");
    deliver(state, "same");
    const next = planLedgerEntry(state, base.brackets);

    // The suffix is not deduplicated: three deliveries are three deliveries.
    expect(next.entry.rootInboxAppend).toHaveLength(2);
    expect(messages(foldStateChain([base.entry, next.entry]).brackets)).toEqual([
      "same",
      "same",
      "same",
    ]);
  });

  test("a quiet write owes nothing", () => {
    const state = freshState();
    register(state, "a");
    deliver(state, "only");
    const base = planLedgerEntry(state, null);
    const quiet = planLedgerEntry(state, base.brackets);
    expect(quiet.entry).toBeNull();
    expect(quiet.refused).toBeUndefined();
  });
});

describe("changes requiring comparison", () => {
  test("an append after a refused edit stores only the new tail", () => {
    const state = freshState();
    register(state, "a");
    deliver(state, "first");
    const base = planLedgerEntry(state, null);
    // The mailbox refuses a write through a stored entry, so the journal never
    // has to notice one: it cannot happen.
    expect(() => {
      state.brackets.rootInbox[0].message = "corrected";
    }).toThrow(TypeError);
    deliver(state, "second");
    const next = planLedgerEntry(state, base.brackets);
    expect(next.entry.rootInbox).toBeUndefined();
    expect(next.entry.rootInboxAppend.map((item) => item.message)).toEqual(["second"]);
    expect(messages(foldStateChain([base.entry, next.entry]).brackets)).toEqual(["first", "second"]);
  });
  test("a retry after a failure still writes the suffix", () => {
    const state = freshState();
    register(state, "a");
    deliver(state, "first");
    const base = planLedgerEntry(state, null);

    // A failed append advances the live observation without landing anything.
    deliver(state, "second");
    const failed = planLedgerEntry(state, base.brackets);
    expect(failed.entry.rootInboxAppend).toHaveLength(1);

    // The retry runs against the same durable baseline, so the observation no
    // longer matches it and the comparison path answers instead. It must give
    // the same suffix — a retry may not lose the envelope it already computed.
    const retry = planLedgerEntry(state, base.brackets);
    expect(retry.entry).toBeTruthy();
    expect(retry.entry.rootInboxAppend.map((item) => item.message)).toEqual([
      "second",
    ]);
  });

  test("a second journal with an older baseline still gets its own suffix", () => {
    const state = freshState();
    register(state, "a");
    deliver(state, "first");
    const older = planLedgerEntry(state, null);

    deliver(state, "second");
    const newer = planLedgerEntry(state, older.brackets);
    expect(newer.entry.rootInboxAppend).toHaveLength(1);

    // A journal that has stored nothing since the first envelope asks again,
    // from its own older baseline. It owes "second" as well, and must get it.
    const catchUp = planLedgerEntry(state, older.brackets);
    expect(catchUp.entry).toBeTruthy();
    expect(catchUp.entry.rootInboxAppend.map((item) => item.message)).toEqual([
      "second",
    ]);
  });

  test("a rebuilt list is written whole rather than as an append", () => {
    const state = freshState();
    register(state, "a");
    deliver(state, "first");
    const base = planLedgerEntry(state, null);

    // A rebuilt array with equal prefix still represents an append.
    state.brackets.rootInbox = state.brackets.rootInbox.map((item) => ({
      ...item,
    }));
    state.brackets.rootInbox.push({ from: "/", message: "second", envelope: "second" });
    markLedgerStructDirty(state.brackets);

    // A rebuilt array is a foreign array: nothing promises its entries are the
    // stored ones. Its content is compared, and only the part past the stored
    // length travels — either way, replay must reproduce it exactly.
    const next = planLedgerEntry(state, base.brackets);
    expect(next.entry.rootInboxAppend.map((item) => item.message)).toEqual(["second"]);
    expect(messages(foldStateChain([base.entry, next.entry]).brackets)).toEqual([
      "first",
      "second",
    ]);
  });

  test("an emptied list is written whole, not as an empty append", () => {
    const state = freshState();
    register(state, "a");
    deliver(state, "first");
    deliver(state, "second");
    const base = planLedgerEntry(state, null);

    state.brackets.rootInbox = [];
    markLedgerStructDirty(state.brackets);
    const next = planLedgerEntry(state, base.brackets);

    expect(next.entry.rootInbox).toEqual([]);
    expect(next.entry.rootInboxAppend).toBeUndefined();
    expect(messages(foldStateChain([base.entry, next.entry]).brackets)).toEqual([]);
  });

  test("a reordered list is written whole", () => {
    const state = freshState();
    register(state, "a");
    deliver(state, "first");
    deliver(state, "second");
    const base = planLedgerEntry(state, null);

    state.brackets.rootInbox = [state.brackets.rootInbox[1], state.brackets.rootInbox[0]];
    markLedgerStructDirty(state.brackets);
    const next = planLedgerEntry(state, base.brackets);

    expect(next.entry.rootInboxAppend).toBeUndefined();
    expect(messages(foldStateChain([base.entry, next.entry]).brackets)).toEqual([
      "second",
      "first",
    ]);
  });
});
