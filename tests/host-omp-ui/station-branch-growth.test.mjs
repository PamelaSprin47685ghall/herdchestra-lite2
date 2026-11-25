import { describe, expect, test } from "bun:test";

import { createUiBridgeStation } from "../../host-omp-ui/src/station/ui-bridge-station.mjs";

// The station holds the host's branch array by reference and keeps a window of
// displayed messages over it. The two can move independently: the host appends
// to its own array while an agent event appends a live message the host has not
// written yet. Every combination of those two motions must show each message
// once, in order — a repeat or a hole here is a conversation that reads wrong.
//
// The cases below are the interleavings that could break the ordinal arithmetic:
// the host persisting the very message that was streamed, the host persisting an
// extra message first, and both happening across a page request.

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

const live = (station, id, text) =>
  station.onAgentEvent({
    type: "message_end",
    message: { id, role: "assistant", content: [{ type: "text", text }] },
  });

const ids = (messages) => messages.map((message) => message.id);

/** No id twice, and the tail is what was just streamed. */
function expectOnceInOrder(messages) {
  const shown = ids(messages);
  expect(new Set(shown).size).toBe(shown.length);
  return shown;
}

describe("the host persisting a message that was streamed", () => {
  test("shows it once, at the tail", () => {
    const entries = [];
    for (let index = 0; index < 700; index += 1) entries.push(user(`u${index}`, `t${index}`));
    const station = stationOver(entries);

    live(station, "live1", "streamed");
    // The host now writes the entry for the message it just streamed.
    entries.push(assistant("live1", "streamed"));

    const shown = expectOnceInOrder(station.snapshot(600).messages);
    expect(shown.at(-1)).toBe("live1");
    expect(shown.filter((id) => id === "live1")).toHaveLength(1);
  });

  test("keeps the frame's tail correct when the host writes it first", () => {
    const entries = [];
    for (let index = 0; index < 700; index += 1) entries.push(user(`u${index}`, `t${index}`));
    const station = stationOver(entries);

    // The reverse order: the entry is written, then the event arrives.
    entries.push(assistant("live1", "streamed"));
    live(station, "live1", "streamed");

    const shown = expectOnceInOrder(station.snapshot(600).messages);
    expect(shown.at(-1)).toBe("live1");
  });
});

describe("the host persisting an extra message first", () => {
  test("keeps the order the branch establishes", () => {
    const entries = [];
    for (let index = 0; index < 700; index += 1) entries.push(user(`u${index}`, `t${index}`));
    const station = stationOver(entries);

    live(station, "live1", "streamed");
    // The host persisted a message the window never held, before the streamed
    // one. The branch is the source of truth for those ordinals.
    entries.push(user("u-extra", "extra"), assistant("live1", "streamed"));

    const shown = expectOnceInOrder(station.snapshot(600).messages);
    expect(shown.slice(-2)).toEqual(["u-extra", "live1"]);
  });
});

describe("a page request while both move", () => {
  test("pages the branch tail by its own ids", () => {
    const entries = [];
    for (let index = 0; index < 700; index += 1) entries.push(user(`u${index}`, `t${index}`));
    const station = stationOver(entries);

    live(station, "live1", "streamed");
    entries.push(assistant("live1", "streamed"));

    const page = station.historyPage({ before: "u690", limit: 10 });
    expect(page.ok).toBe(true);
    // The page ends before the cursor, and reaches back across the entries the
    // host appended after hydration.
    expect(ids(page.messages).at(-1)).toBe("u689");
    expect(ids(page.messages)).toHaveLength(10);
  });

  test("pages a message only the window holds", () => {
    const entries = [];
    for (let index = 0; index < 700; index += 1) entries.push(user(`u${index}`, `t${index}`));
    const station = stationOver(entries);

    live(station, "live1", "streamed");

    const page = station.historyPage({ before: "live1", limit: 200 });
    expect(page.ok).toBe(true);
    // The page is as large as asked for, and stops before the cursor.
    expect(page.messages).toHaveLength(200);
    expect(ids(page.messages).at(-1)).toBe("u699");
    expect(ids(page.messages)[0]).toBe("u500");
  });
});
