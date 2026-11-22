// Join admission: a child record larger than the parent's window must not be
// delivered for the provider to reject.
//
// The station keeps the ready result when admission fails. A smaller ready
// child may still be taken; a join with nothing admissible answers immediately
// instead of parking for work it can never receive.

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SAFETY_MARGIN_TOKENS,
  estimateJoinTokens,
  joinAdmission,
} from "../src/scope/admission.mjs";
import {
  createBracketLedger,
  forkOf,
  markReady,
  readyChildren,
  registerFork,
  takeReady,
} from "../src/scope/forkjoin.mjs";
import { handleJoinCall } from "../src/station/fork-controls.mjs";
import { createForkRegistry, waitForReady } from "../src/scope/fork-registry.mjs";

function ledgerWith(ids) {
  const ledger = createBracketLedger();
  for (const id of ids) {
    registerFork(ledger, {
      forkId: id,
      ownerId: "root",
      levelKey: "root|0|0",
      intent: `work ${id}`,
      depth: 0,
    });
  }
  return ledger;
}

function stationFor(ledger, options = {}) {
  return {
    state: { receipts: [], relay: { generation: 0, fullFlow: false } },
    forkLedgerPort: () => ledger,
    forkIdentityPort: () => null,
    forkOwnerId: () => null,
    contextMessages: () => [],
    currentContextTokens: () => 0,
    tokensPerCharFor: () => 1,
    childOutcomePort: () => null,
    usage: { lastUsageModelKey: null },
    ...options,
  };
}

describe("the admission verdict", () => {
  test("an unknown window cannot prove a refusal", () => {
    const verdict = joinAdmission({ window: null, projected: 1_000_000 });
    expect(verdict.ok).toBe(true);
    expect(verdict.source).toBe("unknown-window");
  });

  test("an unmeasured request is not treated as zero", () => {
    const verdict = joinAdmission({ window: 100_000, projected: Number.POSITIVE_INFINITY });
    expect(verdict.ok).toBe(true);
    expect(verdict.source).toBe("unknown-request");
  });

  test("the boundary is strict: projected plus reserve plus margin must stay below", () => {
    const at = joinAdmission({
      window: 1_000,
      projected: 800,
      reserve: 100,
      margin: 100,
    });
    expect(at.ok).toBe(false);
    expect(at.code).toBe("JOIN_CONTEXT_EXCEEDED");
    expect(at.overBy).toBe(0);
    const below = joinAdmission({
      window: 1_000,
      projected: 799,
      reserve: 100,
      margin: 100,
    });
    expect(below.ok).toBe(true);
  });

  test("the default reserve is a named constant, not a hidden number", () => {
    expect(Number.isInteger(DEFAULT_SAFETY_MARGIN_TOKENS)).toBe(true);
    const verdict = joinAdmission({ window: 10_000, projected: 1 });
    expect(verdict.reserve).toBeGreaterThan(0);
    expect(verdict.margin).toBe(DEFAULT_SAFETY_MARGIN_TOKENS);
  });

  test("the record's characters are priced at the model's density", () => {
    expect(
      estimateJoinTokens({ baseTokens: 100, recordChars: 1_000, tokensPerChar: 0.3 }),
    ).toBe(400);
    expect(
      estimateJoinTokens({ baseTokens: 100, recordChars: 10, tokensPerChar: 0 }),
    ).toBe(100);
  });
});

describe("a join skips what it cannot deliver", () => {
  test("an oversized head does not block a smaller ready child", () => {
    const ledger = ledgerWith(["big", "small"]);
    markReady(ledger, "big", { ok: true, record: "x".repeat(500) });
    markReady(ledger, "small", { ok: true, record: "small record" });
    const taken = takeReady(ledger, {
      ownerId: "root",
      levelKey: "root|0|0",
      admit: (record) =>
        record.forkId === "big"
          ? { ok: false, code: "JOIN_CONTEXT_EXCEEDED", reason: "too large" }
          : { ok: true },
    });
    expect(taken.ok).toBe(true);
    expect(taken.fork.forkId).toBe("small");
    expect(readyChildren(ledger, "root")).toEqual(["big"]);
    expect(forkOf(ledger, "big").status).toBe("ready");
  });

  test("when nothing fits, the take consumes nothing and names every refusal", () => {
    const ledger = ledgerWith(["big", "also-big"]);
    markReady(ledger, "big", { ok: true, record: "x".repeat(500) });
    markReady(ledger, "also-big", { ok: true, record: "y".repeat(500) });
    const taken = takeReady(ledger, {
      ownerId: "root",
      levelKey: "root|0|0",
      admit: () => ({ ok: false, code: "JOIN_CONTEXT_EXCEEDED", reason: "too large" }),
    });
    expect(taken.ok).toBe(false);
    expect(taken.code).toBe("NO_ADMISSIBLE_CHILD");
    expect(taken.blocked.map((entry) => entry.forkId)).toEqual(["big", "also-big"]);
    expect(readyChildren(ledger, "root")).toEqual(["big", "also-big"]);
  });

  test("a waiting join answers instead of parking when nothing can fit", async () => {
    const registry = createForkRegistry();
    const ledger = ledgerWith(["big"]);
    markReady(ledger, "big", { ok: true, record: "x".repeat(500) });
    const waited = await waitForReady(registry, ledger, {
      ownerId: "root",
      levelKey: "root|0|0",
      admit: () => ({ ok: false, code: "JOIN_CONTEXT_EXCEEDED", reason: "too large" }),
    });
    expect(waited.ok).toBe(false);
    expect(waited.code).toBe("JOIN_CONTEXT_EXCEEDED");
    expect(forkOf(ledger, "big").status).toBe("ready");
  });
});

describe("the join handler refuses before the take", () => {
  test("a record over the parent window leaves the bracket ready", () => {
    const ledger = ledgerWith(["f1"]);
    markReady(ledger, "f1", { ok: true, record: "x".repeat(200) });
    const station = stationFor(ledger, {
      currentContextTokens: () => 900,
      tokensPerCharFor: () => 1,
      forkWindowPort: () => 1_000,
      forkReservePort: () => 0,
      forkMarginPort: () => 0,
    });
    const out = handleJoinCall(station, { id: "j1" });
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("JOIN_CONTEXT_EXCEEDED");
    expect(out.details.blocked[0].forkId).toBe("f1");
    expect(forkOf(ledger, "f1").status).toBe("ready");
    expect(readyChildren(ledger, "root")).toEqual(["f1"]);
  });

  test("without a known window the same record is delivered", () => {
    const ledger = ledgerWith(["f1"]);
    markReady(ledger, "f1", { ok: true, record: "x".repeat(200) });
    const station = stationFor(ledger, { currentContextTokens: () => 900 });
    const out = handleJoinCall(station, { id: "j1" });
    expect(out.isError).toBeUndefined();
    expect(out.details.joined).toBe(true);
  });
});
