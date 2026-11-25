import { describe, expect, test } from "bun:test";

import { createUiBridgeStation } from "../../host-omp-ui/src/station/ui-bridge-station.mjs";

// Three ways a lazily-held transcript could answer "no such message" for a
// message that plainly exists. Each one used to make paging fail against a live
// session, and none of them is visible in a fixture where the branch is complete
// and nothing streams.

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

function stationWith(entries) {
  const station = createUiBridgeStation({ capabilities: { dispatch() {} } });
  station.onSessionHydrate({ id: "s1", cwd: "/tmp" }, entries);
  return station;
}

const live = (station, id, text) =>
  station.onAgentEvent({
    type: "message_end",
    message: { id, role: "assistant", content: [{ type: "text", text }] },
  });

const ids = (messages) => messages.map((message) => message.id);

describe("a cursor for a message the branch has not written yet", () => {
  test("pages instead of reporting it stale", () => {
    const station = stationWith([user("u1", "one"), user("u2", "two")]);
    // A live message exists only in the held window: the host has not appended
    // its entry. `findIndex` over the transcript used to answer it.
    live(station, "live1", "streamed");

    const page = station.historyPage({ before: "live1", limit: 5 });
    expect(page.ok).toBe(true);
    // The page ends before the cursor, as paging always has.
    expect(page.messages.map((message) => message.id)).toEqual(["u1", "u2"]);
    expect(page.history.hasMore).toBe(false);
  });

  test("still reports a cursor that exists nowhere", () => {
    const station = stationWith([user("u1", "one")]);
    live(station, "live1", "streamed");

    expect(station.historyPage({ before: "ghost", limit: 5 })).toEqual({
      ok: false,
      code: "stale_cursor",
    });
  });
});

describe("a branch the host grows in place", () => {
  test("sees the entries appended after hydration", () => {
    const entries = [user("u1", "one"), user("u2", "two")];
    const station = stationWith(entries);

    // The host owns this array and appends to that same array, so the index built
    // during hydration describes a shorter branch than the one that exists now.
    entries.push(user("u3", "three"), assistant("a1", "reply"));

    const page = station.historyPage({ before: "a1", limit: 5 });
    expect(page.ok).toBe(true);
    // Paging aligns back to the start of a turn, so the whole turn containing the
    // new entries travels with them — the point is that `u3` is reachable at all.
    expect(page.messages.map((message) => message.id)).toEqual(["u1", "u2", "u3"]);

    // And the frame sees the new tail rather than the stale count.
    expect(ids(station.snapshot(4).messages)).toEqual(["u1", "u2", "u3", "a1"]);
  });
});

describe("an id whose first entry shows nothing", () => {
  test("resolves to the entry that does show", () => {
    const station = stationWith([
      // An entry with this id and no message payload: it takes an entry position
      // and no message. Keeping it as the id's owner would answer -1, while a
      // whole-transcript `findIndex` answers the second entry.
      { type: "message", id: "shared" },
      user("shared", "the one that shows"),
      user("u2", "after"),
    ]);

    const page = station.historyPage({ before: "shared", limit: 5 });
    expect(page.ok).toBe(true);
    expect(page.messages).toEqual([]);
    expect(page.history.hasMore).toBe(false);
  });

  test("a page ending after it includes the shown message once", () => {
    const station = stationWith([
      { type: "message", id: "shared" },
      user("shared", "the one that shows"),
      user("u2", "after"),
    ]);

    const page = station.historyPage({ before: "u2", limit: 5 });
    expect(page.ok).toBe(true);
    expect(page.messages.map((message) => message.id)).toEqual(["shared"]);
  });
});
