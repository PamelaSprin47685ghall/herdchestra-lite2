// Every domain method that moves a bracket's own fields must say so.
//
// `changed()` marks the *structure*, and the structural rebuild happens to
// compare scalar record fields, so a missing record mark can look harmless —
// until a field is an object. `settleCharges` states that case in its own
// comment: an emptied charges map is invisible to the field comparison, which
// is why it marks the record. The same reasoning applies to every other writer
// here, and none of them may rely on the comparison by accident.
//
// These cases read the ledger's unsettled set directly: it is the contract the
// persistence layer consumes, so a method that forgets to mark shows up as a
// missing id rather than as a wrong value somewhere downstream.

import { describe, test, expect } from "bun:test";

import {
  createBracketLedger,
  registerFork,
  markReady,
  takeReady,
  abandon,
  adoptFork,
  reparentOrphans,
  rehomeReadyResults,
} from "../src/scope/index.mjs";
import { commitPersisted, ledgerPending } from "../src/scope/ledger-cache.mjs";

function ledgerWith(ids) {
  const ledger = createBracketLedger();
  for (const forkId of ids) {
    const registered = registerFork(ledger, {
      forkId,
      ownerId: "root",
      fsm: "one state",
      depth: 0,
      budget: { read: 1 },
      profession: "You are a tester.",
    });
    expect(registered.ok).toBe(true);
  }
  // Start from a settled ledger: the registration itself is a structural
  // change, and these cases are about what happens afterwards.
  commitPersisted(ledger);
  return ledger;
}

const owed = (ledger) => ledgerPending(ledger).records.slice().sort();

describe("closing a bracket", () => {
  test("markReady says the record moved", () => {
    const ledger = ledgerWith(["a"]);
    expect(owed(ledger)).toEqual([]);

    expect(markReady(ledger, "a", { ok: true, record: "done" }).ok).toBe(true);
    expect(owed(ledger)).toEqual(["a"]);
  });

  test("markReady on a restored record without a charges map still marks", () => {
    // A restored record can arrive without `charges`. `settleCharges` returns
    // early for that shape, so the mark has to come from `markReady` itself.
    const ledger = ledgerWith(["a"]);
    delete ledger.forks.a.charges;

    expect(markReady(ledger, "a", { ok: true, record: "done" }).ok).toBe(true);
    expect(owed(ledger)).toEqual(["a"]);
    expect(ledger.forks.a.status).toBe("ready");
  });

  test("takeReady says the joined record moved", () => {
    const ledger = ledgerWith(["a"]);
    markReady(ledger, "a", { ok: true, record: "done" });
    commitPersisted(ledger);
    expect(owed(ledger)).toEqual([]);

    const taken = takeReady(ledger, { ownerId: "root" });
    expect(taken.ok).toBe(true);
    expect(ledger.forks.a.status).toBe("joined");
    expect(owed(ledger)).toEqual(["a"]);
  });

  test("abandon says the record moved even without a charges map", () => {
    const ledger = ledgerWith(["a"]);
    delete ledger.forks.a.charges;

    expect(abandon(ledger, "a", "cancelled").ok).toBe(true);
    expect(ledger.forks.a.status).toBe("failed");
    expect(owed(ledger)).toEqual(["a"]);
  });
});

describe("moving a result to another receiver", () => {
  test("adoptFork marks the record it re-owned", () => {
    const ledger = ledgerWith(["a", "b"]);
    markReady(ledger, "a", { ok: true, record: "done" });
    registerFork(ledger, {
      forkId: "b",
      ownerId: "root",
      fsm: "one state",
      depth: 0,
      budget: { read: 1 },
      profession: "You are a tester.",
    });
    markReady(ledger, "b", { ok: true, record: "done" });
    commitPersisted(ledger);

    const adopted = adoptFork(ledger, "a", "b");
    expect(adopted.ok).toBe(true);
    expect(adopted.adopted).toBe(true);
    expect(ledger.forks.a.ownerId).toBe("b");
    expect(owed(ledger)).toEqual(["a"]);
  });

  test("reparentOrphans marks every record whose owner it moved", () => {
    const ledger = ledgerWith(["a", "b"]);
    // Two running children of "a"; "a" itself belongs to root.
    for (const forkId of ["c", "d"]) {
      expect(
        registerFork(ledger, {
          forkId,
          ownerId: "a",
          fsm: "one state",
          depth: 1,
          budget: { read: 1 },
          profession: "You are a tester.",
        }).ok,
      ).toBe(true);
    }
    commitPersisted(ledger);

    const moved = reparentOrphans(ledger, "a", "root");
    expect(moved.ok).toBe(true);
    expect(moved.moved).toBe(2);
    expect(ledger.forks.c.ownerId).toBe("root");
    expect(owed(ledger)).toEqual(["c", "d"]);
  });

  test("rehomeReadyResults marks the ready records it re-owned", () => {
    const ledger = ledgerWith(["a"]);
    // "b" is a child of "a". "a" returns and is joined away, so a reload has to
    // point b's result at a receiver that can still take it.
    expect(
      registerFork(ledger, {
        forkId: "b",
        ownerId: "a",
        fsm: "one state",
        depth: 1,
        budget: { read: 1 },
        profession: "You are a tester.",
      }).ok,
    ).toBe(true);
    markReady(ledger, "b", { ok: true, record: "child done" });
    markReady(ledger, "a", { ok: true, record: "parent done" });
    expect(takeReady(ledger, { ownerId: "root" }).ok).toBe(true);
    expect(ledger.forks.a.status).toBe("joined");
    expect(ledger.forks.b.ownerId).toBe("a");
    commitPersisted(ledger);

    const rehomed = rehomeReadyResults(ledger);
    expect(rehomed.moved).toBe(1);
    // "a" can never take a result again, so "b" follows the receiver chain to
    // the root. An unknown owner would stay put by design; a joined one cannot.
    expect(ledger.forks.b.ownerId).toBe("root");
    expect(owed(ledger)).toEqual(["b"]);
  });
});
