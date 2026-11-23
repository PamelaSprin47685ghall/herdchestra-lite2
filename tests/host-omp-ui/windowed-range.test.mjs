import { describe, expect, test } from "bun:test";
import {
  finishRestore,
  prependWindow,
  reachBottom,
  sliceWindow,
  startRestore,
  tailWindow,
  userScrollUp,
} from "../../host-omp-ui/web/src/lib/windowed-range.ts";

describe("windowed range", () => {
  test("closed windows render nothing but keep total position", () => {
    expect(tailWindow(700, { open: false })).toEqual({ start: 700, count: 0 });
  });

  test("running windows keep only the newest tail", () => {
    expect(tailWindow(700, { running: true, runningTail: 12 })).toEqual({
      start: 688,
      count: 12,
    });
  });

  test("finished open windows keep the visible tail", () => {
    expect(tailWindow(700, { visible: 30 })).toEqual({ start: 670, count: 30 });
  });

  test("prepend grows toward the head without exceeding total", () => {
    expect(prependWindow(700, 30, 30)).toEqual({ start: 640, count: 60 });
    expect(prependWindow(40, 30, 30)).toEqual({ start: 0, count: 40 });
  });

  test("slice only the window", () => {
    const items = Array.from({ length: 10 }, (_, index) => index);
    expect(sliceWindow(items, { start: 7, count: 3 })).toEqual([7, 8, 9]);
  });
});

describe("scroll intent", () => {
  test("user scrolling up pauses following", () => {
    expect(userScrollUp("following")).toBe("paused");
    expect(userScrollUp("restoring")).toBe("paused");
  });

  test("reaching the bottom resumes following", () => {
    expect(reachBottom("paused")).toBe("following");
    expect(reachBottom("restoring")).toBe("following");
  });

  test("restore is a distinct intent that returns to the previous one", () => {
    const previous = startRestore("following");
    expect(previous).toBe("restoring");
    expect(finishRestore("following")).toBe("following");
    expect(finishRestore("paused")).toBe("paused");
  });
});
