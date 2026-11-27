// Receipt pricing: a fork is priced by the text it will actually send.
//
// Four contracts, all from `.agent/skills/fork-fsm-clean-break/SKILL.md`:
//   1. the estimate is the rendered receipt, with no hidden prefix constant;
//   2. a new generation is priced by the record it carries forward;
//   3. a revived checkpoint is priced by the target's own state machine;
//   4. a version-1 snapshot is refused and rebuilt, never half-read.
//
// These cases stop at the station handler and read only observable results:
// the receipt handed to the spawner, the refusal code, and the ledger order.

import { describe, expect, test } from "bun:test";

import {
  createBracketLedger,
  forkOf,
  markReady,
  restoreLedgerChecked,
  serializeLedger,
} from "../src/scope/forkjoin.mjs";
import { handleForkCall } from "../src/station/fork-controls.mjs";

function stationFor(ledger, options = {}) {
  return {
    state: { receipts: [], relay: { generation: 0, fullFlow: false } },
    forkLedgerPort: () => ledger,
    forkIdentityPort: () => null,
    forkOwnerId: () => null,
    contextMessages: () => [],
    currentContextTokens: () => 0,
    tokensPerCharFor: () => 1,
    childOutcomePort: () => null,
    usage: { lastUsageModelKey: null },
    ...options,
  };
}

function item(overrides = {}) {
  return {
    path: "f1",
    fsm: "audit one seam",
    // Every fork creates a scope, so every field is required: the identity
    // statement, and the declared size of the work.
    profession: "You are a careful auditor like Ada Lovelace.",
    n: 1,
    budget: {},
    time: 60,
    targets: ["src/parser.mjs"],
    ...overrides,
  };
}

function call(id, ...items) {
  return { id, arguments: { forks: items } };
}

// A station that admits everything and hands back the receipt each child
// would read. Used to measure real text, not to assert on it.
function measuringStation(ledger, spawned) {
  return stationFor(ledger, {
    forkWindowPort: () => 1_000_000,
    forkReservePort: () => 0,
    forkMarginPort: () => 0,
    childSpawnPort: () => (spec) => spawned.push(spec),
  });
}

describe("a fork is priced by the receipt it sends", () => {
  test("the window boundary sits exactly at the receipt length", () => {
    const measured = [];
    const probe = handleForkCall(
      measuringStation(createBracketLedger(), measured),
      call("probe", item()),
    );
    expect(probe.isError).toBeUndefined();
    expect(measured).toHaveLength(1);
    const receiptLength = measured[0].receipt.length;

    // Equality is a refusal: projected + reserve + margin must stay below the
    // window. With no reserve, no margin, base 0 and density 1, the projected
    // value is the receipt's own length and nothing else.
    const tightLedger = createBracketLedger();
    const tightSpawned = [];
    const tight = handleForkCall(
      stationFor(tightLedger, {
        forkWindowPort: () => receiptLength,
        forkReservePort: () => 0,
        forkMarginPort: () => 0,
        childSpawnPort: () => (spec) => tightSpawned.push(spec),
      }),
      call("tight", item()),
    );
    expect(tight.isError).toBe(true);
    expect(tight.details.code).toBe("FORK_CONTEXT_EXCEEDED");
    expect(tight.details.projected).toBe(receiptLength);
    expect(tightSpawned).toHaveLength(0);
    expect(tightLedger.order).toEqual([]);

    // One character of room is enough.
    const roomLedger = createBracketLedger();
    const roomSpawned = [];
    const room = handleForkCall(
      stationFor(roomLedger, {
        forkWindowPort: () => receiptLength + 1,
        forkReservePort: () => 0,
        forkMarginPort: () => 0,
        childSpawnPort: () => (spec) => roomSpawned.push(spec),
      }),
      call("room", item()),
    );
    expect(room.isError).toBeUndefined();
    expect(roomSpawned).toHaveLength(1);
    expect(roomLedger.order).toEqual(["room"]);
  });
});

// A generation and a revived checkpoint no longer exist: a fork only creates,
// and a message to an existing scope is `scope_request`, which is a free control
// call with no pricing path. No case here can re-pin them.

describe("the ledger snapshot format", () => {
  test("a version-1 snapshot is refused and rebuilt without throwing", () => {
    const legacy = {
      version: 1,
      seq: 1,
      closedSeq: 0,
      receiveSeq: 0,
      order: ["legacy"],
      forks: {
        legacy: {
          forkId: "legacy",
          scopeId: "worker",
          ownerId: "root",
          intent: "an old state machine",
          depth: 1,
          status: "running",
          openSeq: 1,
          budget: { read: 1 },
          remaining: { read: 1 },
          spent: {},
          record: null,
          reason: null,
        },
      },
    };

    const restored = restoreLedgerChecked(legacy);
    expect(restored.ok).toBe(false);
    expect(restored.ledger.order).toEqual([]);
  });

  test("a current snapshot round-trips its state machine field", () => {
    const ledger = createBracketLedger();
    const spawned = [];
    handleForkCall(measuringStation(ledger, spawned), call("call-1", item()));

    const restored = restoreLedgerChecked(serializeLedger(ledger));
    expect(restored.ok).toBe(true);
    expect(restored.ledger.order).toEqual(["call-1"]);
    expect(forkOf(restored.ledger, "call-1").fsm).toBe("audit one seam");
  });
});
