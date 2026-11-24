// Bounded charge receipts.
//
// Two structures used to grow for the life of a session: the per-branch
// `record.charges` map and the session-wide `state.charges` map. Both exist to
// answer "was this call already paid" and "what does an amend give back", and
// both concern a branch that is still running. These tests pin that the maps
// stay bounded, that a closed branch drops its receipt trail while `spent` and
// `remaining` stay exact, and that a panhandled zero-amount charge survives a
// reload instead of discarding the whole session.

import { describe, expect, test } from "bun:test";

import { chargeBranch, refundBranch } from "../src/scope/accounting.mjs";
import { createState } from "../src/scope/state.mjs";
import {
  abandon,
  applyCharge,
  applyRefund,
  createBracketLedger,
  forkOf,
  markReady,
  registerFork,
  serializeLedgerShared,
  supersedeFork,
  takeReady,
} from "../src/scope/forkjoin.mjs";
import {
  deserializeState,
  serializeState,
} from "../src/scope/persistence.mjs";

function ledgerWith(specs) {
  const ledger = createBracketLedger();
  for (const spec of specs) {
    const registered = registerFork(ledger, {
      forkId: spec.forkId,
      ownerId: "root",
      fsm: "task",
      depth: 0,
      budget: spec.budget ?? { read: 100 },
      startedAt: 0,
    });
    expect(registered.ok).toBe(true);
  }
  return ledger;
}

describe("a panhandled charge survives a reload", () => {
  test("zero amount with panhandled keeps the whole session readable", () => {
    const state = createState();
    const ledger = ledgerWith([{ forkId: "f1", budget: { read: 0 } }]);
    state.brackets = ledger;

    const charged = chargeBranch(state, ledger, {
      ownerId: "f1",
      toolCallId: "c1",
      toolName: "read",
    });
    expect(charged.ok).toBe(true);
    expect(charged.panhandled).toBe(true);
    expect(state.charges.c1).toEqual({
      ownerId: "f1",
      tool: "read",
      amount: 0,
      panhandled: true,
    });

    const snapshot = serializeState(state);
    expect(snapshot.charges.c1).toEqual({
      ownerId: "f1",
      tool: "read",
      amount: 0,
      panhandled: true,
    });

    const back = deserializeState(snapshot);
    // The failure this guards against: one unreadable charge made
    // `deserializeState` fall back to `createState`, losing every branch.
    expect(Object.keys(back.brackets.forks)).toEqual(["f1"]);
    expect(back.charges.c1.panhandled).toBe(true);
    expect(back.startedAt).toBe(state.startedAt);
  });

  test("a zero-amount charge without the flag is still rejected", () => {
    const state = createState();
    const ledger = ledgerWith([{ forkId: "f1" }]);
    state.brackets = ledger;
    const snapshot = serializeState(state);
    snapshot.charges.bad = { ownerId: "f1", tool: "read", amount: 0 };
    const back = deserializeState(snapshot);
    expect(Object.keys(back.brackets.forks)).toEqual([]);
  });
});

describe("a closed branch drops its receipt trail", () => {
  function chargedFork() {
    const ledger = ledgerWith([{ forkId: "f1" }]);
    expect(
      applyCharge(ledger, "f1", { toolCallId: "c1", tool: "read", amount: 2 }).ok,
    ).toBe(true);
    const record = forkOf(ledger, "f1");
    expect(Object.keys(record.charges)).toEqual(["c1"]);
    return { ledger, record };
  }

  test("markReady empties the map and keeps the spend", () => {
    const { ledger, record } = chargedFork();
    const before = serializeLedgerShared(ledger);
    expect(markReady(ledger, "f1", { ok: true, record: "done" }).ok).toBe(true);
    expect(record.charges).toEqual({});
    expect(record.spent).toEqual({ read: 2 });
    expect(record.remaining).toEqual({ read: 98 });

    const after = serializeLedgerShared(ledger);
    expect(after.forks.f1.charges).toEqual({});
    expect(before.forks.f1.charges.c1).toEqual({ tool: "read", amount: 2 });
  });

  test("takeReady empties the map", () => {
    const { ledger, record } = chargedFork();
    expect(markReady(ledger, "f1", { ok: true, record: "done" }).ok).toBe(true);
    expect(applyCharge(ledger, "f1", { toolCallId: "c2", tool: "read", amount: 1 }).ok).toBe(true);
    expect(Object.keys(record.charges)).toEqual(["c2"]);
    expect(takeReady(ledger, { ownerId: "root" }).ok).toBe(true);
    expect(record.charges).toEqual({});
  });

  test("supersedeFork empties the map", () => {
    const { ledger, record } = chargedFork();
    expect(markReady(ledger, "f1", { ok: true, record: "done" }).ok).toBe(true);
    expect(supersedeFork(ledger, "f1").ok).toBe(true);
    expect(record.charges).toEqual({});
  });

  test("abandon empties the map", () => {
    const { ledger, record } = chargedFork();
    expect(abandon(ledger, "f1", "no result").ok).toBe(true);
    expect(record.charges).toEqual({});
    expect(record.spent).toEqual({ read: 2 });
  });

  test("a closed branch cannot be refunded, so the trail was dead weight", () => {
    const { ledger } = chargedFork();
    expect(markReady(ledger, "f1", { ok: true, record: "done" }).ok).toBe(true);
    const refunded = applyRefund(ledger, "f1", "c1");
    expect(refunded.refunded).toBe(0);
    expect(forkOf(ledger, "f1").spent).toEqual({ read: 2 });
  });
});

describe("a running branch keeps one amend window", () => {
  test("fifty groups collapse to the newest sixteen", () => {
    const ledger = ledgerWith([{ forkId: "f1", budget: { read: 100 } }]);
    for (let index = 0; index < 50; index += 1) {
      const charged = applyCharge(ledger, "f1", {
        toolCallId: `c${index}`,
        tool: "read",
        amount: 1,
        groupKey: `g${index}`,
      });
      expect(charged.ok).toBe(true);
    }
    const record = forkOf(ledger, "f1");
    expect(Object.keys(record.charges)).toHaveLength(16);
    expect(record.charges.c49).toBeTruthy();
    expect(record.charges.c34).toBeTruthy();
    expect(record.charges.c33).toBeUndefined();
    // The spend stays exact: only the receipt trail is trimmed.
    expect(record.spent).toEqual({ read: 50 });
    expect(record.remaining).toEqual({ read: 50 });
  });

  test("the newest group still dedupes and still refunds", () => {
    const ledger = ledgerWith([{ forkId: "f1", budget: { read: 100 } }]);
    for (let index = 0; index < 40; index += 1) {
      applyCharge(ledger, "f1", {
        toolCallId: `c${index}`,
        tool: "read",
        amount: 1,
        groupKey: `g${index}`,
      });
    }
    applyCharge(ledger, "f1", {
      toolCallId: "c-latest",
      tool: "read",
      amount: 1,
      groupKey: "g-latest",
    });
    const repeated = applyCharge(ledger, "f1", {
      toolCallId: "c-other",
      tool: "read",
      amount: 1,
      groupKey: "g-latest",
    });
    expect(repeated.alreadyCharged).toBe(true);
    expect(forkOf(ledger, "f1").spent).toEqual({ read: 41 });

    expect(applyRefund(ledger, "f1", "c-latest").refunded).toBe(1);
    expect(forkOf(ledger, "f1").spent).toEqual({ read: 40 });
    expect(forkOf(ledger, "f1").remaining).toEqual({ read: 60 });
  });

  test("ungrouped calls keep the newest thirty-two", () => {
    const ledger = ledgerWith([{ forkId: "f1", budget: { read: 100 } }]);
    for (let index = 0; index < 50; index += 1) {
      applyCharge(ledger, "f1", {
        toolCallId: `c${index}`,
        tool: "read",
        amount: 1,
      });
    }
    const record = forkOf(ledger, "f1");
    expect(Object.keys(record.charges)).toHaveLength(32);
    expect(record.charges.c49).toBeTruthy();
    expect(record.charges.c18).toBeTruthy();
    expect(record.charges.c17).toBeUndefined();
    expect(record.spent).toEqual({ read: 50 });
  });
});

describe("session charges follow the live branches", () => {
  function charge(ledger, state, ownerId, count, groupPrefix) {
    for (let index = 0; index < count; index += 1) {
      const charged = chargeBranch(state, ledger, {
        ownerId,
        toolCallId: `${ownerId}-${groupPrefix}-${index}`,
        toolName: "read",
        groupKey: `${ownerId}-${groupPrefix}-${index}`,
      });
      expect(charged.ok).toBe(true);
    }
  }

  test("a closed branch leaves nothing behind", () => {
    const state = createState();
    const ledger = ledgerWith([
      { forkId: "f1" },
      { forkId: "f2" },
      { forkId: "f3" },
    ]);
    charge(ledger, state, "f1", 30, "a");
    expect(markReady(ledger, "f1", { ok: true, record: "done" }).ok).toBe(true);
    charge(ledger, state, "f2", 30, "b");
    expect(abandon(ledger, "f2", "no result").ok).toBe(true);
    charge(ledger, state, "f3", 30, "c");

    const owners = new Set(Object.values(state.charges).map((entry) => entry.ownerId));
    expect(owners.has("f1")).toBe(false);
    expect(owners.has("f2")).toBe(false);
    expect(owners.has("f3")).toBe(true);
    expect(Object.keys(state.charges).length).toBeLessThanOrEqual(32);
  });

  test("a live branch still refuses a replayed call and still refunds", () => {
    const state = createState();
    const ledger = ledgerWith([{ forkId: "f1" }]);
    charge(ledger, state, "f1", 40, "a");
    const repeated = chargeBranch(state, ledger, {
      ownerId: "f1",
      toolCallId: "f1-a-39",
      toolName: "read",
    });
    expect(repeated.alreadyCharged).toBe(true);

    const refunded = refundBranch(state, ledger, {
      ownerId: "f1",
      toolCalls: [{ id: "f1-a-39" }],
    });
    expect(refunded.refunded).toBe(1);
    expect(state.charges["f1-a-39"]).toBeUndefined();
    expect(forkOf(ledger, "f1").spent).toEqual({ read: 39 });
  });

  test("fifty groups on one branch collapse to the newest sixteen", () => {
    const state = createState();
    const ledger = ledgerWith([{ forkId: "f1" }]);
    charge(ledger, state, "f1", 50, "a");
    expect(Object.keys(state.charges)).toHaveLength(16);
    expect(state.charges["f1-a-49"]).toBeTruthy();
    expect(state.charges["f1-a-34"]).toBeTruthy();
    expect(state.charges["f1-a-33"]).toBeUndefined();
    expect(forkOf(ledger, "f1").spent).toEqual({ read: 50 });
  });
});
