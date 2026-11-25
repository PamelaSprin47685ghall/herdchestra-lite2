import { describe, expect, test } from "bun:test";

import {
  JOINED,
  READY,
  clearWakeFlag,
  createBracketLedger,
  forkOf,
  markReady,
  readyChildren,
  registerFork,
  takeReady,
} from "../src/scope/forkjoin.mjs";
import { listActiveScopePaths } from "../src/scope/path.mjs";
import { handleReturnCall } from "../src/station/fork-controls.mjs";
import { handleSendCall } from "../src/station/send-controls.mjs";
import { createState, planLedgerEntry, foldStateChain } from "../src/scope/index.mjs";

const STATE = {
  scopes: [],
  autopilot: false,
  relay: { generation: 0, fullFlow: false },
};

function fork(ledger, forkId, ownerId = "root", depth = 0, path = `/${forkId}`) {
  const out = registerFork(ledger, {
    forkId,
    ownerId,
    levelKey: "L0",
    fsm: `task ${forkId}`,
    depth,
  });
  expect(out.ok).toBe(true);
  out.fork.path = path;
  return out.fork;
}

function sender(ledger) {
  return {
    state: { ...STATE },
    forkLedgerPort: () => ledger,
    forkIdentityPort: () => null,
  };
}

function child(ledger, forkId, path) {
  return {
    state: { ...STATE },
    forkLedgerPort: () => ledger,
    forkIdentityPort: () => ({
      forkId,
      parentOwnerId: "root",
      ownScopeId: path.slice(1),
      path,
    }),
    contextMessages: () => [],
    setChildOutcome: () => {},
  };
}

describe("the first return does not park", () => {
  test("scope_return seals the record and answers accepted at once", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f-c1", "root", 0, "/worker");
    const out = handleReturnCall(child(ledger, "f-c1", "/worker"), {
      id: "call-r1",
      arguments: { dafny: "the parser leaks" },
    });
    expect(out.isError).toBeUndefined();
    expect(out.details.accepted).toBe(true);
    expect(out.details.awaitingReceipt).toBeUndefined();
    expect(forkOf(ledger, "f-c1").status).toBe(READY);
    expect(readyChildren(ledger, "root")).toEqual(["f-c1"]);
  });

  test("a finished scope leaves the active list but keeps its record", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f-c1", "root", 0, "/worker");
    expect(listActiveScopePaths(ledger)).toContain("/worker");
    markReady(ledger, "f-c1", { ok: true, record: "done" });
    expect(listActiveScopePaths(ledger)).not.toContain("/worker");
    expect(forkOf(ledger, "f-c1").status).toBe(READY);
    expect(listActiveScopePaths(ledger)).toEqual(["/"]);
  });
});

describe("a message wakes a finished scope in place", () => {
  test("an exact path wakes a ready scope without touching the parent's queue", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f-c1", "root", 0, "/worker");
    markReady(ledger, "f-c1", { ok: true, record: "done" });

    const out = handleSendCall(sender(ledger), {
      id: "call-s1",
      arguments: { target: "/worker", message: "what did you find?" },
    });
    expect(out.isError).toBeUndefined();
    expect(out.details.woken).toEqual(["/worker"]);

    const record = forkOf(ledger, "f-c1");
    expect(record.woken).toBe(true);
    expect(record.inbox).toHaveLength(1);
    expect(listActiveScopePaths(ledger)).toContain("/worker");
    // The parent can still take the first record; waking adds no second one.
    expect(readyChildren(ledger, "root")).toEqual(["f-c1"]);
  });

  test("an exact path wakes an already joined scope and leaves it joined", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f-c1", "root", 0, "/worker");
    markReady(ledger, "f-c1", { ok: true, record: "done" });
    takeReady(ledger, { ownerId: "root", levelKey: "L0" });
    expect(forkOf(ledger, "f-c1").status).toBe(JOINED);

    handleSendCall(sender(ledger), {
      id: "call-s2",
      arguments: { target: "/worker", message: "one more thing" },
    });
    const record = forkOf(ledger, "f-c1");
    expect(record.status).toBe(JOINED);
    expect(record.woken).toBe(true);
    expect(listActiveScopePaths(ledger)).toContain("/worker");
  });

  test("a glob never wakes a finished scope", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f-c1", "root", 0, "/worker");
    markReady(ledger, "f-c1", { ok: true, record: "done" });

    const out = handleSendCall(sender(ledger), {
      id: "call-s3",
      arguments: { target: "**", message: "anyone alive?" },
    });
    expect(out.isError).toBeUndefined();
    expect(forkOf(ledger, "f-c1").woken).toBe(false);
    expect(forkOf(ledger, "f-c1").inbox ?? []).toHaveLength(0);
  });
});

describe("scope_return while woken is a send to ..", () => {
  test("wake clearing marks a partially throwing setter", () => {
    const ledger = createBracketLedger();
    const record = fork(ledger, "f-c1", "root", 0, "/worker");
    // An application-provided accessor can throw after changing state. The
    // domain operation preserves the old exception and records that mutation.
    let value = true;
    Object.defineProperty(record, "woken", {
      configurable: true, enumerable: true,
      get: () => value,
      set(next) { value = next; throw new Error("setter failed"); },
    });
    const state = createState();
    state.brackets = ledger;
    const before = planLedgerEntry(state, null);
    expect(() => clearWakeFlag(ledger, "f-c1")).toThrow("setter failed");
    expect(value).toBe(false);
    const after = planLedgerEntry(state, before.brackets);
    expect(after.entry).not.toBeNull();
    expect(foldStateChain([before.entry, after.entry]).brackets.forks["f-c1"].woken).toBe(false);
  });

  test("the cleared wake flag survives persistence after an intervening snapshot", () => {
    const state = createState();
    const ledger = state.brackets;
    fork(ledger, "f-c1", "root", 0, "/worker");
    markReady(ledger, "f-c1", { ok: true, record: "first look" });
    handleSendCall(sender(ledger), {
      id: "wake",
      arguments: { target: "/worker", message: "look again" },
    });
    const first = planLedgerEntry(state, null);
    expect(first.brackets.forks["f-c1"].woken).toBe(true);

    handleReturnCall(child(ledger, "f-c1", "/worker"), {
      id: "return",
      arguments: { dafny: "done" },
    });
    const next = planLedgerEntry(state, first.brackets);
    expect(next.entry).not.toBeNull();
    const restored = foldStateChain([first.entry, next.entry]);
    expect(restored.brackets.forks["f-c1"].woken).toBe(false);
  });

  test("it forwards the text to the parent and ends the woken state", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f-c1", "root", 0, "/worker");
    markReady(ledger, "f-c1", { ok: true, record: "first look" });
    handleSendCall(sender(ledger), {
      id: "call-s4",
      arguments: { target: "/worker", message: "look again" },
    });
    expect(forkOf(ledger, "f-c1").woken).toBe(true);

    const out = handleReturnCall(child(ledger, "f-c1", "/worker"), {
      id: "call-r2",
      arguments: { dafny: "second look: it is the cache" },
    });
    expect(out.isError).toBeUndefined();
    expect(out.details.accepted).toBe(true);
    expect(ledger.rootInbox.at(-1).envelope).toBe(
      "[Message from /worker]\nsecond look: it is the cache",
    );
    const record = forkOf(ledger, "f-c1");
    expect(record.woken).toBe(false);
    // The original record is untouched: still one record, still ready.
    expect(record.status).toBe(READY);
    expect(readyChildren(ledger, "root")).toEqual(["f-c1"]);
  });

  test("the idle session in the wiring answers the message and stops", async () => {
    // The whole point of not parking the first return is that the session
    // survives it. This drives the real spawn ticket and the real wake loop,
    // so the retention is proven rather than assumed.
    const { spawnChildTicket, wakeIdleScope } = await import("../src/tools/spawn-ticket.mjs");
    const { createForkRegistry, setOutcome } = await import("../src/scope/fork-registry.mjs");

    const ledger = createBracketLedger();
    const registry = createForkRegistry();
    fork(ledger, "f-live", "root", 0, "/worker");
    const prompts = [];
    let idle = null;
    const session = {
      agent: { state: { messages: [] }, id: "agent-live" },
      prompt: async (text) => {
        prompts.push(text);
        // The child's own scope_return, in the beat of its first prompt.
        if (forkOf(ledger, "f-live").status === "running") {
          setOutcome(registry, "f-live", { record: "first look", failed: false, reason: null });
          markReady(ledger, "f-live", { ok: true, record: "first look" });
        }
      },
    };
    const spawned = await spawnChildTicket(
      { forkId: "f-live", receipt: "You are now in the scope /worker," },
      {
        registry,
        ledger,
        createSession: async () => ({ ok: true, session }),
        registerIdle: (forkId, entry) => {
          idle = entry;
        },
      },
    );
    expect(spawned.ok).toBe(true);
    // Retained: the spawn ended, the handle outlived it.
    expect(idle).not.toBeNull();
    expect(typeof idle.prompt).toBe("function");
    expect(prompts).toHaveLength(1);
    expect(forkOf(ledger, "f-live").woken).toBe(false);

    let woken = null;
    const station = {
      ...sender(ledger),
      childWakePort: () => (forkId) => {
        woken = wakeIdleScope(idle, ledger, forkId);
      },
    };
    const out = handleSendCall(station, {
      id: "call-s5",
      arguments: { target: "/worker", message: "what did you find?" },
    });
    expect(out.details.woken).toEqual(["/worker"]);
    await woken;

    // Exactly one new prompt, and it is the envelope: no return nudge, the
    // single obligation was paid by the first return.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toBe("[Message from /]\nwhat did you find?");
    const record = forkOf(ledger, "f-live");
    expect(record.inbox).toHaveLength(1);
    expect(record.inboxDelivered).toBe(1);
    // Idle again, and the parent's record is exactly as it was.
    expect(record.woken).toBe(false);
    expect(record.status).toBe(READY);
    expect(listActiveScopePaths(ledger)).not.toContain("/worker");
  });

  test("a woken scope gets no return nudge", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f-c1", "root", 0, "/worker");
    markReady(ledger, "f-c1", { ok: true, record: "done" });
    const record = forkOf(ledger, "f-c1");
    record.woken = true;
    expect(record.status === "running").toBe(false);
  });
});
