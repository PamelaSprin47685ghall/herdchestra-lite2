import { describe, expect, test } from "bun:test";

import { fitSnapshot } from "../../host-omp-ui/src/station/domain/snapshot-fit.mjs";

// `fitSnapshot` sizes the frame as the three trimmable sections plus everything
// else on the document. The "everything else" part used to be a subtraction
// from a second measurement of the whole document. It is now summed directly,
// which is the same number only while every top-level property is counted.
// A property that fell out of that sum would make the frame look smaller than
// it is, and the oversized-frame shrink would never run.

const MAX_FRAME = 8 * 1024 * 1024;

function docWith(surfaceText) {
  return {
    seq: 1,
    messages: [{ id: "m1", role: "user", text: "hello" }],
    toolExecutions: {},
    artifacts: [],
    surface: { lines: [surfaceText] },
    history: { hasMore: false },
  };
}

describe("the rest of the document", () => {
  test("a large property outside the trimmable sections still forces the shrink", () => {
    const surfaceText = "s".repeat(MAX_FRAME + 1024);
    const doc = fitSnapshot(docWith(surfaceText));

    // The surface is capped only when the frame is known to be too big, so the
    // cap is the observable proof that the rest was counted.
    const line = doc.surface.lines[0];
    expect(line.length).toBeLessThan(surfaceText.length);
    expect(line.endsWith("… [truncated]")).toBe(true);
    expect(doc.history.hasMore).toBe(false);
  });

  test("a frame that fits is left alone", () => {
    const doc = fitSnapshot(docWith("small"));

    expect(doc.surface.lines[0]).toBe("small");
    expect(doc.messages).toHaveLength(1);
    expect(doc.history.hasMore).toBe(false);
    expect(doc.history.oldestId).toBe("m1");
  });

  test("an oversized surface is reported as more history, not as a full frame", () => {
    const doc = fitSnapshot({
      ...docWith("x".repeat(MAX_FRAME + 1024)),
      history: { hasMore: true },
    });
    // `hasMore` was already true, and the shrink must not clear it.
    expect(doc.history.hasMore).toBe(true);
  });
});
