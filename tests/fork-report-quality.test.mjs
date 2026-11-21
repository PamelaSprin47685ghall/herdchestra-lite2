// Elder report quality: the runtime cannot prove a summary is complete, but it
// can refuse a value that cannot archive anything and one that is larger than
// the record it replaces. A refusal never consumes the ready result.

import { describe, expect, test } from "bun:test";

import {
  createBracketLedger,
  forkOf,
  markReady,
  readyChildren,
  registerFork,
} from "../src/scope/forkjoin.mjs";
import { handleJoinCall } from "../src/station/fork-controls.mjs";
import {
  addReceipt,
  attachReport,
  createReceiptRecord,
} from "../src/scope/receipts.mjs";

const LEVEL = "root|0|0";

function stationWith(pendingReport = null) {
  const ledger = createBracketLedger();
  registerFork(ledger, {
    forkId: "f2",
    ownerId: "root",
    levelKey: LEVEL,
    intent: "second task",
    depth: 0,
  });
  markReady(ledger, "f2", { ok: true, record: "the second record" });
  const station = {
    state: {
      receipts: pendingReport === null
        ? []
        : addReceipt(
            [],
            createReceiptRecord({
              forkToolCallId: "f1",
              closeToolCallId: "j1",
              levelKey: LEVEL,
              closedOrder: 1,
            }),
          ),
      relay: { generation: 0, fullFlow: false },
    },
    forkLedgerPort: () => ledger,
    forkIdentityPort: () => null,
    forkOwnerId: () => null,
    childOutcomePort: () => null,
    currentContextTokens: () => 0,
    tokensPerCharFor: () => 1,
    usage: { lastUsageModelKey: null },
    recordJoinReceipt(spec) {
      let receipts = station.state.receipts;
      if (spec.pending) {
        receipts = attachReport(receipts, spec.pending.closeToolCallId, spec.elderReport);
      }
      receipts = addReceipt(
        receipts,
        createReceiptRecord({
          forkToolCallId: spec.forkId,
          closeToolCallId: spec.closeToolCallId,
          levelKey: spec.levelKey,
          closedOrder: spec.closedOrder,
        }),
      );
      station.state.receipts = receipts;
    },
  };
  return { ledger, station };
}

describe("a summary that cannot guide the next decision", () => {
  test("a one-word report is refused and the child stays ready", () => {
    const { ledger, station } = stationWith("pending");
    const out = handleJoinCall(station, {
      id: "j2",
      arguments: { elder_report: "done" },
    });
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("INVALID_ELDER_REPORT");
    expect(out.details.minimum).toBeGreaterThan("done".length);
    expect(readyChildren(ledger, "root")).toEqual(["f2"]);
    expect(forkOf(ledger, "f2").status).toBe("ready");
  });

  test("a report at the minimum length is accepted", () => {
    const { station } = stationWith("pending");
    const report = "measured the parser and left the lexer open"; // 43 chars
    const out = handleJoinCall(station, {
      id: "j2",
      arguments: { elder_report: report },
    });
    expect(out.isError).toBeUndefined();
    expect(station.state.receipts[0].report).toBe(report);
  });

  test("an overlong report is refused instead of silently truncated", () => {
    const { ledger, station } = stationWith("pending");
    const out = handleJoinCall(station, {
      id: "j2",
      arguments: { elder_report: "x".repeat(4001) },
    });
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("INVALID_ELDER_REPORT");
    expect(out.details.maximum).toBe(4000);
    expect(readyChildren(ledger, "root")).toEqual(["f2"]);
  });

  test("a refusal leaves the pending receipt without a report", () => {
    const { station } = stationWith("pending");
    handleJoinCall(station, { id: "j2", arguments: { elder_report: "short" } });
    expect(station.state.receipts[0].report).toBeNull();
  });

  test("a receipt from an older level key still owes its report", () => {
    // A relay handoff moves the level key (generation|epoch), but the last
    // join of the previous generation is still the elder the next join must
    // summarize. The obligation must not disappear with the key.
    const { station } = stationWith("pending");
    station.state.relay = { generation: 1, fullFlow: true };
    const out = handleJoinCall(station, { id: "j2", arguments: {} });
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("INVALID_ELDER_REPORT");
    expect(station.state.receipts[0].report).toBeNull();
  });

  test("a null report with no pending elder stays unexpected", () => {
    const { station } = stationWith(null);
    const out = handleJoinCall(station, {
      id: "j1",
      arguments: { elder_report: "this receipt does not exist" },
    });
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("ELDER_REPORT_UNEXPECTED");
  });
});
