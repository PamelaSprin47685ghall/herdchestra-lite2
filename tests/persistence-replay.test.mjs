// Replay correctness and memory isolation for append-only state entries.
//
// Replay patches one working tree in place. These tests pin the two things
// that makes safe: the result equals a per-delta immutable fold, and neither
// the stored entries nor the caller's inputs can be mutated through it.

import { describe, expect, test } from "bun:test";
import {
  applyCharge,
  createBracketLedger,
  registerFork,
  serializeState,
  serializeStateShared,
  serializeStateCore,
  createState,
} from "../src/scope/index.mjs";
import {
  applyDelta,
  diffState,
  foldStateChain,
  planStateEntry,
} from "../src/scope/persistence.mjs";

test("core serialization does not traverse the ledger", () => {
  const state = createState();
  const expected = serializeStateCore(state);
  state.brackets = new Proxy({}, {
    ownKeys() { throw new Error("ledger was traversed"); },
    get() { throw new Error("ledger was read"); },
  });
  expect(serializeStateCore(state)).toEqual(expected);
});

function checkpointState() {
  return {
    version: 3,
    brackets: {
      version: 1,
      seq: 2,
      closedSeq: 0,
      receiveSeq: 1,
      forks: {
        alpha: {
          forkId: "alpha",
          ownerId: "root",
          status: "running",
          targets: ["t1", "t2"],
          budget: { read: 3 },
        },
      },
      order: ["alpha"],
      queues: {},
      levels: {},
      totals: { panhandles: 0 },
    },
    relay: null,
  };
}

function nextStates() {
  const s0 = checkpointState();

  const s1 = structuredClone(s0);
  s1.brackets.seq = 3;
  s1.brackets.forks.alpha.status = "joined";
  s1.brackets.forks.alpha.targets.push("t3");

  const s2 = structuredClone(s1);
  s2.brackets.forks.beta = {
    forkId: "beta",
    ownerId: "alpha",
    status: "running",
    targets: [],
  };
  s2.brackets.order.push("beta");
  s2.brackets.queues = { alpha: ["beta"] };
  delete s2.brackets.forks.alpha.budget.read;
  s2.brackets.totals.panhandles = 2;

  const s3 = structuredClone(s2);
  s3.brackets.levels = { "alpha/beta": ["beta"] };
  s3.relay = { action: "join", scopeId: "alpha" };

  return [s0, s1, s2, s3];
}

function buildChain() {
  const [s0, s1, s2, s3] = nextStates();
  const entries = [
    planStateEntry(null, s0),
    planStateEntry(s0, s1, 0),
    planStateEntry(s1, s2, 1),
    planStateEntry(s2, s3, 2),
  ];
  return { states: [s0, s1, s2, s3], entries };
}

function immutableFold(entries, start) {
  let base = structuredClone(start);
  for (const entry of entries.slice(1)) {
    base = applyDelta(base, entry.ops);
  }
  return base;
}

describe("foldStateChain", () => {
  test("replays checkpoint plus deltas to the same state as an immutable fold", () => {
    const { states, entries } = buildChain();
    expect(entries[0].kind).toBe("checkpoint");
    for (const entry of entries.slice(1)) expect(entry.kind).toBe("delta");

    const folded = foldStateChain(entries);
    expect(folded).toEqual(states[3]);
    expect(folded).toEqual(immutableFold(entries, states[0]));
    // The in-place fold must agree on every intermediate step too.
    for (let end = 1; end < entries.length; end += 1) {
      expect(foldStateChain(entries.slice(0, end + 1))).toEqual(states[end]);
    }
  });

  test("never mutates the stored chain", () => {
    const { states, entries } = buildChain();
    const before = structuredClone(entries);

    const folded = foldStateChain(entries);
    expect(entries).toEqual(before);

    // Writing through the result must not reach the stored entries.
    folded.brackets.seq = 99;
    folded.brackets.forks.alpha.status = "tampered";
    folded.brackets.order.push("ghost");
    expect(entries).toEqual(before);
    expect(states[0].brackets.seq).toBe(2);
  });

  test("returns a copy, so a lone checkpoint is never aliased", () => {
    const state = checkpointState();
    const entries = [planStateEntry(null, state)];
    const folded = foldStateChain(entries);
    expect(folded).toEqual(state);
    expect(folded).not.toBe(state);
    expect(folded.brackets).not.toBe(state.brackets);
    folded.brackets.forks.alpha.status = "tampered";
    expect(state.brackets.forks.alpha.status).toBe("running");
  });

  test("a chain that starts with a delta has no anchor", () => {
    const [s0, s1] = nextStates();
    expect(foldStateChain([planStateEntry(s0, s1, 0)])).toBeNull();
  });

  test("an empty chain folds to null", () => {
    expect(foldStateChain([])).toBeNull();
  });
});

describe("applyDelta", () => {
  test("does not mutate its base", () => {
    const base = { pins: ["p1"], brackets: { seq: 1, order: ["a"] } };
    const before = structuredClone(base);
    const out = applyDelta(base, diffState(base, {
      pins: ["p1", "p2"],
      brackets: { seq: 2, order: [] },
    }));
    expect(out).toEqual({ pins: ["p1", "p2"], brackets: { seq: 2, order: [] } });
    expect(base).toEqual(before);
  });

  test("does not alias operation values into the result", () => {
    const ops = [
      { op: "set", path: ["nested"], value: { depth: { x: 1 } } },
      { op: "set", path: ["list", 1], value: { label: "two" } },
      { op: "trunc", path: ["list"], length: 2 },
      { op: "del", path: ["gone"] },
    ];
    const base = { list: [1, "two", 3], gone: true };
    const out = applyDelta(base, ops);

    expect(out).toEqual({ nested: { depth: { x: 1 } }, list: [1, { label: "two" }] });
    out.nested.depth.x = 42;
    out.list[1].label = "tampered";
    expect(ops[0].value).toEqual({ depth: { x: 1 } });
    expect(ops[1].value).toEqual({ label: "two" });
  });

  test("applies the same ops twice to the same base independently", () => {
    const ops = [{ op: "set", path: ["deep"], value: { n: 1 } }];
    const first = applyDelta({}, ops);
    const second = applyDelta({}, ops);
    first.deep.n = 7;
    expect(second.deep.n).toBe(1);
    expect(ops[0].value.n).toBe(1);
  });
});

// The hot path: the station hands `serializeStateShared` to the persistence
// anchor. An untouched ledger must cost no copy and no diff, and a moved
// record must cost one record plus a delta that replays back to the same state.
describe("the shared hot path", () => {
  function wireState(ledger) {
    return {
      startedAt: 1_000,
      seq: 0,
      brackets: ledger,
      epoch: 0,
      autopilot: false,
      relay: null,
      baseModelSpec: null,
      baseModelKey: null,
      modelRecovery: null,
      modelCaches: {},
    };
  }

  function ledgerWithTwoForks() {
    const ledger = createBracketLedger();
    for (const forkId of ["a", "b"]) {
      expect(
        registerFork(ledger, {
          forkId,
          ownerId: "root",
          levelKey: "root|0|0",
          fsm: `work ${forkId}`,
          depth: 0,
          budget: { read: 3 },
          startedAt: 1_000,
        }).ok,
      ).toBe(true);
    }
    return ledger;
  }

  test("an unchanged ledger shares the tree and diffs to nothing", () => {
    const state = wireState(ledgerWithTwoForks());
    const s1 = serializeStateShared(state);
    const s2 = serializeStateShared(state);
    expect(s2.brackets).toBe(s1.brackets);
    expect(s2.brackets.forks.a).toBe(s1.brackets.forks.a);
    expect(diffState(s1, s2)).toEqual([]);
    // The copied serializer stays independent of the cache.
    const full = serializeState(state);
    expect(full).toEqual(s1);
    expect(full.brackets).not.toBe(s1.brackets);
  });

  test("one moved fork costs one record, one delta, and replays back", () => {
    const ledger = ledgerWithTwoForks();
    const state = wireState(ledger);
    const s2 = serializeStateShared(state);
    const frozen = JSON.stringify(s2);

    expect(applyCharge(ledger, "a", { tool: "read", toolCallId: "c1", amount: 1 }).ok).toBe(true);
    const s3 = serializeStateShared(state);
    expect(s3).not.toBe(s2);
    expect(s3.brackets.forks.b).toBe(s2.brackets.forks.b);
    expect(s3.brackets.forks.a).not.toBe(s2.brackets.forks.a);
    expect(JSON.stringify(s2)).toBe(frozen);

    const delta = planStateEntry(s2, s3, 0);
    expect(delta?.kind).toBe("delta");
    expect(delta.ops.length).toBeLessThanOrEqual(32);

    const base = planStateEntry(null, s2);
    const folded = foldStateChain([base, delta]);
    expect(folded).toEqual(s3);
    expect(JSON.stringify(s2)).toBe(frozen);
  });
});
