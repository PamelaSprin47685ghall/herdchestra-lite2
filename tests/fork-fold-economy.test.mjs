// The shortened projection of an old right bracket.
//
// A summary archives the elder's conclusions, but it must not lengthen the
// request and it must not delete the structure the parent still needs: nested
// fork lines and the pins the child recorded.

import { describe, expect, test } from "bun:test";

import {
  addReceipt,
  attachReport,
  createReceiptRecord,
  foldableReceipts,
} from "../src/scope/receipts.mjs";
import { applyReceiptFolds, extractPinnedLines } from "../src/transcript/collapse.mjs";

function receipt(forkId, closeId, closedOrder, report = null) {
  return createReceiptRecord({
    forkToolCallId: forkId,
    closeToolCallId: closeId,
    levelKey: "L0",
    closedOrder,
    report,
  });
}

function rightResult(text, callId = "j1") {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName: "scope_join",
    content: [{ type: "text", text }],
    isError: false,
  };
}

function foldOne(text, report) {
  let list = addReceipt([], receipt("f1", "j1", 1));
  list = addReceipt(list, receipt("f2", "j2", 2));
  list = attachReport(list, "j1", report);
  const message = rightResult(text);
  return applyReceiptFolds([message], list, { foldable: foldableReceipts(list) });
}

describe("a report must earn the replacement", () => {
  test("a report no shorter than the record leaves it intact", () => {
    const body = "short body";
    const folded = foldOne(body, "a summary that is longer than the body");
    expect(folded.collapsed).toEqual([]);
    expect(folded.messages[0].content[0].text).toBe(body);
  });

  test("a shorter report replaces the record", () => {
    const body = "x".repeat(400);
    const folded = foldOne(body, "the parser path is known");
    expect(folded.collapsed).toEqual(["j1"]);
    const text = folded.messages[0].content[0].text;
    expect(text).toContain("the parser path is known");
    expect(text).not.toContain(body);
  });
});

describe("the short projection keeps what the parent still needs", () => {
  test("a pin inside the folded record survives", () => {
    const body = [
      "[pin] finding: the parser accepts trailing commas",
      "x".repeat(400),
    ].join("\n");
    const folded = foldOne(body, "parser path known");
    const text = folded.messages[0].content[0].text;
    expect(text).toContain("the parser accepts trailing commas");
  });

  test("nested fork lines and pins survive together", () => {
    const body = [
      "[fork f9] intent: \"nested work\" | budget: read 2 | time: 30s | targets: nested.mjs",
      "[pin] conclusion: nested result is trustworthy",
      "x".repeat(400),
    ].join("\n");
    const folded = foldOne(body, "nested path known");
    const text = folded.messages[0].content[0].text;
    expect(text).toContain("[fork f9]");
    expect(text).toContain("nested result is trustworthy");
  });

  test("pin lines are recognized on their own", () => {
    expect(
      extractPinnedLines("a\n[pin] finding: keep me\n[pin]\nnot a pin"),
    ).toEqual(["[pin] finding: keep me", "[pin]"]);
  });

  test("an already short projection is never lengthened", () => {
    const already = "OK. Fork f1 joined. Child record folded.\n\nsummary";
    const folded = foldOne(already, "a much longer replacement summary");
    expect(folded.collapsed).toEqual([]);
    expect(folded.messages[0].content[0].text).toBe(already);
  });
});

// Compare the whole projection with the record, not the report with the
// record: the header, the blank lines, the pins and the nested fork lines all
// cost characters, and a report one character shorter than the record can
// still make the outbound request grow.
describe("the fold must shorten the whole projection", () => {
  function wrapperCost() {
    const body = "x".repeat(400);
    const report = "short";
    const folded = foldOne(body, report);
    expect(folded.collapsed).toEqual(["j1"]);
    return folded.messages[0].content[0].text.length - report.length;
  }

  test("a projection one character shorter than the record is folded", () => {
    const overhead = wrapperCost();
    const body = "x".repeat(400);
    const report = "y".repeat(400 - overhead - 1);
    const folded = foldOne(body, report);
    expect(folded.collapsed).toEqual(["j1"]);
    expect(folded.messages[0].content[0].text.length).toBe(399);
  });

  test("a projection as long as the record is held", () => {
    const overhead = wrapperCost();
    const body = "x".repeat(400);
    const report = "y".repeat(400 - overhead);
    const folded = foldOne(body, report);
    expect(folded.collapsed).toEqual([]);
    expect(folded.messages[0].content[0].text).toBe(body);
  });

  test("a shorter report that still grows the projection is held", () => {
    const body = "x".repeat(400);
    const folded = foldOne(body, "y".repeat(399));
    expect(folded.collapsed).toEqual([]);
    expect(folded.messages[0].content[0].text).toBe(body);
  });
});

// A failed right bracket carries the evidence the parent needs. Replacing its
// text with a summary would hide the failure, and a forced `isError: false`
// would turn it into a successful-looking receipt.
describe("a failed right bracket keeps its failure", () => {
  test("an error record is held and keeps isError", () => {
    const body = "x".repeat(400);
    let list = addReceipt([], receipt("f1", "j1", 1));
    list = addReceipt(list, receipt("f2", "j2", 2));
    list = attachReport(list, "j1", "the child failed on a missing file");
    const message = { ...rightResult(body), isError: true };
    const folded = applyReceiptFolds([message], list, {
      foldable: foldableReceipts(list),
    });
    expect(folded.collapsed).toEqual([]);
    expect(folded.messages[0].isError).toBe(true);
    expect(folded.messages[0].content[0].text).toBe(body);
  });
});
