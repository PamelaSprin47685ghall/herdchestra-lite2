import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { validateFork, validateForkBatch } from "../src/station/domain/fork-join.mjs";
import { createBracketLedger } from "../src/scope/forkjoin.mjs";
import { createState } from "../src/scope/state.mjs";
import { handleForkCall } from "../src/station/fork-controls.mjs";
import { forkParameters } from "../src/tools/descriptions.mjs";

const base = {
  scopeId: "alpha",
  dafny_pseudo_code: "read the parser",
  profession: "You are a precise reviewer who rejects a claim without evidence",
  blocked: false,
  budget: { read: 2 },
  targets: ["the parser"],
};

describe("scope_fork profession", () => {
  test("the item schema requires a You are statement", () => {
    const item = forkParameters.properties.forks.items;
    assert.ok(item.required.includes("profession"));
    assert.equal(item.properties.profession.pattern, "^You are \\S");
    assert.equal(item.properties.profession.minLength, 9);
  });

  test("validateFork trims and returns the profession", () => {
    const out = validateFork({ ...base, profession: `  ${base.profession}  ` });
    assert.equal(out.ok, true);
    assert.equal(out.profession, base.profession);
  });

  test("validateFork refuses a mistyped identity", () => {
    for (const profession of ["a reviewer", "you are a reviewer"]) {
      const out = validateFork({ ...base, profession });
      assert.equal(out.ok, false);
      assert.equal(out.code, "INVALID_PROFESSION");
    }
  });

  test("validateFork allows an omitted identity so a reuse can amend one field", () => {
    const out = validateFork({ ...base, profession: undefined });
    assert.equal(out.ok, true);
    assert.equal(out.profession, "");
  });

  test("the spawned receipt opens with the marker and then the identity", () => {
    const ledger = createBracketLedger();
    const spawned = [];
    const station = {
      state: createState(),
      forkLedgerPort: () => ledger,
      childSpawnPort: () => (spec) => spawned.push(spec),
    };
    handleForkCall(station, {
      id: "fork-call",
      arguments: { forks: [base] },
    });
    assert.equal(spawned.length, 1);
    const lines = spawned[0].receipt.split("\n");
    assert.ok(lines[0].startsWith("You are the child of fork"));
    assert.equal(lines[1], base.profession);
  });

  test("validateForkBatch rejects the whole batch on a mistyped identity", () => {
    const out = validateForkBatch({
      forks: [base, { ...base, scopeId: "beta", profession: "just do it" }],
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, "INVALID_PROFESSION");
    assert.equal(out.index, 1);
  });
});
