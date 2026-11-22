// The host only ends a running tool on a queued user message when the tool
// declares itself interruptible. Removing the declaration would silently turn
// scope_join back into a wait the user cannot break into, so the registration
// is part of the contract.

import { describe, expect, test } from "bun:test";

import { wireTools } from "../src/activation/tools.mjs";

function fakeHost() {
  const tools = new Map();
  return {
    tools,
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
  };
}

describe("scope_join registration", () => {
  test("declares a wait the host may interrupt for user input", () => {
    const pi = fakeHost();
    wireTools(pi, {});

    const join = pi.tools.get("scope_join");
    expect(join.interruptible).toBe(true);
    // A queued interrupt lets the call run so the elder report is settled
    // instead of skipped.
    expect(join.handlesToolInterrupt).toBe(true);
  });
});
