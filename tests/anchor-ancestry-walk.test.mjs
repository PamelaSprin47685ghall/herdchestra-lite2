// The anchor's ancestry checks must not cost the whole conversation per write.
//
// A persist asks up to three questions of the same shape — "is entry X still on
// this leaf's chain" — for the state baseline, the ledger snapshot and the
// amends baseline. The implementation used to answer each one by materialising
// the entire branch, so a single write copied an entry per message in the
// session, three times over. These cases pin the replacement: one walk from the
// leaf, no branch copy when the host can address a single entry, and the same
// answers as before.
//
// They also pin the soundness the walk must keep. A cached verdict keyed on the
// leaf id alone was wrong once already: a rewrite can reparent an entry, so an
// entry can exist in the journal and no longer be an ancestor of the same leaf.
// The walk remembers nothing between calls, and the reparent case below would
// fail if it did.
//
// Not run here — the parent serialises test execution.

import { describe, expect, test } from "bun:test";

import { createPersistenceAnchor } from "../src/station/persistence-anchor.mjs";

const TYPE = "scope.state";

/**
 * A host tree: entries linked by parentId, one leaf.
 *
 * `addressable: false` models a manager that can only return the whole branch —
 * the older host shape — so the fallback path is exercised rather than assumed.
 */
function host({ addressable = true } = {}) {
  let leafId = "base";
  let serial = 0;
  const entries = new Map([["base", { id: "base", parentId: null }]]);
  const written = [];
  const counts = { branch: 0, getEntry: 0 };

  const manager = {
    getLeafId: () => leafId,
    getLeafEntry: () => entries.get(leafId),
    getBranch: () => {
      counts.branch += 1;
      const chain = [];
      let cursor = leafId;
      while (cursor) {
        const entry = entries.get(cursor);
        if (!entry) break;
        chain.push(entry);
        cursor = entry.parentId;
      }
      return chain.reverse();
    },
    appendCustomEntry: (type, data) => {
      const id = `e${++serial}`;
      entries.set(id, { id, parentId: leafId, type: "custom", customType: type, data });
      leafId = id;
      written.push({ id, data });
      return id;
    },
    /** Leave `id` as the leaf, dropping everything after it — a fold. */
    foldTo: (id) => {
      expect(entries.has(id)).toBe(true);
      leafId = id;
    },
    /** Reparent an entry as a rewrite would, keeping its id and the leaf id. */
    reparent: (id, parentId) => {
      const entry = entries.get(id);
      expect(entry).toBeDefined();
      entry.parentId = parentId;
    },
    /** Put an id in the journal without putting it on the chain. */
    orphan: (id) => {
      entries.set(id, { id, parentId: null });
    },
  };
  if (addressable) {
    manager.getEntry = (id) => {
      counts.getEntry += 1;
      return entries.get(id);
    };
  }
  return { manager, written, counts };
}

function anchorFor(manager) {
  let value = 0;
  const errors = [];
  const anchor = createPersistenceAnchor({
    manager,
    state: () => ({ value }),
    initialState: null,
    initialEntryId: null,
    serialize: (state) => JSON.stringify(state),
    // A missing baseline owes a checkpoint; otherwise a delta.
    plan: (previous, next) =>
      previous === next ? null : { kind: previous === null ? "checkpoint" : "delta" },
    planLedger: () => ({ entry: null, brackets: null }),
    split: (full) => ({ core: full }),
    type: TYPE,
    noteError: (where, error) => errors.push({ where, error: String(error) }),
  });
  return {
    anchor,
    errors,
    bump() {
      value += 1;
    },
  };
}

describe("a write does not copy the branch per question", () => {
  test("an addressable host is walked, never copied whole", () => {
    const { manager, written, counts } = host();
    const { anchor, bump } = anchorFor(manager);

    bump();
    expect(anchor.persist()).toBe(true);
    expect(written.at(-1).data.kind).toBe("checkpoint");

    // Five more writes, each with a baseline to verify. A host entry lands above
    // the anchor first, so the walk really has to climb instead of finding the
    // anchor at the leaf.
    for (let step = 0; step < 5; step += 1) {
      manager.appendCustomEntry("message", { kind: "message" });
      manager.appendCustomEntry("message", { kind: "message" });
      bump();
      expect(anchor.persist()).toBe(true);
    }

    // Six writes, and not one whole-branch read: the common case used to cost
    // three per write.
    expect(counts.branch).toBe(0);
    // The walk did ask for individual entries, which is the cheaper question.
    expect(counts.getEntry).toBeGreaterThan(0);
    // Only the first write owed a checkpoint.
    expect(written.slice(1).filter((item) => item.data.kind !== "message")
      .every((item) => item.data.kind === "delta")).toBe(true);
  });

  test("a host that cannot address one entry is read once, not once per question", () => {
    const { manager, counts } = host({ addressable: false });
    const { anchor, bump } = anchorFor(manager);

    bump();
    expect(anchor.persist()).toBe(true);
    const afterFirst = counts.branch;

    manager.appendCustomEntry("message", { kind: "message" });
    manager.appendCustomEntry("message", { kind: "message" });
    bump();
    expect(anchor.persist()).toBe(true);
    const secondWrite = counts.branch - afterFirst;

    // One write, one branch read. The previous form asked three times when the
    // state anchor, the ledger snapshot and the amends baseline were all set.
    expect(secondWrite).toBe(1);
  });
});

describe("the walk keeps the soundness the cache lost", () => {
  test("a mismatched lookup cannot prove ancestry", () => {
    const { manager, written } = host();
    const { anchor, bump } = anchorFor(manager);
    bump();
    expect(anchor.persist()).toBe(true);
    const baseline = written.at(-1).id;
    manager.appendCustomEntry("message", { kind: "message" });
    manager.appendCustomEntry("message", { kind: "message" });
    const leafId = manager.getLeafId();
    manager.reparent(leafId, "base");
    manager.getEntry = () => ({ id: "unrelated", parentId: baseline });
    bump();
    expect(anchor.persist()).toBe(true);
    expect(written.at(-1).data.kind).toBe("checkpoint");
  });

  test("a stale leaf object does not determine another entry's ancestry", () => {
    const { manager, written } = host();
    const { anchor, bump } = anchorFor(manager);
    bump();
    expect(anchor.persist()).toBe(true);
    const baseline = written.at(-1).id;
    manager.appendCustomEntry("message", { kind: "message" });
    const realLeaf = manager.getLeafId();
    // The stale object has an unrelated id and falsely points to baseline;
    // getEntry(realLeaf) still describes the actual chain.
    manager.orphan("unrelated");
    manager.reparent(realLeaf, "base");
    manager.getLeafEntry = () => ({ id: "unrelated", parentId: baseline });
    bump();
    expect(anchor.persist()).toBe(true);
    expect(written.at(-1).data.kind).toBe("checkpoint");
  });

  test("an entry reparented out of the chain still forces a checkpoint", () => {
    const { manager, written } = host();
    const { anchor, bump } = anchorFor(manager);

    bump();
    expect(anchor.persist()).toBe(true);
    const anchorId = written.at(-1).id;

    // A host advance, then a rewrite that lifts the *leaf* out of the anchor's
    // subtree: the entry stays where it is, but the chain now runs from the leaf
    // straight to the base. Leaf id and anchor id both stay the same, which is
    // exactly the shape a leaf-keyed cache answered wrongly.
    manager.appendCustomEntry(TYPE, { kind: "delta" });
    const leafBefore = manager.getLeafId();
    manager.reparent(leafBefore, "base");
    expect(manager.getLeafId()).toBe(leafBefore);

    bump();
    expect(anchor.persist()).toBe(true);
    // The baseline is provably gone, so the write is a checkpoint.
    expect(written.at(-1).data.kind).toBe("checkpoint");
  });

  test("an entry elsewhere in the journal is not mistaken for an ancestor", () => {
    const { manager, written } = host();
    const { anchor, bump } = anchorFor(manager);

    bump();
    expect(anchor.persist()).toBe(true);
    const anchorId = written.at(-1).id;

    // The anchor still exists as an entry, on no chain at all.
    manager.orphan(anchorId);
    manager.foldTo("base");

    bump();
    expect(anchor.persist()).toBe(true);
    expect(written.at(-1).data.kind).toBe("checkpoint");
  });

  test("a checkpoint sitting further up the chain is still found", () => {
    const { manager, written } = host();
    const { anchor, bump } = anchorFor(manager);

    bump();
    expect(anchor.persist()).toBe(true);
    const anchorId = written.at(-1).id;

    // Three unrelated host entries above the anchor: the walk has to traverse
    // them rather than give up after the immediate parent.
    for (let step = 0; step < 3; step += 1) {
      manager.appendCustomEntry("message", { kind: "message" });
    }

    bump();
    expect(anchor.persist()).toBe(true);
    // The anchor survived, so this is a delta, not a fresh checkpoint.
    expect(written.at(-1).data.kind).toBe("delta");
    expect(written.at(-1).id).not.toBe(anchorId);
  });
});
