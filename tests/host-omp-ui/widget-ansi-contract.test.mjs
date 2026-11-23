import { describe, expect, test } from "bun:test";
import { stripAnsi } from "../../host-omp-ui/web/src/protocol/tool-view.ts";

describe("widget ANSI cleanup", () => {
  test("strips CSI truecolor and reset sequences from a widget line", () => {
    const line =
      "[herd] \x1b[38;2;254;128;25mworking\x1b[39m \x1b[38;2;124;111;188m44%\x1b[39m";
    expect(stripAnsi(line)).toBe("[herd] working 44%");
  });

  test("strips OSC sequences and keeps readable text", () => {
    const line = "\x1b]8;;https://example.com\x07link\x1b]8;;\x07 ready";
    expect(stripAnsi(line)).toBe("link ready");
  });
});
