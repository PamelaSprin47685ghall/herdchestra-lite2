import { describe, expect, test } from "bun:test";
import {
  finishRestore,
  intentFromPosition,
  reachBottom,
  restoreIntentForLoad,
  userScrollUp,
} from "../../host-omp-ui/web/src/lib/windowed-range";

describe("intentFromPosition", () => {
  test("far from the bottom pauses following", () => {
    expect(intentFromPosition("following", 500)).toBe("paused");
  });

  test("reaching the bottom follows again", () => {
    expect(intentFromPosition("paused", 0)).toBe("following");
    expect(intentFromPosition("following", 4)).toBe("following");
  });

  test("the band between thresholds keeps the current intent", () => {
    expect(intentFromPosition("paused", 60)).toBe("paused");
    expect(intentFromPosition("following", 60)).toBe("following");
  });

  test("restoring is not overridden by scroll position", () => {
    expect(intentFromPosition("restoring", 500)).toBe("restoring");
    expect(intentFromPosition("restoring", 0)).toBe("restoring");
  });
});

describe("dragging to the top and loading earlier history", () => {
  test("a drag that starts while following pauses the intent", () => {
    const afterDrag = intentFromPosition("following", 400);
    expect(afterDrag).toBe("paused");
  });

  test("a load that starts while following restores to paused", () => {
    expect(restoreIntentForLoad("following")).toBe("paused");
  });

  test("paused and restoring are preserved", () => {
    expect(restoreIntentForLoad("paused")).toBe("paused");
    expect(restoreIntentForLoad("restoring")).toBe("restoring");
  });

  test("after the load the viewport stays off the bottom", () => {
    const afterDrag = intentFromPosition("following", 400);
    const restore = restoreIntentForLoad(afterDrag);
    expect(restore).toBe("paused");
    expect(finishRestore(restore)).toBe("paused");
  });
});

describe("scroll to bottom still follows", () => {
  test("the button transitions paused back to following", () => {
    expect(reachBottom("paused")).toBe("following");
  });

  test("wheel up pauses again", () => {
    expect(userScrollUp("following")).toBe("paused");
  });
});
