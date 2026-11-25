import { describe, expect, test } from "bun:test";

import { foldStateChain, planLedgerEntry, createBracketLedger, registerFork } from "../src/scope/index.mjs";
import { registerLedger } from "../src/scope/ledger-cache.mjs";

// A record carries the conversation, so a change to its status must not write
// the transcript again. A changed record therefore travels as a field patch —
// in a field of its own, `patches`, beside `set`, which only ever holds whole
// records. Two fields, two meanings: no marker to trust and no value to inspect,
// so a record that happens to contain a field named `$ops` is data.
//
// And a patch with no record to apply to fails as the whole chain: applying it
// to `{}` would keep the changed fields and silently drop the rest, which reads
// as a healthy fork with no history.

function freshState() {
  const state = { brackets: createBracketLedger() };
  registerLedger(state.brackets);
  const ok = registerFork(state.brackets, {
    forkId: "a",
    ownerId: "root",
    fsm: "one state",
    depth: 0,
    budget: { read: 1 },
    profession: "You are a tester.",
  });
  expect(ok.ok).toBe(true);
  return state;
}

const entryWith = (fields) => ({ version: 3, kind: "ledger", full: true, ...fields });

describe("a record that holds a field named $ops", () => {
  test("is data in set, not an instruction", () => {
    const record = { forkId: "a", status: "running", task: "keep me", $ops: [] };
    const folded = foldStateChain([entryWith({ set: { a: record }, del: [] })]);

    expect(folded.brackets.forks.a).toEqual(record);
    expect(folded.brackets.forks.a.task).toBe("keep me");
  });

  test("keeps its $ops contents when they carry real operations", () => {
    const record = { forkId: "a", $ops: [{ op: "set", path: ["x"], value: 1 }], task: "kept" };
    const folded = foldStateChain([entryWith({ set: { a: record }, del: [] })]);

    expect(folded.brackets.forks.a.task).toBe("kept");
    expect(folded.brackets.forks.a.$ops).toHaveLength(1);
  });
});

describe("an entry carrying both encodings", () => {
  test("applies the patch and installs the whole record beside it", () => {
    const base = entryWith({ set: { a: { forkId: "a", status: "running", task: "before" } }, del: [] });
    const next = entryWith({
      full: false,
      patches: { a: [{ op: "set", path: ["task"], value: "edited" }] },
      set: { b: { forkId: "b", status: "running", task: "new record" } },
      del: [],
    });

    const folded = foldStateChain([base, next]);
    expect(folded.brackets.forks.a.task).toBe("edited");
    expect(folded.brackets.forks.b).toEqual({ forkId: "b", status: "running", task: "new record" });
  });
});

describe("a patch with no record to apply to", () => {
  test("fails the chain instead of inventing a record", () => {
    const base = entryWith({ set: {}, del: [] });
    const orphan = entryWith({
      full: false,
      patches: { a: [{ op: "set", path: ["task"], value: "edited" }] },
      del: [],
    });

    // The chain fails as a value, not as an exception: a reader inspecting a
    // subset must report the damage instead of handing the host a throw.
    expect(foldStateChain([base, orphan])).toBe(null);
  });

  test("leaves the ledger it was folding untouched", () => {
    const state = freshState();
    state.brackets.forks.a.task = "original";
    const base = planLedgerEntry(state, null);

    // A later entry that patches a fork nothing established.
    const orphan = { ...base.entry, full: false, set: undefined, patches: { ghost: [{ op: "set", path: ["x"], value: 1 }] } };
    const before = JSON.stringify(base.brackets);

    expect(foldStateChain([orphan], base.brackets)).toBe(null);
    // Nothing was half-applied: the caller still holds exactly what it had.
    expect(JSON.stringify(base.brackets)).toBe(before);
    expect(base.brackets.forks.a.task).toBe("original");
  });
});

describe("what the writer emits", () => {
  test("a changed record is a patch, and the history it did not touch is not written", () => {
    const state = freshState();
    state.brackets.forks.a.messages = Array.from({ length: 200 }, (_, i) => ({
      role: "user",
      text: `m${i} ${"x".repeat(200)}`,
    }));
    const base = planLedgerEntry(state, null);

    state.brackets.forks.a.task = "edited";
    const next = planLedgerEntry(state, base.brackets);

    expect(Array.isArray(next.entry.patches.a)).toBe(true);
    expect(next.entry.set?.a).toBeUndefined();
    expect(JSON.stringify(next.entry.patches.a).length).toBeLessThan(
      JSON.stringify(base.brackets.forks.a).length / 20,
    );

    const restored = foldStateChain([base.entry, next.entry]).brackets.forks.a;
    expect(restored.task).toBe("edited");
    expect(restored.messages).toHaveLength(200);
    expect(restored.messages[199].text).toBe(`m199 ${"x".repeat(200)}`);
  });

  test("a baseline writes whole records and carries no patches", () => {
    const state = freshState();
    const base = planLedgerEntry(state, null);

    expect(base.entry.patches).toBeUndefined();
    expect(base.entry.set.a.forkId).toBe("a");
    expect(foldStateChain([base.entry]).brackets.forks.a.forkId).toBe("a");
  });

  test("a new record travels whole while its neighbour travels as a patch", () => {
    const state = freshState();
    state.brackets.forks.a.task = "first";
    const base = planLedgerEntry(state, null);

    registerFork(state.brackets, { forkId: "b", ownerId: "root", fsm: "one state", depth: 0, budget: { read: 1 }, profession: "You are a tester." });
    state.brackets.forks.a.task = "second";
    const next = planLedgerEntry(state, base.brackets);

    expect(next.entry.set.b.forkId).toBe("b");
    expect(Array.isArray(next.entry.patches.a)).toBe(true);
    const folded = foldStateChain([base.entry, next.entry]).brackets;
    expect(folded.forks.a.task).toBe("second");
    expect(folded.forks.b.forkId).toBe("b");
  });
});
