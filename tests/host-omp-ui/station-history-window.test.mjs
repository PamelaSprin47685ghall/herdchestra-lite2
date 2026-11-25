import { describe, expect, test } from "bun:test";

import { createUiBridgeStation } from "../../host-omp-ui/src/station/ui-bridge-station.mjs";

// The station holds the host's branch by reference and keeps only a window of
// displayed messages. Three things can go wrong when a live turn outruns that
// window, and each one loses or repeats conversation in a way a reader sees:
//
// 1. Trimming the window away from ordinals the branch does not cover. Those
//    messages exist only in the window, so dropping them loses them for good.
// 2. Stitching a frame across the branch and the window along a boundary that
//    is not where one of them ends, which repeats or skips messages.
// 3. Answering a bad limit with `stale_cursor`, which sends a client to refetch
//    a page it never validly asked for.

const WINDOW = 512;

const entry = (id, text) => ({
  type: "message",
  id,
  message: { role: "user", content: [{ type: "text", text }] },
});

const assistantEntry = (id, text) => ({
  type: "message",
  id,
  message: { role: "assistant", content: [{ type: "text", text }] },
});

function stationWith(count) {
  const station = createUiBridgeStation({ capabilities: { dispatch() {} } });
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    entries.push(entry(`e${index}`, `text ${index}`));
  }
  station.onSessionHydrate({ id: "s1", cwd: "/tmp" }, entries);
  return station;
}

/** Append a live message the way an agent event does. */
function live(station, id, text) {
  station.onAgentEvent({
    type: "message_end",
    message: { id, role: "assistant", content: [{ type: "text", text }] },
  });
}

const ids = (messages) => messages.map((message) => message.id);

describe("a live tail larger than the held window", () => {
  test("does not drop a message the branch never wrote", () => {
    const station = stationWith(20);
    // Push well past the window so trimming has to run more than once.
    for (let index = 0; index < WINDOW + 120; index += 1) {
      live(station, `live${index}`, `live ${index}`);
    }

    // A frame this large reaches the whole transcript, including the ordinals
    // the window had to drop. Trimming those away leaves a hole here.
    const frame = station.snapshot(600);
    const shown = ids(frame.messages);
    // The newest live message must be the last one a reader sees.
    expect(shown.at(-1)).toBe(`live${WINDOW + 119}`);
    // Every shown id is unique: a repeat would mean the stitch overlapped.
    expect(new Set(shown).size).toBe(shown.length);
    // The frame reaches back into the streamed run, not just the branch.
    expect(shown.some((id) => id?.startsWith("live"))).toBe(true);
    // And the run is unbroken. Dropping a live message the branch never wrote
    // leaves a hole here, which is the whole failure being guarded.
    const run = shown
      .filter((id) => id?.startsWith("live"))
      .map((id) => Number(id.slice("live".length)));
    // The frame is as large as it was asked for. A trim that dropped live
    // messages the branch never wrote cannot fill it, and the hole shows up
    // here as a short frame.
    expect(shown).toHaveLength(600);
    for (let index = 1; index < run.length; index += 1) {
      expect(run[index]).toBe(run[index - 1] + 1);
    }
  });

  test("keeps the whole live run readable after the window trims", () => {
    const station = stationWith(600);
    for (let index = 0; index < WINDOW + 60; index += 1) {
      live(station, `live${index}`, `live ${index}`);
    }

    // Walk the live run through frames of decreasing size. Each frame is a
    // window over the same transcript, so the union of ids must stay ordered
    // and duplicate-free.
    const seen = [];
    for (const limit of [80, 200, 480, 600]) {
      const shown = ids(station.snapshot(limit).messages);
      expect(new Set(shown).size).toBe(shown.length);
      seen.push(shown);
    }
    // The largest frame contains the trailing messages of the run.
    expect(seen.at(-1).at(-1)).toBe(`live${WINDOW + 59}`);
  });
});

describe("a frame stitched across branch and window", () => {
  test("shows every message exactly once in order", () => {
    const station = stationWith(40);
    for (let index = 0; index < WINDOW + 30; index += 1) {
      live(station, `live${index}`, `live ${index}`);
    }

    // A large frame reaches past the window's head into the branch, which is
    // exactly where a wrong boundary repeats or skips messages.
    const shown = ids(station.snapshot(600).messages);

    expect(new Set(shown).size).toBe(shown.length);
    // Order is preserved: every live id comes after every branch id.
    const firstLive = shown.findIndex((id) => id?.startsWith("live"));
    expect(firstLive).toBeGreaterThan(0);
    expect(shown.slice(firstLive).every((id) => id.startsWith("live"))).toBe(true);
    // The last live message is still the newest one.
    expect(shown.at(-1)).toBe(`live${WINDOW + 29}`);
  });

  test("a page inside the branch is unaffected by the live run", () => {
    const station = stationWith(1000);
    for (let index = 0; index < WINDOW + 50; index += 1) {
      live(station, `live${index}`, `live ${index}`);
    }

    const page = station.historyPage({ before: "e500", limit: 10 });
    expect(page.ok).toBe(true);
    expect(ids(page.messages).every((id) => id.startsWith("e"))).toBe(true);
    expect(page.history.hasMore).toBe(true);
  });
});

describe("the page limit and the cursor", () => {
  test("an invalid limit is reported before a missing cursor", () => {
    const station = stationWith(30);

    // Both are wrong; the limit is the one that describes the request.
    expect(station.historyPage({ before: "nope", limit: 0 })).toEqual({
      ok: false,
      code: "invalid_limit",
    });
    expect(station.historyPage({ before: "nope", limit: -5 })).toEqual({
      ok: false,
      code: "invalid_limit",
    });
  });

  test("a valid request with a missing cursor is stale", () => {
    const station = stationWith(30);
    expect(station.historyPage({ before: "nope", limit: 10 })).toEqual({
      ok: false,
      code: "stale_cursor",
    });
  });

  test("an omitted limit pages with the default", () => {
    const station = stationWith(200);
    const page = station.historyPage({ before: "e150" });
    expect(page.ok).toBe(true);
    expect(page.messages.length).toBeGreaterThan(0);
    expect(page.messages.length).toBeLessThanOrEqual(200);
    expect(ids(page.messages).at(-1)).toBe("e149");
  });
});

describe("the snapshot", () => {
  test("a limit larger than the transcript returns all of it", () => {
    const station = stationWith(7);
    const frame = station.snapshot(5000);
    expect(frame.messages).toHaveLength(7);
    expect(frame.history.hasMore).toBe(false);
    expect(frame.history.oldestId).toBe("e0");
  });

  test("a non-positive limit falls back to the default frame", () => {
    const station = stationWith(200);
    const frame = station.snapshot(0);
    expect(frame.messages.length).toBeGreaterThan(0);
    expect(frame.messages.length).toBeLessThanOrEqual(200);
  });
});
