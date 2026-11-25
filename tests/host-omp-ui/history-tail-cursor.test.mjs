import { describe, expect, test } from "bun:test";

import { createUiBridgeStation } from "../../host-omp-ui/src/station/ui-bridge-station.mjs";

// A session that streams faster than the host writes its entries has messages
// that exist only in the held window: the branch has nothing at those ordinals.
// Paging from such a message is still paging — the reader is asking for the
// transcript just before it — and the branch must answer, because that is where
// nearly all of it lives.
//
// Planning the page inside the window instead answers a shorter page and a
// `hasMore` that describes history it never looked at. That is only visible when
// the live run is long enough to leave fewer held messages before the cursor than
// a page holds, so every case here pushes the run past that point first.

const WINDOW = 512;
const PAGE = 200;

const user = (id, text) => ({
  type: "message",
  id,
  message: { role: "user", content: [{ type: "text", text }] },
});

const live = (station, id) =>
  station.onAgentEvent({
    type: "message_end",
    message: { id, role: "assistant", content: [{ type: "text", text: "streamed" }] },
  });

const ids = (messages) => messages.map((message) => message.id);

/** A branch of `count` messages plus `streamed` live messages at the tail. */
function stationWith(count, streamed) {
  const entries = Array.from({ length: count }, (_, index) => user(`u${index}`, `t${index}`));
  const station = createUiBridgeStation({ capabilities: { dispatch() {} } });
  station.onSessionHydrate({ id: "s1", cwd: "/tmp" }, entries);
  for (let index = 0; index < streamed; index += 1) live(station, `L${index}`);
  return station;
}

describe("a page from the start of a live run", () => {
  test("is as large as any other page, and comes from the branch", () => {
    const station = stationWith(2000, 450);

    const page = station.historyPage({ before: "L0", limit: PAGE });

    expect(page.ok).toBe(true);
    expect(page.messages).toHaveLength(PAGE);
    // The page ends immediately before the cursor and reaches back into the
    // branch, which is where those messages are.
    expect(ids(page.messages).at(-1)).toBe("u1999");
    expect(page.messages.at(-1).role).toBe("user");
    expect(page.history.hasMore).toBe(true);
  });

  test("walks back through the live run and then into the branch", () => {
    const station = stationWith(2000, 450);

    const first = station.historyPage({ before: "L0", limit: PAGE });
    const next = station.historyPage({ before: "u1800", limit: PAGE });

    // Consecutive pages do not overlap and do not leave a gap.
    expect(ids(first.messages).at(-1)).toBe("u1999");
    expect(ids(next.messages).at(-1)).toBe("u1799");
    expect(ids(first.messages)[0]).toBe("u1800");
    expect(ids(next.messages)[0]).toBe("u1600");
    expect(first.history.hasMore).toBe(true);
  });

  test("a cursor in the middle of the run pages the messages before it", () => {
    const station = stationWith(2000, 450);

    const page = station.historyPage({ before: "L300", limit: PAGE });

    expect(page.ok).toBe(true);
    expect(page.messages).toHaveLength(PAGE);
    // A full page sits entirely inside the live run: three hundred messages
    // streamed, and the two hundred before the cursor are the tail of that run.
    expect(ids(page.messages)[0]).toBe("L100");
    expect(ids(page.messages).at(-1)).toBe("L299");
  });
});

describe("the end of the transcript", () => {
  test("a page at the very first message is short and says so", () => {
    const station = stationWith(2000, 450);

    const page = station.historyPage({ before: "u5", limit: PAGE });

    expect(page.ok).toBe(true);
    expect(page.messages).toHaveLength(5);
    expect(ids(page.messages)).toEqual(["u0", "u1", "u2", "u3", "u4"]);
    // Nothing precedes it, and `hasMore` must say exactly that.
    expect(page.history.hasMore).toBe(false);
  });

  test("the first page of the branch is full once there is enough behind it", () => {
    const station = stationWith(2000, 450);

    const page = station.historyPage({ before: "u199", limit: PAGE });

    expect(page.messages).toHaveLength(199);
    expect(page.history.hasMore).toBe(false);
  });
});

describe("what must not change", () => {
  test("an id that exists nowhere is still stale", () => {
    const station = stationWith(2000, 450);
    expect(station.historyPage({ before: "ghost", limit: 10 })).toEqual({
      ok: false,
      code: "stale_cursor",
    });
  });

  test("a live message that names no distinct id does not become a page", () => {
    const station = stationWith(50, 0);
    // The branch's own head: a page before it is empty, not stale.
    const page = station.historyPage({ before: "u0", limit: 10 });
    expect(page.ok).toBe(true);
    expect(page.messages).toEqual([]);
    expect(page.history.hasMore).toBe(false);
  });

  test("a page inside the branch is unaffected by the live run", () => {
    const station = stationWith(2000, 450);
    const page = station.historyPage({ before: "u1990", limit: PAGE });

    expect(page.ok).toBe(true);
    expect(page.messages).toHaveLength(PAGE);
    expect(ids(page.messages).every((id) => id.startsWith("u"))).toBe(true);
    expect(ids(page.messages).at(-1)).toBe("u1989");
  });
});
