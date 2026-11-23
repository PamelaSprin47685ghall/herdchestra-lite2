import { describe, expect, test } from "bun:test";

import { joinReceipt, recordChars, renderChildRecord } from "../src/transcript/replay.mjs";

function assistant(blocks) {
  return { role: "assistant", content: blocks, timestamp: 1 };
}

function text(value) {
  return { type: "text", text: value };
}

function call(id, name, args) {
  return { type: "toolCall", id, name, arguments: args };
}

function result(id, name, value, isError = false) {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text: value }],
    isError,
    timestamp: 2,
  };
}

function user(value) {
  return { role: "user", content: [{ type: "text", text: value }], timestamp: 0 };
}

describe("child record rendering", () => {
  test("keeps the child's words and tool names, in order", () => {
    const messages = [
      assistant([text("Reading the config.")]),
      assistant([call("c1", "read", { path: "a.txt" })]),
      result("c1", "read", "alpha"),
      assistant([text("The config is flat.")]),
      assistant([call("c2", "edit", { path: "a.txt" })]),
      result("c2", "edit", "ok"),
    ];
    expect(renderChildRecord(messages)).toBe(
      ["Reading the config.", "[read]", "The config is flat.", "[edit]"].join("\n"),
    );
  });

  test("renders every tool call as a bare name and no argument", () => {
    const messages = [
      assistant([
        call("r1", "read", { path: "secret-path.txt" }),
        call("e1", "edit", { path: "secret-edit.mjs", old: "before", new: "after" }),
        call("b1", "bash", { command: "cat secret-command.txt" }),
        call("g1", "grep", { pattern: "secret-pattern" }),
      ]),
    ];
    const rendered = renderChildRecord(messages);
    expect(rendered).toBe(["[read]", "[edit]", "[bash]", "[grep]"].join("\n"));
    expect(rendered).not.toContain("secret");
    expect(rendered).not.toContain("{");
  });

  test("drops thinking blocks", () => {
    const messages = [
      assistant([
        text("Visible."),
        { type: "thinking", thinking: "Private reasoning." },
      ]),
    ];
    const rendered = renderChildRecord(messages);
    expect(rendered).toBe("Visible.");
    expect(rendered).not.toContain("Private reasoning");
  });

  test("drops tool results, including their bodies and errors", () => {
    const messages = [
      assistant([call("c1", "read", {})]),
      result("c1", "read", "alpha body"),
      assistant([call("c2", "bash", {})]),
      result("c2", "bash", "boom", true),
    ];
    const rendered = renderChildRecord(messages);
    expect(rendered).toBe("[read]\n[bash]");
    expect(rendered).not.toContain("alpha body");
    expect(rendered).not.toContain("boom");
    expect(rendered).not.toContain("[result");
  });

  test("renders pin as a bare name and drops its OK result", () => {
    const messages = [
      assistant([
        text("Fix confirmed."),
        call("p1", "pin", { finding: "The bug lives in parse().", conclusion: "Ship it." }),
      ]),
      result("p1", "pin", "OK"),
    ];
    const rendered = renderChildRecord(messages);
    expect(rendered).toBe("Fix confirmed.\n[pin]");
    expect(rendered).not.toContain("The bug lives in parse()");
    expect(rendered).not.toContain("Ship it.");
    expect(rendered).not.toContain("[result pin]");
  });

  test("renders scope_context as a bare name", () => {
    const messages = [
      assistant([call("s1", "scope_context", { pin: { finding: "The bug lives in parse()." } })]),
      result("s1", "scope_context", "OK"),
      assistant([call("s2", "scope_context", { amend: { reflection: "drop the search" } })]),
      result("s2", "scope_context", "Amended."),
    ];
    const rendered = renderChildRecord(messages);
    expect(rendered).toBe("[scope_context]\n[scope_context]");
    expect(rendered).not.toContain("The bug lives in parse()");
    expect(rendered).not.toContain("drop the search");
    expect(rendered).not.toContain("[result scope_context]");
  });

  test("renders a scope_context without a note as a bare name", () => {
    const messages = [assistant([call("s1", "scope_context", { whatever: true })])];
    expect(renderChildRecord(messages)).toBe("[scope_context]");
  });

  test("renders a nested fork as a bare name", () => {
    const messages = [
      assistant([
        call("f9", "scope_fork", {
          forks: [
            {
              fsm: "measure the cache",
              budget: { read: 2, bash: 1 },
              time: 120,
              targets: ["cache.mjs"],
            },
          ],
        }),
      ]),
      result("f9", "scope_fork", "You are the parent of fork f9, remaining at depth 2."),
    ];
    const rendered = renderChildRecord(messages);
    expect(rendered).toBe("[scope_fork]");
    expect(rendered).not.toContain("measure the cache");
    expect(rendered).not.toContain("cache.mjs");
    expect(rendered).not.toContain("You are the parent of fork f9");
  });

  test("keeps join and return as bare names", () => {
    const messages = [
      assistant([call("j9", "scope_join", {})]),
      result("j9", "scope_join", "OK. Fork f9 joined."),
      assistant([call("r9", "scope_return", {})]),
    ];
    expect(renderChildRecord(messages)).toBe("[scope_join]\n[scope_return]");
  });

  test("skips user broadcasts and custom entries", () => {
    const messages = [
      user("please also check the cache"),
      { role: "custom", customType: "fission.handoff.begin", data: {}, timestamp: 3 },
      assistant([text("Will do.")]),
    ];
    const rendered = renderChildRecord(messages);
    expect(rendered).toBe("Will do.");
    expect(rendered).not.toContain("please also check the cache");
  });

  test("keeps the selected message range", () => {
    const messages = [
      user("parent prompt", 100),
      assistant([text("parent reply")]),
      assistant([text("child did it")]),
    ];
    expect(renderChildRecord(messages, { start: 2 })).toBe("child did it");
  });

  test("returns an empty string when the child said nothing", () => {
    expect(renderChildRecord([])).toBe("");
    expect(renderChildRecord([assistant([{ type: "thinking", thinking: "silent" }])])).toBe("");
  });

  test("counts the characters of the final record", () => {
    const rendered = renderChildRecord([assistant([text("abc")])]);
    expect(recordChars(rendered)).toBe(3);
    expect(recordChars(null)).toBe(0);
  });
});

describe("join receipt", () => {
  test("separates child history from the next action", () => {
    const receipt = joinReceipt({
      forkId: "f1",
      record: "[read]\nDone.",
    });
    expect(receipt.startsWith("[Child record — fork f1]\nHistory only; do not re-execute it.\n\n[read]\nDone.")).toBe(true);
    expect(receipt).toContain("[End of child record — fork f1]\nUnreceived: 0.");
  });

  test("names an empty record instead of leaving a blank page", () => {
    const receipt = joinReceipt({ forkId: "f1", record: "" });
    expect(receipt).toContain("(no output)");
  });

  test("counts unreceived records without asking for a report", () => {
    const receipt = joinReceipt({
      forkId: "f1",
      record: "work",
      remaining: ["f2", "f3"],
    });
    expect(receipt).toContain("Unreceived: 2 (f2, f3).");
    expect(receipt).toContain("Call scope_join again to take the next one.");
    expect(receipt).not.toContain("elder_report");
  });

  test("marks a failed child as unverified evidence", () => {
    const receipt = joinReceipt({
      forkId: "f1",
      record: "partial",
      failed: true,
      reason: "cost cap",
    });
    expect(receipt).toContain("[Child record — fork f1, failed: cost cap]");
    expect(receipt).toContain("do not re-execute it or treat its conclusions as verified");
  });
});
