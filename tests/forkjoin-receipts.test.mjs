// Right-bracket receipts: what may be shortened, and what must survive.

import { describe, expect, test } from "bun:test";

import {
  addReceipt,
  attachReport,
  copyReceipt,
  createReceiptRecord,
  foldableReceipts,
  latestReceiptOf,
  markCollapsed,
  validReceipts,
} from "../src/scope/receipts.mjs";
import { applyReceiptFolds } from "../src/transcript/collapse.mjs";
import { serializeState, deserializeState } from "../src/scope/persistence.mjs";
import { createState } from "../src/scope/state.mjs";
import { SessionStation } from "../src/station/station.mjs";

function receipt(forkId, closeId, closedOrder, levelKey = "L0", report = null) {
  return createReceiptRecord({
    forkToolCallId: forkId,
    closeToolCallId: closeId,
    levelKey,
    closedOrder,
    report,
  });
}

describe("receipt records", () => {
  test("rejects a record without both brackets", () => {
    expect(createReceiptRecord({ forkToolCallId: "f", closeToolCallId: "" })).toBeNull();
    expect(createReceiptRecord({ closeToolCallId: "j" })).toBeNull();
  });

  test("the same right bracket replaces its record", () => {
    const first = addReceipt([], receipt("f1", "j1", 1));
    const again = addReceipt(first, receipt("f1", "j1", 1));
    expect(again).toHaveLength(1);
  });

  test("a report attaches to the named receipt only", () => {
    const list = addReceipt(addReceipt([], receipt("f1", "j1", 1)), receipt("f2", "j2", 2));
    const withReport = attachReport(list, "j1", "found the parser path");
    expect(withReport[0].report).toBe("found the parser path");
    expect(withReport[1].report).toBeNull();
    expect(attachReport(list, "j1", "  ")).toBe(list);
  });
});

describe("what may be shortened", () => {
  test("only an elder with a report is foldable", () => {
    let list = addReceipt([], receipt("f1", "j1", 1));
    list = addReceipt(list, receipt("f2", "j2", 2));
    expect(foldableReceipts(list)).toEqual([]);
    list = attachReport(list, "j1", "elder summary");
    expect(foldableReceipts(list).map((entry) => entry.closeToolCallId)).toEqual(["j1"]);
    // The youngest receipt stays complete even when it has a report.
    list = attachReport(list, "j2", "youngest summary");
    expect(latestReceiptOf(list, "L0").closeToolCallId).toBe("j2");
    expect(foldableReceipts(list).map((entry) => entry.closeToolCallId)).toEqual(["j1"]);
  });

  test("levels fold independently", () => {
    let list = addReceipt([], receipt("a1", "ja1", 1, "A"));
    list = addReceipt(list, receipt("a2", "ja2", 2, "A"));
    list = addReceipt(list, receipt("b1", "jb1", 1, "B"));
    list = attachReport(list, "ja1", "a elder");
    list = attachReport(list, "jb1", "b only");
    // Level B has one receipt, so its report cannot replace anything.
    expect(foldableReceipts(list).map((entry) => entry.closeToolCallId)).toEqual(["ja1"]);
  });

  test("a collapsed receipt stays eligible for the next projection", () => {
    let list = addReceipt([], receipt("f1", "j1", 1));
    list = addReceipt(list, receipt("f2", "j2", 2));
    list = attachReport(list, "j1", "elder");
    list = markCollapsed(list, "j1");
    // Each request projects from the stored branch, so the shortening must
    // run again; the replacement itself is idempotent.
    expect(foldableReceipts(list).map((entry) => entry.closeToolCallId)).toEqual(["j1"]);
  });
});

describe("projection keeps structure", () => {
  const left = {
    role: "assistant",
    content: [{ type: "toolCall", id: "f1", name: "scope_fork", arguments: { forks: [] } }],
  };
  const leftResult = {
    role: "toolResult",
    toolCallId: "f1",
    toolName: "scope_fork",
    content: [{ type: "text", text: "child f1 started" }],
  };
  const right = {
    role: "assistant",
    content: [{ type: "toolCall", id: "j1", name: "scope_join", arguments: { elder_report: null } }],
  };
  const rightResult = {
    role: "toolResult",
    toolCallId: "j1",
    toolName: "scope_join",
    content: [{ type: "text", text: "full child record for f1. ".repeat(20) }],
  };
  const pinned = {
    role: "assistant",
    content: [{ type: "toolCall", id: "p1", name: "pin", arguments: { finding: "keep me" } }],
  };

  test("replaces only the right bracket text", () => {
    let list = addReceipt([], receipt("f1", "j1", 1));
    list = addReceipt(list, receipt("f2", "j2", 2));
    list = attachReport(list, "j1", "found the parser path");
    const messages = [left, leftResult, pinned, right, rightResult];
    const folded = applyReceiptFolds(messages, list, { foldable: foldableReceipts(list) });
    expect(folded.collapsed).toEqual(["j1"]);
    // The left bracket and the pin are untouched, in place.
    expect(folded.messages[0]).toBe(left);
    expect(folded.messages[1]).toBe(leftResult);
    expect(folded.messages[2]).toBe(pinned);
    expect(folded.messages[4].content[0].text).toContain("found the parser path");
    expect(folded.messages[4].content[0].text).toContain("f1 joined");
    expect(folded.messages[4].content[0].text).not.toContain("full child record");
    expect(folded.messages).toHaveLength(messages.length);
  });

  test("the youngest receipt keeps its full text", () => {
    let list = addReceipt([], receipt("f1", "j1", 1));
    list = addReceipt(list, receipt("f2", "j2", 2));
    list = attachReport(list, "j2", "youngest summary");
    const youngest = { ...rightResult, toolCallId: "j2" };
    const folded = applyReceiptFolds([right, youngest], list, {
      foldable: foldableReceipts(list),
    });
    expect(folded.collapsed).toEqual([]);
    expect(folded.messages[1]).toBe(youngest);
  });
});

describe("receipts survive a reload", () => {
  test("serialize and deserialize keep the chain", () => {
    const state = createState();
    state.receipts = addReceipt([], receipt("f1", "j1", 3, "L0", "elder summary"));
    const restored = deserializeState(serializeState(state));
    expect(restored.receipts).toHaveLength(1);
    expect(restored.receipts[0].closeToolCallId).toBe("j1");
    expect(restored.receipts[0].report).toBe("elder summary");
    expect(restored.receipts[0].closedOrder).toBe(3);
    expect(validReceipts(restored.receipts)).toBe(true);
  });

  test("a malformed receipt resets to a clean state instead of crashing", () => {
    const state = createState();
    const payload = serializeState(state);
    payload.receipts = [{ closeToolCallId: "j1" }];
    expect(deserializeState(payload).receipts).toEqual([]);
  });

  test("copyReceipt drops unknown fields", () => {
    const copy = copyReceipt({ ...receipt("f1", "j1", 1), extra: true });
    expect(copy.extra).toBeUndefined();
    expect(Object.keys(copy).sort()).toEqual(
      ["closeToolCallId", "closedOrder", "collapsed", "forkToolCallId", "levelKey", "report"].sort(),
    );
  });
});

describe("the join path records the chain", () => {
  test("a second join files the first summary and keeps both brackets", () => {
    const station = Object.create(SessionStation.prototype);
    station.state = createState();
    station.state.receipts = [];

    station.recordJoinReceipt({
      forkId: "f1",
      closeToolCallId: "j1",
      levelKey: "L0",
      closedOrder: 1,
      elderReport: null,
      pending: null,
    });
    station.recordJoinReceipt({
      forkId: "f2",
      closeToolCallId: "j2",
      levelKey: "L0",
      closedOrder: 2,
      elderReport: "the elder found the parser path",
      pending: { forkId: "f1", closeToolCallId: "j1" },
    });

    expect(station.state.receipts).toHaveLength(2);
    expect(station.state.receipts[0]).toMatchObject({
      forkToolCallId: "f1",
      closeToolCallId: "j1",
      closedOrder: 1,
      report: "the elder found the parser path",
      collapsed: false,
    });
    expect(station.state.receipts[1]).toMatchObject({
      forkToolCallId: "f2",
      closeToolCallId: "j2",
      report: null,
    });
    // Only the elder is eligible; the newest record stays complete.
    expect(foldableReceipts(station.state.receipts).map((entry) => entry.closeToolCallId)).toEqual([
      "j1",
    ]);
    station.settleReceiptFolds(["j1"]);
    expect(station.state.receipts[0].collapsed).toBe(true);
    // A shortened receipt stays eligible: the next request projects from the
    // stored branch and must shorten it again.
    expect(foldableReceipts(station.state.receipts).map((entry) => entry.closeToolCallId)).toEqual([
      "j1",
    ]);
  });
});
