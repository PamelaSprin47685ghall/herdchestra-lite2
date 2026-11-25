// Retired beats are deduplicated in arrival order. The live array is exposed,
// so membership must also reflect in-place edits made through existing aliases.

import { describe, expect, test } from "bun:test";
import { applyAmend } from "../src/scope/accounting.mjs";

function state(amends = [], charges = {}) {
  return { amends, charges };
}

describe("amends membership", () => {
  test("a new beat key is appended once, in arrival order", () => {
    const s = state();
    applyAmend(s, null, { beat: { key: "b1" } });
    applyAmend(s, null, { beat: { key: "b2" } });
    expect(s.amends).toEqual(["b1", "b2"]);
  });

  test("the same beat key is not appended twice", () => {
    const s = state();
    applyAmend(s, null, { beat: { key: "b1" } });
    applyAmend(s, null, { beat: { key: "b1" } });
    applyAmend(s, null, { beat: { key: "b2" } });
    applyAmend(s, null, { beat: { key: "b1" } });
    expect(s.amends).toEqual(["b1", "b2"]);
  });

  test("an invalid beat is refused and leaves the list untouched", () => {
    const s = state(["kept"]);
    expect(applyAmend(s, null, { beat: { key: "" } }).ok).toBe(false);
    expect(applyAmend(s, null, { beat: null }).ok).toBe(false);
    expect(s.amends).toEqual(["kept"]);
  });

  test("a restored array still deduplicates", () => {
    // A restore installs a fresh array; membership uses its current contents.
    const restored = state(["old-1", "old-2"]);
    applyAmend(restored, null, { beat: { key: "old-1" } });
    expect(restored.amends).toEqual(["old-1", "old-2"]);
    applyAmend(restored, null, { beat: { key: "new-1" } });
    expect(restored.amends).toEqual(["old-1", "old-2", "new-1"]);
  });

  test("an array grown through an alias still deduplicates", () => {
    // Membership reflects the current array, including an external append.
    const s = state(["a"]);
    applyAmend(s, null, { beat: { key: "a" } });
    s.amends.push("b"); // bypasses the cache
    applyAmend(s, null, { beat: { key: "b" } });
    expect(s.amends).toEqual(["a", "b"]);
  });

  test("a same-length in-place change does not leave membership stale", () => {
    const s = state(["a"]);
    applyAmend(s, null, { beat: { key: "a" } });
    s.amends[0] = "b";
    applyAmend(s, null, { beat: { key: "a" } });
    expect(s.amends).toEqual(["b", "a"]);
  });

  test("the refund still runs when the beat was already retired", () => {
    const s = state([], { call1: { ownerId: "w", tool: "read", amount: 1 } });
    applyAmend(s, null, { ownerId: "w", beat: { key: "b1" }, toolCalls: [{ id: "call1" }] });
    expect(s.amends).toEqual(["b1"]);
    expect(s.charges).toEqual({});
    // A repeat retires nothing new and refunds nothing new.
    applyAmend(s, null, { ownerId: "w", beat: { key: "b1" }, toolCalls: [{ id: "call1" }] });
    expect(s.amends).toEqual(["b1"]);
    expect(s.charges).toEqual({});
  });
});
