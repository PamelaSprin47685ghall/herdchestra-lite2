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
  test("keeps the child's words and one call line per tool call, in order", () => {
    const messages = [
      assistant([text("Reading the config.")]),
      assistant([call("c1", "read", { path: "a.txt" })]),
      result("c1", "read", "alpha"),
      assistant([text("The config is flat.")]),
      assistant([call("c2", "edit", { path: "a.txt" })]),
      result("c2", "edit", "ok"),
    ];
    expect(renderChildRecord(messages)).toBe(
      [
        "Reading the config.",
        'read(path="a.txt")',
        "The config is flat.",
        'edit(path="a.txt")',
      ].join("\n"),
    );
  });

  test("carries every argument, in the order the call has", () => {
    const messages = [
      assistant([
        call("r1", "read", { path: "a.txt", offset: 3 }),
        call("e1", "edit", { path: "b.mjs", old: "before", new: "after" }),
        call("b1", "bash", { command: "ls -la", timeout: 0 }),
        call("g1", "grep", { pattern: "needle" }),
      ]),
    ];
    expect(renderChildRecord(messages)).toBe(
      [
        'read(path="a.txt", offset=3)',
        'edit(path="b.mjs", old="before", new="after")',
        'bash(command="ls -la", timeout=0)',
        'grep(pattern="needle")',
      ].join("\n"),
    );
  });

  test("keeps a string that holds a newline on one line", () => {
    const messages = [assistant([call("b1", "bash", { command: "line1\nline2" })])];
    const rendered = renderChildRecord(messages);
    expect(rendered).toBe('bash(command="line1\\nline2")');
    expect(rendered.includes("\n")).toBe(false);
  });

  test("escapes a quote and a backslash", () => {
    const messages = [assistant([call("b1", "bash", { command: 'say "hi" \\ ok' })])];
    expect(renderChildRecord(messages)).toBe('bash(command="say \\"hi\\" \\\\ ok")');
  });

  test("renders a nested value as compact JSON on the same line", () => {
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
    expect(rendered).toBe(
      'scope_fork(forks=[{"fsm":"measure the cache","budget":{"read":2,"bash":1},"time":120,"targets":["cache.mjs"]}])',
    );
    expect(rendered.includes("\n")).toBe(false);
    expect(rendered).not.toContain("You are the parent of fork f9");
  });

  test("never truncates a long argument", () => {
    const long = "x".repeat(5000);
    const rendered = renderChildRecord([assistant([call("b1", "bash", { command: long })])]);
    expect(rendered).toBe(`bash(command="${long}")`);
    expect(rendered).not.toContain("…");
  });

  test("renders a call with no arguments as an empty attribute list", () => {
    const messages = [
      assistant([call("j9", "scope_join", {})]),
      assistant([{ type: "toolCall", id: "w9", name: "wait" }]),
    ];
    expect(renderChildRecord(messages)).toBe("scope_join()\nwait()");
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
    expect(rendered).toBe("read()\nbash()");
    expect(rendered).not.toContain("alpha body");
    expect(rendered).not.toContain("boom");
    expect(rendered).not.toContain("[result");
  });

  test("renders scope_request with its arguments and drops its OK result", () => {
    const messages = [
      assistant([
        text("Fix confirmed."),
        call("r1", "scope_request", { target: "/api", message: "Where does the bug live?" }),
      ]),
      result("r1", "scope_request", "OK"),
    ];
    const rendered = renderChildRecord(messages);
    expect(rendered).toBe(
      'Fix confirmed.\nscope_request(target="/api", message="Where does the bug live?")',
    );
    expect(rendered).not.toContain("[result scope_request]");
  });

  test("renders scope_fork and scope_return with their arguments", () => {
    const messages = [
      assistant([call("f1", "scope_fork", { forks: [{ fsm: "audit" }] })]),
      result("f1", "scope_fork", "OK"),
      assistant([call("s2", "scope_return", { dafny: "done", signed_sealed_hands_off_nothing_left_on_the_table: "x" })]),
      result("s2", "scope_return", "Sealed."),
    ];
    const rendered = renderChildRecord(messages);
    expect(rendered).toBe(
      [
        'scope_fork(forks=[{"fsm":"audit"}])',
        'scope_return(dafny="done", signed_sealed_hands_off_nothing_left_on_the_table="x")',
      ].join("\n"),
    );
    expect(rendered).not.toContain("[result scope_fork]");
    expect(rendered).not.toContain("[result scope_return]");
  });

  test("renders a boolean argument as JSON", () => {
    const messages = [assistant([call("s1", "scope_request", { interrupt: true })])];
    expect(renderChildRecord(messages)).toBe("scope_request(interrupt=true)");
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
      record: 'read(path="a.txt")\nDone.',
    });
    expect(receipt.startsWith('[Record from forked scope — fork f1]\nHistory only; do not re-execute it.\n\nread(path="a.txt")\nDone.')).toBe(true);
    expect(receipt).toContain("[End of record from forked scope — fork f1]\nUnreceived: 0.");
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
    expect(receipt).toContain("[Record from forked scope — fork f1, failed: cost cap]");
    expect(receipt).toContain("do not re-execute it or treat its conclusions as verified");
  });
});
