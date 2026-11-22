import { describe, expect, test } from "bun:test";

import {
  FOLDED_MARKER,
  applyReceiptFolds,
  foldedScopeText,
} from "../src/transcript/collapse.mjs";
import { createReceiptRecord, foldableReceipts } from "../src/scope/receipts.mjs";
import { joinReceipt, recordChars, renderChildRecord } from "../src/transcript/replay.mjs";

function receipt(forkId, closeId, closedOrder, levelKey = "L0", report = null) {
  return createReceiptRecord({
    forkToolCallId: forkId,
    closeToolCallId: closeId,
    levelKey,
    closedOrder,
    report,
  });
}

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
  test("renders prose, thinking, calls and results in order", () => {
    const messages = [
      assistant([text("Reading the config."), { type: "thinking", thinking: "Pick the flat file." }]),
      assistant([call("c1", "read", { path: "a.txt" })]),
      result("c1", "read", "alpha"),
    ];
    const rendered = renderChildRecord(messages);
    expect(rendered).toBe(
      [
        "Reading the config.",
        "[thinking] Pick the flat file.",
        "[call read] {\"path\":\"a.txt\"}",
        "[result read] alpha",
      ].join("\n"),
    );
    expect(recordChars(rendered)).toBe(rendered.length);
  });

  test("truncates a long result and says how much went away", () => {
    const long = "x".repeat(30);
    const messages = [assistant([call("c1", "bash", {})]), result("c1", "bash", long)];
    const rendered = renderChildRecord(messages, { maxResultChars: 10 });
    expect(rendered).toContain("[result bash] xxxxxxxxxx");
    expect(rendered).toContain("(20 chars omitted)");
  });

  test("keeps a pin note in full and drops its OK result", () => {
    const messages = [
      assistant([
        text("Fix confirmed."),
        call("p1", "pin", { finding: "The bug lives in parse().", conclusion: "Ship it." }),
      ]),
      result("p1", "pin", "OK"),
    ];
    const rendered = renderChildRecord(messages);
    expect(rendered).toContain("[pin] finding: The bug lives in parse(). | conclusion: Ship it.");
    expect(rendered).not.toContain("[result pin]");
  });

  test("renders a nested fork with the identity a grandparent needs", () => {
    const messages = [
      assistant([
        call("f9", "scope_fork", {
          forks: [
            {
              intent: "measure the cache",
              budget: { read: 2, bash: 1 },
              time: 120,
              targets: ["cache.mjs"],
            },
          ],
        }),
      ]),
      result("f9", "scope_fork", "You are the parent of fork f9, remaining at depth 2."),
      assistant([call("j9", "scope_join", { elder_report: null })]),
      result("j9", "scope_join", "OK. Fork f9 joined."),
    ];
    const rendered = renderChildRecord(messages);
    expect(rendered).toContain(
      '[fork f9] intent: "measure the cache" | budget: read 2, bash 1 | time: 120s | targets: cache.mjs',
    );
    expect(rendered).not.toContain("You are the parent of fork f9");
    expect(rendered).toContain("[result scope_join] OK. Fork f9 joined.");
  });

  test("an old fork line without targets omits the segment", () => {
    const messages = [
      assistant([
        call("f9", "scope_fork", {
          forks: [{ intent: "old work", budget: {}, time: 60 }],
        }),
      ]),
    ];
    const rendered = renderChildRecord(messages);
    expect(rendered).toContain('[fork f9] intent: "old work" | budget: none | time: 60s');
    expect(rendered).not.toContain("targets:");
  });

  test("numbers the items of one fork call the way the ledger does", () => {
    const messages = [
      assistant([
        call("f9", "scope_fork", {
          forks: [
            { intent: "one", budget: {}, time: 60, targets: ["one.mjs"] },
            { intent: "two", budget: {}, time: 60, targets: ["two.mjs"], blocked: true },
          ],
        }),
      ]),
    ];
    const [first, second] = renderChildRecord(messages).split("\n");
    expect(first).toStartWith('[fork f9:0] intent: "one"');
    expect(second).toStartWith('[fork f9:1] blocked | intent: "two"');
    expect(second).toContain("targets: two.mjs");
  });

  test("replaces an already folded scope with its summary", () => {
    const messages = [
      assistant([call("j9", "scope_join", {})]),
      result("j9", "scope_join", "OK. Fork f9 joined. Child record folded.\n\nMeasured 42."),
    ];
    const rendered = renderChildRecord(messages, {
      folded: new Map([["j9", "Measured 42."]]),
    });
    expect(rendered).toBe("[result scope_join] folded scope: Measured 42.");
    expect(rendered).not.toContain("xxxxxxxx");
  });

  test("skips calls withdrawn by amend together with their results", () => {
    const messages = [
      assistant([call("dead", "read", { path: "wrong.txt" })]),
      result("dead", "read", "not what we wanted"),
      assistant([text("Second attempt.")]),
    ];
    const rendered = renderChildRecord(messages, {
      skipToolCallIds: new Set(["dead"]),
    });
    expect(rendered).toBe("Second attempt.");
  });

  test("carries user broadcasts and skips ledger entries", () => {
    const messages = [
      user("please also check the cache"),
      { role: "custom", customType: "fission.handoff.begin", data: {}, timestamp: 3 },
      assistant([text("Will do.")]),
    ];
    const rendered = renderChildRecord(messages);
    expect(rendered).toBe("[user] please also check the cache\nWill do.");
  });

  test("marks an empty record instead of returning nothing", () => {
    expect(renderChildRecord([])).toBe("");
    const receipt = joinReceipt({
      forkId: "f1",
      childDepth: 2,
      intent: "probe",
      record: "",
      depth: 1,
    });
    expect(receipt).toContain("(the child produced no messages)");
  });
});

describe("join receipt", () => {
  test("separates child history from the next action", () => {
    const receipt = joinReceipt({
      forkId: "f1",
      record: "[call read] {}",
    });
    expect(receipt.startsWith("[Child record — fork f1]\nHistory only; do not re-execute it.\n\n[call read] {}")).toBe(true);
    expect(receipt).toContain("[End of child record — fork f1]\nUnreceived: 0.");
  });

  test("identifies unreceived results and how to take the next one", () => {
    const receipt = joinReceipt({
      forkId: "f1",
      record: "work",
      remaining: ["f2", "f3"],
    });
    expect(receipt).toContain("Unreceived: 2 (f2, f3).");
    expect(receipt).toContain("Call scope_join again with elder_report: null.");
  });

  test("marks a failed child as unverified evidence", () => {
    const receipt = joinReceipt({
      forkId: "f1",
      childDepth: 2,
      intent: "one",
      record: "partial",
      failed: true,
      reason: "cost cap",
      depth: 1,
    });
    expect(receipt).toContain("[Child record — fork f1, failed: cost cap]");
    expect(receipt).toContain("do not re-execute it or treat its conclusions as verified");
  });
});

describe("receipt projection", () => {
  test("shortens only the elder and keeps every left bracket", () => {
    const left = assistant([
      call("f1", "scope_fork", {
        forks: [{ intent: "outer", budget: {}, time: 60, targets: ["outer.mjs"] }],
      }),
    ]);
    const leftResult = result("f1", "scope_fork", "parent receipt");
    const elder = result(
      "j1",
      "scope_join",
      [
        "OK. Fork f1 joined.",
        "",
        '[fork f9] intent: "measure the cache" | budget: read 2 | time: 120s | targets: cache.mjs',
        "",
        "long child prose. ".repeat(20),
      ].join("\n"),
    );
    const youngest = result("j2", "scope_join", "youngest stays complete");
    const list = [
      receipt("f1", "j1", 1, "L0", "Outer summary."),
      receipt("f2", "j2", 2, "L0", null),
    ];

    const folded = applyReceiptFolds([left, leftResult, elder, youngest], list, {
      foldable: foldableReceipts(list),
    });

    expect(folded.collapsed).toEqual(["j1"]);
    expect(folded.messages[0]).toBe(left);
    expect(folded.messages[1]).toBe(leftResult);
    const text = folded.messages[2].content[0].text;
    expect(text).toContain("Outer summary.");
    expect(text).toContain("Nested forks:");
    expect(text).toContain('[fork f9] intent: "measure the cache"');
    expect(text).not.toContain("long child prose");
    expect(folded.messages[3]).toBe(youngest);
  });

  test("builds the shortened text without a nested-scope section", () => {
    const short = foldedScopeText({ forkId: "f1", report: "Done." }, "- [fork f9] intent: \"inner\"");
    expect(short).toBe(
      "OK. Fork f1 joined. Child record folded.\n\nDone.\n\nNested forks:\n- [fork f9] intent: \"inner\"",
    );
    expect(short).toContain(FOLDED_MARKER);
  });

  test("omits the summary section when the report is empty", () => {
    expect(foldedScopeText({ forkId: "f1", report: "" })).toBe(
      "OK. Fork f1 joined. Child record folded.",
    );
  });
});
