// The rich-tool layer: fields the card reads beyond kind and title.
//
// `output` is stripped because a plain block cannot colour itself; `rawOutput`
// keeps the SGR escapes so a terminal body can. Both come from one walk, and
// these cases pin that they never disagree about the text itself.

import { describe, expect, test } from "bun:test";
import {
  ansiSegments,
  describeTool,
  lineDiff,
  rawResultText,
  resultText,
} from "../../host-omp-ui/web/src/protocol/tool-view";

function execution(
  name: string,
  args: Record<string, unknown>,
  text = "",
  extra: Record<string, unknown> = {},
) {
  return {
    id: `${name}-1`,
    name,
    status: "completed" as const,
    args,
    result: { content: [{ type: "text", text }] },
    ...extra,
  };
}

const RED = "\u001b[31m";
const RESET = "\u001b[0m";

 describe("raw text", () => {
  test("rawResultText keeps SGR while resultText strips it", () => {
    const value = { content: [{ type: "text", text: `${RED}red${RESET} plain` }] };
    expect(resultText(value)).toBe("red plain");
    expect(rawResultText(value)).toBe(`${RED}red${RESET} plain`);
  });
});

describe("terminal bodies", () => {
  test("bash keeps raw ANSI beside the stripped output", () => {
    const view = describeTool(execution("bash", { command: "ls" }, `${RED}one${RESET}`));
    if (view.kind !== "bash") throw new Error(`expected bash, got ${view.kind}`);
    expect(view.output).toBe("one");
    expect(view.rawOutput).toBe(`${RED}one${RESET}`);
  });

  test("js keeps ANSI but still strips the REPL echo", () => {
    const view = describeTool(
      execution("js", { code: "1" }, `> await AsyncFunction(\n${RED}2${RESET}`),
    );
    if (view.kind !== "eval") throw new Error(`expected eval, got ${view.kind}`);
    expect(view.output).toBe("2");
    expect(view.rawOutput).toBe(`${RED}2${RESET}`);
  });
});

describe("ansiSegments", () => {
  test("bright colours name a theme variable, not a literal", () => {
    const segments = ansiSegments("\u001b[91mhot\u001b[0m");
    expect(segments[0].text).toBe("hot");
    expect(segments[0].color?.startsWith("var(--ansi-bright-red")).toBe(true);
  });

  test("truecolor survives as a literal", () => {
    const segments = ansiSegments("\u001b[38;2;254;128;25mx\u001b[39m");
    expect(segments[0].color).toBe("rgb(254, 128, 25)");
  });
});

describe("card metrics", () => {
  test("read carries its line range", () => {
    const view = describeTool(execution("read", { path: "a.mjs", offset: 10, limit: 20 }, "x"));
    if (view.kind !== "read") throw new Error(`expected read, got ${view.kind}`);
    expect(view.range).toBe("10-29");
  });

  test("write counts lines and characters", () => {
    const view = describeTool(execution("write", { path: "a.mjs", content: "one\ntwo\n" }, "ok"));
    if (view.kind !== "write") throw new Error(`expected write, got ${view.kind}`);
    expect(view.lines).toBe(3);
    expect(view.bytes).toBe(8);
  });

  test("write counts UTF-8 bytes for non-ASCII content", () => {
    const view = describeTool(execution("write", { path: "a.txt", content: "你好" }, "ok"));
    if (view.kind !== "write") throw new Error(`expected write, got ${view.kind}`);
    expect(view.bytes).toBe(6);
  });

  test("js exposes its inputs for inspection", () => {
    const view = describeTool(execution("js", { code: "return inputs", inputs: { path: "a.txt" } }));
    if (view.kind !== "eval") throw new Error(`expected eval, got ${view.kind}`);
    expect(view.inputs).toEqual({ path: "a.txt" });
  });

  test("search counts what it kept", () => {
    const view = describeTool(execution("grep", { pattern: "x", path: "src" }, "a:1:x\nb:2:x\n"));
    if (view.kind !== "search") throw new Error(`expected search, got ${view.kind}`);
    expect(view.matchCount).toBe(2);
  });

  test("js counts its inner calls and their failures", () => {
    const view = describeTool(
      execution("js", { code: "x" }, "done", {
        details: {
          innerCalls: [
            { name: "read", args: { path: "a" }, resultText: "ok" },
            { name: "bash", args: { command: "false" }, resultText: "exit 1", isError: true },
          ],
        },
      }),
    );
    if (view.kind !== "eval") throw new Error(`expected eval, got ${view.kind}`);
    expect(view.innerCallCount).toBe(2);
    expect(view.innerErrorCount).toBe(1);
  });

  test("a reported duration reaches the card, an absent one does not invent it", () => {
    const timed = describeTool(execution("bash", { command: "x" }, "ok", { details: { durationMs: 42 } }));
    expect(timed.durationMs).toBe(42);
    const untimed = describeTool(execution("bash", { command: "x" }, "ok"));
    expect(untimed.durationMs).toBeUndefined();
  });
});

describe("lineDiff", () => {
  test("an empty side has no line", () => {
    expect(lineDiff("", "a").removed).toBe(0);
    expect(lineDiff("", "a").added).toBe(1);
  });

  test("a change yields one add and one remove", () => {
    const diff = lineDiff("old", "new");
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.lines.map((line) => line.kind)).toEqual(["remove", "add"]);
  });

  test("a pair too large to align degrades to a full replace", () => {
    const before = Array.from({ length: 2001 }, (_, i) => `a${i}`).join("\n");
    const after = Array.from({ length: 2001 }, (_, i) => `b${i}`).join("\n");
    expect(lineDiff(before, after).truncated).toBe(true);
  });
});
