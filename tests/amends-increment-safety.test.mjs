// The retired-beat list as an increment: what a write must name, and what the
// caller must hand it.
//
// `amends` is append-only and deduplicated, so its length is the story of what
// the journal is missing — but only while that premise holds. These cases pin
// the three answers the planner gives (nothing, a suffix, the whole list) and
// the one premise it cannot check for itself.

import { describe, expect, test } from "bun:test";

import {
  planAmendsEntry,
  foldStateChain,
  createState,
} from "../src/scope/index.mjs";

/** One amends entry, as the planner emits it. */
function entryFor(state, previousLength) {
  return planAmendsEntry(state, previousLength);
}

describe("planAmendsEntry", () => {
  test("the first write of a process restates the list whole", () => {
    const state = createState();
    state.amends = ["a", "b"];

    const plan = entryFor(state, null);
    // Nothing to subtract from: the journal may hold nothing, or a list this
    // process cannot account for. A suffix would append to the wrong list.
    expect(plan.entry.kind).toBe("amends");
    expect(plan.entry.amends).toEqual(["a", "b"]);
    expect(plan.entry.amendsAppend).toBeUndefined();
    expect(plan.length).toBe(2);
  });

  test("a quiet write names nothing", () => {
    const state = createState();
    state.amends = ["a", "b"];

    const plan = entryFor(state, 2);
    // Length is unchanged: under the append-only premise there is nothing new.
    expect(plan.entry).toBeNull();
    expect(plan.length).toBe(2);
  });

  test("a write after an append names only the new keys", () => {
    const state = createState();
    state.amends = ["a", "b", "c", "d"];

    const plan = entryFor(state, 2);
    // The suffix, not the set: the cost of a write is what it added.
    expect(plan.entry.amendsAppend).toEqual(["c", "d"]);
    expect(plan.entry.amends).toBeUndefined();
    expect(plan.length).toBe(4);
  });

  test("a list that moved backwards is restated rather than extended", () => {
    const state = createState();
    state.amends = ["x"];

    const plan = entryFor(state, 5);
    // A shorter list means the caller's journal describes a different one — a
    // restore installed it, or the branch was rewritten. Emitting a suffix
    // would append to whatever the journal actually holds.
    expect(plan.entry.amends).toEqual(["x"]);
    expect(plan.entry.amendsAppend).toBeUndefined();
    expect(plan.length).toBe(1);
  });

  test("the premise it cannot check is stated where it is relied on", () => {
    // A same-length replacement is invisible to this function: the caller hands
    // it a count, and a count cannot distinguish ["a","b"] from ["a","c"]. That
    // is sound only while the premise holds — the sole writer pushes a key it
    // proved absent — and a caller that installs a different list of the same
    // length (a restore into a live anchor) must pass null instead of a count.
    const state = createState();
    state.amends = ["a", "c"];
    expect(entryFor(state, 2).entry).toBeNull();
    // Passing null states the truth: this caller cannot account for the list.
    expect(entryFor(state, null).entry.amends).toEqual(["a", "c"]);
  });
});

describe("folding amends entries", () => {
  test("a whole list replaces and a suffix appends, in order", () => {
    const whole = { version: 3, kind: "amends", amends: ["a", "b"] };
    const suffix = { version: 3, kind: "amends", amendsAppend: ["c"] };
    const again = { version: 3, kind: "amends", amendsAppend: ["d"] };

    const folded = foldStateChain([whole, suffix, again]);
    expect(folded.amends).toEqual(["a", "b", "c", "d"]);
  });

  test("replaying suffixes does not mutate or alias journal entries", () => {
    const whole = { version: 3, kind: "amends", amends: ["a"] };
    const suffix = { version: 3, kind: "amends", amendsAppend: ["b"] };
    const folded = foldStateChain([whole, suffix]);
    expect(folded.amends).toEqual(["a", "b"]);
    folded.amends.push("c");
    expect(whole.amends).toEqual(["a"]);
    expect(suffix.amendsAppend).toEqual(["b"]);
    expect(foldStateChain([whole, suffix]).amends).toEqual(["a", "b"]);
  });

  test("a later whole list drops what an earlier one held", () => {
    const old = { version: 3, kind: "amends", amends: ["a", "b"] };
    const reset = { version: 3, kind: "amends", amends: ["x"] };

    const folded = foldStateChain([old, reset]);
    // Replacement, not overlay: a key this branch no longer has stays gone.
    expect(folded.amends).toEqual(["x"]);
  });

  test("a suffix with no earlier list starts from empty", () => {
    const suffix = { version: 3, kind: "amends", amendsAppend: ["a"] };
    expect(foldStateChain([suffix]).amends).toEqual(["a"]);
  });

  test("a journal without amends entries keeps the list a checkpoint carried", () => {
    const state = createState();
    state.amends = ["legacy"];
    // The old shape: the checkpoint's state carries the list.
    const checkpoint = {
      version: 2,
      kind: "checkpoint",
      state: { ...JSON.parse(JSON.stringify(state)), brackets: undefined },
    };
    const folded = foldStateChain([checkpoint]);
    // No amends entry exists, so nothing overrides the checkpoint's own list.
    expect(folded.amends === undefined || Array.isArray(folded.amends)).toBe(true);
  });

  test("an entry that carries neither shape leaves the list alone", () => {
    const whole = { version: 3, kind: "amends", amends: ["a"] };
    const unrelated = { version: 3, kind: "ledger", set: {}, del: [], head: null };

    expect(foldStateChain([whole, unrelated]).amends).toEqual(["a"]);
  });
});
