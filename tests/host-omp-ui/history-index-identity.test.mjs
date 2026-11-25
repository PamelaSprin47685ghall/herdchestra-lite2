import { describe, expect, test } from "bun:test";

import {
  buildHistoryIndex,
  extendHistoryIndex,
} from "../../host-omp-ui/src/station/domain/transcript-model.mjs";
import { createUiBridgeStation } from "../../host-omp-ui/src/station/ui-bridge-station.mjs";

// An index is grown from the tail when the host appends to its own branch
// array, which is the common case and the reason a frame stays flat in cost.
//
// Equal length is not the same as no change: a branch can be rewound and
// re-appended to the same size, and that is a different conversation of the
// same length. Reusing the index then names ids that are gone and answers -1
// for the ones that are there, so paging reads as a stale cursor against a
// message that plainly exists.

const user = (id, text) => ({
  type: "message",
  id,
  message: { role: "user", content: [{ type: "text", text }] },
});

const assistant = (id, text) => ({
  type: "message",
  id,
  message: { role: "assistant", content: [{ type: "text", text }] },
});

const stationOver = (entries) => {
  const station = createUiBridgeStation({ capabilities: { dispatch() {} } });
  station.onSessionHydrate({ id: "s1", cwd: "/tmp" }, entries);
  return station;
};

describe("a branch rewound to the same length", () => {
  test("the index is rebuilt instead of reused", () => {
    const entries = [user("u1", "one"), user("u2", "two"), user("u3", "three")];
    const base = buildHistoryIndex(entries);
    expect(base.tailRef).toBe(entries[2]);

    // A rewind plus a re-append: same size, different conversation.
    entries[0] = user("k1", "other");
    entries[1] = user("k2", "other");
    entries[2] = user("k3", "other");

    const rebuilt = extendHistoryIndex(base, entries);
    expect(rebuilt).not.toBe(base);
    expect(rebuilt.idIndex.has("u1")).toBe(false);
    expect(rebuilt.idIndex.has("k1")).toBe(true);
    // The ordinal really points at the new entry.
    expect(entries[rebuilt.entryOfMessage[0]].id).toBe("k1");
  });

  test("a frame pages the new conversation and refuses the old ids", () => {
    const entries = [user("u1", "one"), user("u2", "two"), user("u3", "three")];
    const station = stationOver(entries);

    entries[0] = user("k1", "other");
    entries[1] = user("k2", "other");
    entries[2] = user("k3", "other");

    const page = station.historyPage({ before: "k3", limit: 2 });
    expect(page.ok).toBe(true);
    expect(page.messages.map((message) => message.id)).toEqual(["k1", "k2"]);

    // The id the branch no longer holds is genuinely gone.
    expect(station.historyPage({ before: "u1", limit: 2 })).toEqual({
      ok: false,
      code: "stale_cursor",
    });
  });

  test("a live message still lands at the tail after the rewind", () => {
    const entries = [user("u1", "one"), user("u2", "two")];
    const station = stationOver(entries);

    entries[0] = user("k1", "other");
    entries[1] = user("k2", "other");
    station.onAgentEvent({
      type: "message_end",
      message: { id: "L1", role: "assistant", content: [{ type: "text", text: "live" }] },
    });

    expect(station.snapshot(4).messages.map((message) => message.id)).toEqual([
      "k1",
      "k2",
      "L1",
    ]);
  });
});

describe("a branch that only grew", () => {
  test("keeps its index, so an append stays flat in cost", () => {
    const entries = [user("a1", "one")];
    const index = buildHistoryIndex(entries);
    entries.push(user("a2", "two"));

    const grown = extendHistoryIndex(index, entries);
    expect(grown).not.toBe(index);
    // The anchor moved forward; the entries before it are untouched.
    expect(grown.tailRef).toBe(entries[1]);
    expect(grown.entryCount).toBe(2);

    // An unchanged array answers with the very same index.
    expect(extendHistoryIndex(grown, entries)).toBe(grown);
  });

  test("a frame after an append shows the new tail and its page resolves", () => {
    const entries = Array.from({ length: 400 }, (_, i) => user(`u${i}`, `t${i}`));
    const station = stationOver(entries);

    entries.push(assistant("n1", "new"));
    expect(station.snapshot(2).messages.map((message) => message.id)).toEqual(["u399", "n1"]);

    const page = station.historyPage({ before: "n1", limit: 2 });
    expect(page.ok).toBe(true);
    expect(page.messages.map((message) => message.id)).toEqual(["u398", "u399"]);
  });
});

// An edit in the middle of a branch whose last entry still matches cannot be
// told apart from the branch that was indexed, at any cost below reading the
// whole branch every frame. So it must not be detected here — it must arrive as
// what it is: a switch, which is the host saying "this conversation is now that
// one". These cases pin that the switch is enough, so the heuristic never has to
// pretend it is a guarantee.
describe("a branch replaced through an explicit switch", () => {
  test("adopts the new conversation even when only its middle moved", () => {
    const first = [user("u1", "one"), user("u2", "two"), user("u3", "three")];
    const station = stationOver(first);

    // Same length, same tail, different middle: indistinguishable from the
    // indexed branch by length and tail alone.
    const branch = [user("k1", "x"), user("k2", "y"), first[2]];
    station.onSessionSwitch({ sessionManager: { getBranch: () => branch } });

    const page = station.historyPage({ before: "u3", limit: 2 });
    expect(page.ok).toBe(true);
    // The page is turn-aligned, and this fixture has no attribution, so the
    // alignment walks to the start of that run. What the switch must guarantee
    // is which conversation the page belongs to: the new one, never the old.
    const shown = page.messages.map((message) => message.id);
    expect(shown).toContain("k1");
    expect(shown).toContain("k2");
    expect(shown).not.toContain("u1");
    expect(shown).not.toContain("u2");

    // A page that ends at the first message of the new branch is empty, not an
    // error: `k1` exists, it is simply the head. The ids the switch took away
    // are the ones that must read as stale.
    const head = station.historyPage({ before: "k1", limit: 2 });
    expect(head.ok).toBe(true);
    expect(head.messages).toEqual([]);
    expect(station.historyPage({ before: "u1", limit: 2 })).toEqual({
      ok: false,
      code: "stale_cursor",
    });
  });

  test("a frame after the switch shows the new branch, not the old window", () => {
    const first = [user("u1", "one"), user("u2", "two")];
    const station = stationOver(first);

    const branch = [user("k1", "x"), user("k2", "y")];
    station.onSessionSwitch({ sessionManager: { getBranch: () => branch } });

    expect(station.snapshot(4).messages.map((message) => message.id)).toEqual(["k1", "k2"]);
  });

  test("a live message after the switch still lands at the tail", () => {
    const first = [user("u1", "one")];
    const station = stationOver(first);

    station.onSessionSwitch({ sessionManager: { getBranch: () => [user("k1", "x")] } });
    station.onAgentEvent({
      type: "message_end",
      message: { id: "L1", role: "assistant", content: [{ type: "text", text: "live" }] },
    });

    expect(station.snapshot(4).messages.map((message) => message.id)).toEqual(["k1", "L1"]);
  });
});
