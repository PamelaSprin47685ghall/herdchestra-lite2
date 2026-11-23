import { describe, expect, test } from "bun:test";
import { buildSteps } from "../../host-omp-ui/web/src/lib/build-steps.ts";

const msg = (blocks) => ({ id: "m1", role: "assistant", blocks });

describe("buildSteps", () => {
  test("thinking counts and keeps block order", () => {
    const { steps, body } = buildSteps(msg([
      { type: "thinking", text: "t1" },
      { type: "toolCall", id: "x", toolCallId: "x", name: "read", args: {} },
      { type: "text", text: "mid" },
      { type: "thinking", text: "t2" },
      { type: "text", text: "final" },
    ]));
    expect(steps.map((s) => s.kind)).toEqual(["thinking", "tool", "text", "thinking"]);
    expect(steps[0].text).toBe("t1");
    expect(body).toBe("final");
  });

  test("trailing text is body, earlier text is a step", () => {
    const { steps, body } = buildSteps(msg([
      { type: "text", text: "before" },
      { type: "thinking", text: "t" },
      { type: "text", text: "after" },
    ]));
    expect(steps.map((s) => s.kind)).toEqual(["text", "thinking"]);
    expect(body).toBe("after");
  });

  test("cached steps reflect same-length edits to earlier blocks", () => {
    const message = msg([{ type: "thinking", text: "old" }, { type: "text", text: "answer" }]);
    expect(buildSteps(message).steps[0].text).toBe("old");
    message.blocks[0].text = "new";
    expect(buildSteps(message).steps[0].text).toBe("new");
  });

  test("tool blocks dedupe by id", () => {
    const block = { type: "toolCall", id: "t1", toolCallId: "t1", name: "read", args: {} };
    const { steps } = buildSteps(msg([block, block]));
    expect(steps.filter((s) => s.kind === "tool")).toHaveLength(1);
  });

  test("no text means empty body and no text step", () => {
    const { steps, body } = buildSteps(msg([{ type: "thinking", text: "t" }]));
    expect(steps).toHaveLength(1);
    expect(body).toBe("");
  });
});
