import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { validateFork, validateForkBatch } from "../src/station/domain/fork-join.mjs";
import { createBracketLedger } from "../src/scope/ledger-brackets.mjs";
import { createState } from "../src/scope/state.mjs";
import { handleForkCall } from "../src/station/fork-controls.mjs";
import { loadDoc } from "../src/prompts/index.mjs";

const base = {
  path: "inspector.alpha",
  fsm: "read the parser",
  profession: "You are a precise reviewer who rejects a claim without evidence",
  budget: { read: 2 },
  targets: ["the parser"],
};

describe("scope_fork profession", () => {
  test("the model-facing fork copy states the identity rule", () => {
    // The JSON schema that used to carry the pattern is gone: `scope_fork` is
    // an api method now, so the rule the model must satisfy lives in the copy it
    // reads. If that sentence disappears the model has no way to know, and the
    // first refusal it meets is INVALID_PROFESSION.
    const copy = loadDoc("tools/fork-join")["fork.profession"];
    assert.ok(copy);
    assert.match(copy, /You are /);
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
    assert.ok(lines[0].startsWith("You are now in the scope"));
    assert.equal(lines[1], base.profession);
  });

  test("validateForkBatch rejects the whole batch on a mistyped identity", () => {
    const out = validateForkBatch({
      forks: [base, { ...base, path: "inspector.beta", profession: "just do it" }],
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, "INVALID_PROFESSION");
    assert.equal(out.index, 1);
  });
});
