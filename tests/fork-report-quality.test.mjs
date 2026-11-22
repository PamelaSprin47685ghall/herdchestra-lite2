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
import * as descriptions from "../src/tools/descriptions.mjs";
import {
  ELDER_REPORT_PATTERN,
  MAX_ELDER_REPORT_CHARS,
  MIN_ELDER_REPORT_CHARS,
  elderReportProblem,
} from "../src/scope/elder-report.mjs";
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

describe("elder report boundaries", () => {
  const atLeast = (n) => "x".repeat(n);

  test("23 characters are refused and 24 are accepted", () => {
    const { station } = stationWith("pending");
    const short = handleJoinCall(station, { id: "j2", arguments: { elder_report: atLeast(23) } });
    expect(short.isError).toBe(true);
    expect(short.details.code).toBe("INVALID_ELDER_REPORT");
    const ok = handleJoinCall(stationWith("pending").station, {
      id: "j2",
      arguments: { elder_report: atLeast(24) },
    });
    expect(ok.isError).toBeUndefined();
  });

  test("4000 characters are accepted and 4001 are refused", () => {
    const ok = handleJoinCall(stationWith("pending").station, {
      id: "j2",
      arguments: { elder_report: atLeast(4000) },
    });
    expect(ok.isError).toBeUndefined();
    const tooLong = handleJoinCall(stationWith("pending").station, {
      id: "j2",
      arguments: { elder_report: atLeast(4001) },
    });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.details.maximum).toBe(4000);
  });

  test("padding does not satisfy the bound: the trimmed length does", () => {
    // Padding is not content. A 21-character sentence padded to 27 raw
    // characters is still 21 characters once trimmed, so both the schema and
    // the runtime refuse it.
    const tooShort = `   ${atLeast(21)}   `;
    expect(tooShort).toHaveLength(27);
    const short = handleJoinCall(stationWith("pending").station, {
      id: "j2",
      arguments: { elder_report: tooShort },
    });
    expect(short.isError).toBe(true);
    expect(short.details.code).toBe("INVALID_ELDER_REPORT");

    const padded = `   ${atLeast(24)}   `;
    const { station } = stationWith("pending");
    const out = handleJoinCall(station, { id: "j2", arguments: { elder_report: padded } });
    expect(out.isError).toBeUndefined();
    expect(station.state.receipts[0].report).toBe(atLeast(24));
  });

  test("a whitespace-only report is refused by the shared non-space rule", () => {
    const out = handleJoinCall(stationWith("pending").station, {
      id: "j2",
      arguments: { elder_report: " ".repeat(40) },
    });
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("INVALID_ARGUMENT");
  });

  test("the tool schema carries the same trimmed-length window as the runtime", () => {
    const branch = descriptions.joinParameters.properties.elder_report.anyOf[0];
    expect(branch.minLength).toBe(MIN_ELDER_REPORT_CHARS);
    // The upper bound lives in the pattern: a maxLength would reject a padded
    // report that the runtime accepts after trimming.
    expect(branch.maxLength).toBeUndefined();
    expect(branch.pattern).toBe(ELDER_REPORT_PATTERN);
  });

  test("the schema and the runtime accept exactly the same reports", () => {
    const branch = descriptions.joinParameters.properties.elder_report.anyOf[0];
    const schemaAccepts = (value) => {
      if (value === null) return true;
      const longEnough = branch.minLength === undefined || value.length >= branch.minLength;
      const shortEnough = branch.maxLength === undefined || value.length <= branch.maxLength;
      return longEnough && shortEnough && new RegExp(branch.pattern, "u").test(value);
    };
    const runtimeAccepts = (value) =>
      value === null || elderReportProblem(value) === null;

    const cases = [
      { value: "", accepts: false },
      { value: " ", accepts: false },
      { value: atLeast(MIN_ELDER_REPORT_CHARS - 1), accepts: false },
      { value: atLeast(MIN_ELDER_REPORT_CHARS), accepts: true },
      { value: atLeast(MAX_ELDER_REPORT_CHARS), accepts: true },
      { value: atLeast(MAX_ELDER_REPORT_CHARS + 1), accepts: false },
      { value: `   ${atLeast(21)}   `, accepts: false },
      { value: `   ${atLeast(MIN_ELDER_REPORT_CHARS)}   `, accepts: true },
      { value: `  ${atLeast(MAX_ELDER_REPORT_CHARS)}  `, accepts: true },
      // A leading or trailing BOM is trimmed like any other white space, and
      // the schema's trim class names it explicitly because \s does not.
      { value: `\uFEFF${atLeast(MIN_ELDER_REPORT_CHARS)}\uFEFF`, accepts: true },
      { value: `\uFEFF${atLeast(MIN_ELDER_REPORT_CHARS - 1)}\uFEFF`, accepts: false },
      { value: null, accepts: true },
    ];
    for (const { value, accepts } of cases) {
      expect({ value, accepts: schemaAccepts(value) }).toEqual({ value, accepts });
      expect({ value, accepts: runtimeAccepts(value) }).toEqual({ value, accepts });
    }
  });
});

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
