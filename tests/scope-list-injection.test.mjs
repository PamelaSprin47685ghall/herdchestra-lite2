import { describe, expect, test } from "bun:test";

import { createBracketLedger, forkOf, markReady, registerFork } from "../src/scope/forkjoin.mjs";
import { skillReceiptText } from "../src/station/texts.mjs";

function ledgerWith(paths) {
  const ledger = createBracketLedger();
  for (const [index, path] of paths.entries()) {
    const forkId = `f-${index}`;
    const out = registerFork(ledger, {
      forkId,
      ownerId: "root",
      levelKey: "L0",
      fsm: `task ${forkId}`,
      depth: 0,
    });
    expect(out.ok).toBe(true);
    out.fork.path = path;
  }
  return ledger;
}

function receipt(ledger, selfPath) {
  const branch = selfPath === "/" ? null : Object.values(ledger.forks).find((r) => r.path === selfPath);
  const state = { brackets: ledger, autopilot: false, relay: { bigStreak: 0 } };
  return skillReceiptText(state, branch, 0, selfPath !== "/");
}

/** Every <skill> element of the receipt, in order. */
function skillElements(text) {
  return [...text.matchAll(/<skill version="1\.0" enforced>([\s\S]*?)<\/skill>/g)].map((m) => m[1]);
}

describe("active scope listing", () => {
  test("lists active paths in lexicographic order with the receiver's own path", () => {
    const ledger = ledgerWith(["/worker", "/api", "/api/auth"]);
    const text = receipt(ledger, "/api");
    const listing = skillElements(text).find((body) => body.includes("Active scopes"));
    expect(listing).toBeDefined();
    const lines = listing.trim().split("\n").slice(1).map((line) => line.trim());
    expect(lines[0]).toBe("Active scopes (self: /api):");
    expect(lines.slice(1)).toEqual(["/", "/api", "/api/auth", "/worker"]);
  });

  test("is a sibling element of its own, next to the status and language skills", () => {
    const ledger = ledgerWith(["/worker"]);
    const text = receipt(ledger, "/worker");
    const bodies = skillElements(text);
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    expect(bodies.filter((body) => body.includes("Active scopes"))).toHaveLength(1);
  });

  test("omits finished scopes and shows a woken one again", () => {
    const ledger = ledgerWith(["/worker", "/api"]);
    markReady(ledger, "f-0", { ok: true, record: "done" });
    const hidden = skillElements(receipt(ledger, "/")).find((body) => body.includes("Active scopes"));
    expect(hidden).toContain("/api");
    expect(hidden).not.toContain("/worker");

    forkOf(ledger, "f-0").woken = true;
    const shown = skillElements(receipt(ledger, "/")).find((body) => body.includes("Active scopes"));
    expect(shown).toContain("/worker");
  });

  test("the root's own path is /", () => {
    const ledger = ledgerWith(["/api"]);
    const listing = skillElements(receipt(ledger, "/")).find((body) =>
      body.includes("Active scopes"),
    );
    expect(listing).toContain("Active scopes (self: /):");
    expect(listing).toContain("\n/");
    expect(listing).toContain("\n/api");
  });
});
