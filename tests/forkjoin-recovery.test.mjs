// Cross-process recovery of the bracket tree.
//
// A reload keeps the receipt chain today, but the brackets themselves live in
// a process-local registry. These cases fix the contract the station must
// honour: the tree is persisted with the scope state, a running fork comes
// back as an explicit failed result instead of vanishing, and a ready result
// keeps both its order and its frozen record.

import { describe, expect, test } from "bun:test";

import {
  BLOCKED,
  JOINED,
  createBracketLedger,
  forkOf,
  markReady,
  readyChildren,
  registerFork,
  restoreLedger,
  serializeLedger,
  takeReady,
  validLedger,
} from "../src/scope/forkjoin.mjs";
import { createFlowState, createState } from "../src/scope/state.mjs";
import { deserializeState, serializeState } from "../src/scope/persistence.mjs";
import { createForkWiring } from "../src/scope/fork-wiring.mjs";
import { SessionStation } from "../src/station/station.mjs";
import { bindStationPorts } from "./helpers/station-ports.mjs";
import { attachForkPorts } from "./helpers/fork-attach.mjs";
import { ledgerFor } from "../src/scope/fork-registry.mjs";
import { handleReturnCall } from "../src/station/fork-controls.mjs";

function running(ledger, forkId, ownerId = "root", extra = {}) {
  const out = registerFork(ledger, {
    forkId,
    ownerId,
    levelKey: "root|0|0",
    fsm: `work ${forkId}`,
    depth: 0,
    budget: { read: 2 },
    time: 60,
    startedAt: 1_000,
    ...extra,
  });
  expect(out.ok).toBe(true);
  return out.fork;
}

describe("the bracket tree survives a reload", () => {
  test("every open bracket, its budget and its owner are restored", () => {
    const fresh = createBracketLedger();
    running(fresh, "f1");
    registerFork(fresh, {
      forkId: "f2",
      ownerId: "root",
      levelKey: "root|0|0",
      fsm: "work f2",
      depth: 0,
      blocked: true,
    });

    const restored = restoreLedger(serializeLedger(fresh));
    expect(restored.order).toEqual(["f1", "f2"]);
    expect(forkOf(restored, "f1").ownerId).toBe("root");
    expect(forkOf(restored, "f1").budget).toEqual({ read: 2 });
    expect(forkOf(restored, "f1").status).toBe("ready");
    expect(forkOf(restored, "f2").status).toBe(BLOCKED);
  });

  test("a running fork comes back as a failed result, never as running", () => {
    const ledger = createBracketLedger();
    running(ledger, "f1", "root", { time: 60 });
    const restored = restoreLedger(serializeLedger(ledger));
    const record = forkOf(restored, "f1");
    expect(record.status).toBe("ready");
    expect(record.outcome).toBe("failed");
    expect(record.reason).toContain("restart");
    const taken = takeReady(restored, { ownerId: "root", levelKey: "root|0|0" });
    expect(taken.ok).toBe(true);
    expect(taken.fork.forkId).toBe("f1");
    expect(taken.fork.outcome).toBe("failed");
  });

  test("a ready result keeps its order and its frozen record", () => {
    const ledger = createBracketLedger();
    running(ledger, "late-child");
    running(ledger, "early-child");
    markReady(ledger, "early-child", { ok: true, record: "early record" });
    markReady(ledger, "late-child", { ok: true, record: "late record" });

    const restored = restoreLedger(serializeLedger(ledger));
    expect(readyChildren(restored, "root")).toEqual(["early-child", "late-child"]);
    expect(forkOf(restored, "early-child").record).toBe("early record");
    const first = takeReady(restored, { ownerId: "root", levelKey: "root|0|0" });
    expect(first.fork.record).toBe("early record");
    const second = takeReady(restored, { ownerId: "root", levelKey: "root|0|0" });
    expect(second.fork.record).toBe("late record");
  });

  test("a joined bracket never returns to the ready queue", () => {
    const ledger = createBracketLedger();
    running(ledger, "f1");
    markReady(ledger, "f1", { ok: true, record: "done" });
    expect(takeReady(ledger, { ownerId: "root", levelKey: "root|0|0" }).ok).toBe(true);
    const restored = restoreLedger(serializeLedger(ledger));
    expect(forkOf(restored, "f1").status).toBe(JOINED);
    expect(readyChildren(restored, "root")).toEqual([]);
    expect(takeReady(restored, { ownerId: "root", levelKey: "root|0|0" }).ok).toBe(false);
  });

  test("an invalid ledger is refused instead of guessed", () => {
    expect(validLedger({})).toBe(false);
    expect(validLedger({ version: 1, seq: 0, forks: {} })).toBe(false);
    expect(restoreLedger({ forks: { f1: { status: "running" } } }).order).toEqual([]);
  });

  test("an inconsistent tree is refused instead of half-restored", () => {
    // validLedger accepts a record whose childDepth does not follow its depth:
    // the field is optional in the stored shape. A restored tree would then
    // address a child one level too high, so the whole snapshot is refused.
    const fresh = createBracketLedger();
    running(fresh, "f1");
    const payload = serializeLedger(fresh);
    payload.forks.f1.childDepth = payload.forks.f1.depth;
    expect(validLedger(payload)).toBe(true);
    const restored = restoreLedger(payload);
    expect(restored.order).toEqual([]);
    expect(restored.forks).toEqual({});
  });

  test("an unpaired tree resets the brackets", () => {
    const state = createState();
    running(state.brackets, "f1");
    const payload = serializeState(state);
    payload.brackets.forks.f1.childDepth = payload.brackets.forks.f1.depth;
    expect(validLedger(payload.brackets)).toBe(true);
    const restored = deserializeState(payload);
    expect(restored.brackets.order).toEqual([]);
  });

  test("a reload that carries a corrupt ledger starts clean", () => {
    const state = createState();
    const payload = serializeState(state);
    payload.brackets = { version: 1, forks: { broken: true } };
    const restored = deserializeState(payload);
    expect(restored.brackets.order).toEqual([]);
  });
});

describe("the scope state owns the tree", () => {
  test("the runtime uses the restored tree instead of a fresh index", () => {
    const wiring = createForkWiring();
    const state = createState();
    running(state.brackets, "f1");
    const station = Object.create(SessionStation.prototype);
    station.state = state;
    station.manager = null;
    station.persist = () => {};
    station.ports = bindStationPorts(state);
    attachForkPorts(station, wiring, { conversationKey: "restored" });
    expect(station.forkLedgerPort()).toBe(state.brackets);
    expect(forkOf(station.forkLedgerPort(), "f1")).not.toBeNull();
    expect(ledgerFor(wiring.registry, "restored")).toBe(state.brackets);
  });

  test("a child's return is persisted through the root before the parent takes it", () => {
    const ledger = createBracketLedger();
    running(ledger, "c1");
    let persisted = 0;
    const station = {
      state: createState(),
      forkLedgerPort: () => ledger,
      forkIdentityPort: () => ({ forkId: "c1" }),
      forkOwnerId: () => "c1",
      ownerId: "c1",
      contextMessages: () => [
        { role: "assistant", content: [{ type: "text", text: "child work" }] },
      ],
      setChildOutcome: () => {},
      persistLedger: () => {
        persisted += 1;
      },
    };
    const out = handleReturnCall(station, { id: "r1", arguments: {} });
    expect(out.isError).toBeUndefined();
    expect(persisted).toBe(1);
    expect(out.content[0].text).not.toContain("Persistence warning");
    expect(forkOf(ledger, "c1").status).toBe("ready");
    expect(forkOf(ledger, "c1").record).toBe("child work");
  });

  test("a failed ledger write is visible in the return receipt", () => {
    const ledger = createBracketLedger();
    running(ledger, "c1");
    const station = {
      state: createState(),
      forkLedgerPort: () => ledger,
      forkIdentityPort: () => ({ forkId: "c1" }),
      forkOwnerId: () => "c1",
      ownerId: "c1",
      contextMessages: () => [],
      setChildOutcome: () => {},
      persistLedger: () => false,
      noteError: () => {},
    };
    const out = handleReturnCall(station, { id: "r1", arguments: {} });
    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toContain("Persistence warning");
    // The domain fact still stands: the parent can take it this run.
    expect(forkOf(ledger, "c1").status).toBe("ready");
  });

  test("serialize and deserialize keep the tree", () => {
    const state = createState();
    const out = registerFork(state.brackets, {
      forkId: "f1",
      ownerId: "root",
      levelKey: "root|0|0",
      fsm: "one task",
      depth: 0,
      budget: { read: 1 },
      time: 30,
      startedAt: 0,
    });
    expect(out.ok).toBe(true);
    markReady(state.brackets, "f1", { ok: true, record: "the record" });

    const restored = deserializeState(serializeState(state));
    expect(forkOf(restored.brackets, "f1").status).toBe("ready");
    expect(forkOf(restored.brackets, "f1").record).toBe("the record");
  });

  test("an old snapshot without a ledger still loads", () => {
    const payload = serializeState(createState());
    delete payload.brackets;
    const restored = deserializeState(payload);
    expect(restored.brackets.order).toEqual([]);
    expect(restored.brackets.queues).toEqual({});
  });

  test("a child flow works against the session's one tree", () => {
    const base = createState();
    running(base.brackets, "f1");
    const flow = createFlowState(base);
    expect(flow.brackets).toBe(base.brackets);
    markReady(flow.brackets, "f1", { ok: true, record: "flow record" });
    expect(forkOf(base.brackets, "f1").record).toBe("flow record");
  });
});
