import { describe, expect, test } from "bun:test";

import {
  attachForkPorts,
  createForkWiring,
  spawnChildTicket,
} from "../src/host/fork-wiring.mjs";
import {
  conversationKeyOf,
  ledgerFor,
  outcomeOf,
  setOutcome,
  waitForReady,
} from "../src/host/fork-registry.mjs";
import { openChildren, registerFork, RUNNING } from "../src/scope/forkjoin.mjs";

function stationOf() {
  return {
    state: { herdMode: false, relay: { generation: 0, fullFlow: false } },
    manager: null,
  };
}

function assistant(text) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: 1 };
}

function specFor(forkId) {
  return {
    forkId,
    childDepth: 1,
    intent: "probe",
    receipt: "You are the child of fork " + forkId,
    parentOwnerId: "root",
  };
}

function sessionOf(lines, options = {}) {
  const messages = [];
  return {
    messages,
    prompt: async () => {
      messages.push(assistant(lines));
      if (options.throwAfter) throw new Error(options.throwAfter);
    },
    agent: { state: { messages, stopReason: options.stopReason ?? "stop" } },
  };
}

describe("attachForkPorts", () => {
  test("a child station uses the ledger carried by its identity", () => {
    const wiring = createForkWiring();
    const parentLedger = ledgerFor(wiring.registry, "session:parent");
    const station = stationOf();
    const attached = attachForkPorts(station, wiring, {
      // A different conversation key must not create a second ledger when the
      // child identity already names the fork's ledger.
      conversationKey: "session:some-other-context",
      identity: { forkId: "child-1", ledger: parentLedger },
    });
    expect(attached.ledger).toBe(parentLedger);
    expect(station.forkLedgerPort()).toBe(parentLedger);
    expect(station.forkOwnerId()).toBe("child-1");
  });

  test("exposes all four ports and a shared ledger", () => {
    const wiring = createForkWiring();
    const station = stationOf();
    const attached = attachForkPorts(station, wiring, { conversationKey: "conversation" });
    expect(attached.ledger).toBe(ledgerFor(wiring.registry, "conversation"));
    expect(station.forkLedgerPort()).toBe(attached.ledger);
    expect(station.forkIdentityPort()).toBeNull();
    expect(station.childOutcomePort("ghost")).toBeNull();
    // No createSession, so no spawner: the handler reports the gap instead of
    // inventing one.
    expect(station.childSpawnPort).toBeUndefined();
  });

  test("a child that finishes writes its record and wakes the join", async () => {
    const wiring = createForkWiring();
    const station = stationOf();
    const attached = attachForkPorts(station, wiring, {
      conversationKey: "c",
      createSession: async () => ({
        ok: true,
        session: sessionOf("child did the work"),
      }),
    });
    registerFork(attached.ledger, {
      forkId: "f1",
      ownerId: "root",
      levelKey: "L",
      intent: "probe",
      depth: 0,
    });
    const waiting = waitForReady(wiring.registry, attached.ledger, {
      ownerId: "root",
      levelKey: "L",
    });
    station.childSpawnPort()(specFor("f1"));
    const taken = await waiting;
    expect(taken.fork.forkId).toBe("f1");
    const outcome = outcomeOf(wiring.registry, "f1");
    expect(outcome.failed).toBe(false);
    expect(outcome.record).toBe("child did the work");
  });

  test("a child that throws is recorded as failed and still wakes the join", async () => {
    const wiring = createForkWiring();
    const station = stationOf();
    const attached = attachForkPorts(station, wiring, {
      conversationKey: "c",
      createSession: async () => ({
        ok: true,
        session: sessionOf("partial work", { throwAfter: "provider exploded" }),
      }),
    });
    registerFork(attached.ledger, {
      forkId: "f2",
      ownerId: "root",
      levelKey: "L",
      intent: "probe",
      depth: 0,
    });
    const waiting = waitForReady(wiring.registry, attached.ledger, {
      ownerId: "root",
      levelKey: "L",
    });
    station.childSpawnPort()(specFor("f2"));
    const taken = await waiting;
    expect(taken.fork.forkId).toBe("f2");
    const outcome = outcomeOf(wiring.registry, "f2");
    expect(outcome.failed).toBe(true);
    expect(outcome.reason).toContain("provider exploded");
  });

  test("a frozen child record survives a spawn failure after the work", async () => {
    const wiring = createForkWiring();
    const station = {
      state: { herdMode: false, relay: { generation: 0, fullFlow: false } },
      manager: null,
      persist: () => {
        throw new Error("persist exploded");
      },
    };
    const attached = attachForkPorts(station, wiring, {
      conversationKey: "c",
      createSession: async () => ({
        ok: true,
        session: {
          messages: [],
          prompt: async () => {},
          agent: { state: { messages: [], stopReason: "stop" } },
        },
      }),
    });
    registerFork(attached.ledger, {
      forkId: "f4",
      ownerId: "root",
      levelKey: "L",
      intent: "probe",
      depth: 0,
    });
    // The child's own scope_return freezes a record before the spawn tail
    // runs. An empty failure written afterwards must not replace it.
    setOutcome(wiring.registry, "f4", { record: "frozen child work", failed: false });
    station.childSpawnPort()(specFor("f4"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const outcome = outcomeOf(wiring.registry, "f4");
    expect(outcome.record).toBe("frozen child work");
    expect(outcome.failed).toBe(false);
  });

  test("a session that cannot be created is recorded without throwing", async () => {
    const wiring = createForkWiring();
    const station = stationOf();
    const attached = attachForkPorts(station, wiring, {
      conversationKey: "c",
      createSession: async () => ({ ok: false, reason: "no sdk" }),
    });
    registerFork(attached.ledger, {
      forkId: "f3",
      ownerId: "root",
      levelKey: "L",
      intent: "probe",
      depth: 0,
    });
    const waiting = waitForReady(wiring.registry, attached.ledger, {
      ownerId: "root",
      levelKey: "L",
    });
    station.childSpawnPort()(specFor("f3"));
    await waiting;
    const outcome = outcomeOf(wiring.registry, "f3");
    expect(outcome.failed).toBe(true);
    expect(outcome.reason).toContain("no sdk");
  });

  test("a non-clean stop reason counts as failed", async () => {
    const wiring = createForkWiring();
    const station = stationOf();
    const attached = attachForkPorts(station, wiring, {
      conversationKey: "c",
      createSession: async () => ({
        ok: true,
        session: sessionOf("stopped early", { stopReason: "aborted" }),
      }),
    });
    registerFork(attached.ledger, {
      forkId: "f4",
      ownerId: "root",
      levelKey: "L",
      intent: "probe",
      depth: 0,
    });
    const waiting = waitForReady(wiring.registry, attached.ledger, {
      ownerId: "root",
      levelKey: "L",
    });
    station.childSpawnPort()(specFor("f4"));
    await waiting;
    const outcome = outcomeOf(wiring.registry, "f4");
    expect(outcome.failed).toBe(true);
    expect(outcome.reason).toContain("aborted");
  });

  test("two children keep separate outcomes", async () => {
    const wiring = createForkWiring();
    const station = stationOf();
    const attached = attachForkPorts(station, wiring, {
      conversationKey: "c",
      createSession: async (spec) => ({
        ok: true,
        session: sessionOf(`record ${spec.forkId}`),
      }),
    });
    registerFork(attached.ledger, { forkId: "a", ownerId: "root", levelKey: "L", intent: "a", depth: 0 });
    registerFork(attached.ledger, { forkId: "b", ownerId: "root", levelKey: "L", intent: "b", depth: 0 });
    const spawn = station.childSpawnPort();
    spawn(specFor("a"));
    spawn(specFor("b"));
    const first = await waitForReady(wiring.registry, attached.ledger, {
      ownerId: "root",
      levelKey: "L",
    });
    const second = await waitForReady(wiring.registry, attached.ledger, {
      ownerId: "root",
      levelKey: "L",
    });
    expect([first.fork.forkId, second.fork.forkId].sort()).toEqual(["a", "b"]);
    expect(outcomeOf(wiring.registry, "a").record).toBe("record a");
    expect(outcomeOf(wiring.registry, "b").record).toBe("record b");
  });

  test("a child identity carries its fork facts and creates no second account", () => {
    const wiring = createForkWiring();
    const station = stationOf();
    const identity = {
      forkId: "c9",
      parentOwnerId: "root",
      intent: "read the parser",
      budget: { read: 2 },
      time: 90,
      permission: "ro",
    };
    attachForkPorts(station, wiring, { conversationKey: "c", identity });
    const readBack = station.forkIdentityPort();
    expect(readBack).toBe(identity);
    expect(readBack.forkId).toBe("c9");
    // The fork record owns the budget; reading identity twice creates nothing.
    expect(station.state.scopes).toBeUndefined();
  });

  test("derives ownership and depth from the child identity", () => {
    const wiring = createForkWiring();
    const child = stationOf();
    attachForkPorts(child, wiring, {
      conversationKey: "c",
      identity: { forkId: "child-1", parentOwnerId: "root", childDepth: 1 },
    });
    expect(child.forkOwnerId()).toBe("child-1");
    expect(child.forkDepthPort()).toBe(1);
    const root = stationOf();
    attachForkPorts(root, wiring, { conversationKey: "c" });
    expect(root.forkOwnerId()).toBeNull();
    expect(root.forkDepthPort()).toBe(0);
  });

  test("one session id yields one ledger across stations", () => {
    const wiring = createForkWiring();
    const first = stationOf();
    const second = stationOf();
    // Two managers, as a parent and a forked child have two manager objects,
    // but one shared session id.
    const a = attachForkPorts(first, wiring, {
      conversationKey: conversationKeyOf({ getSessionId: () => "s-1" }),
    });
    const b = attachForkPorts(second, wiring, {
      conversationKey: conversationKeyOf({ getSessionId: () => "s-1" }),
    });
    expect(a.ledger).toBe(b.ledger);
    expect(first.forkLedgerPort()).toBe(second.forkLedgerPort());
  });

  test("different sessions keep separate ledgers", () => {
    const wiring = createForkWiring();
    const first = stationOf();
    const second = stationOf();
    const a = attachForkPorts(first, wiring, {
      conversationKey: conversationKeyOf({ getSessionId: () => "s-1" }),
    });
    const b = attachForkPorts(second, wiring, {
      conversationKey: conversationKeyOf({ getSessionId: () => "s-2" }),
    });
    expect(a.ledger).not.toBe(b.ledger);
  });

  test("a spawned child binds its host agent id to the fork", async () => {
    const wiring = createForkWiring();
    const station = stationOf();
    const messages = [];
    attachForkPorts(station, wiring, {
      conversationKey: "c",
      createSession: async () => ({
        ok: true,
        session: {
          prompt: async () => messages.push(assistant("done")),
          agent: {
            id: "agent-child-9",
            state: { messages, stopReason: "stop" },
          },
        },
      }),
    });
    registerFork(station.forkLedgerPort(), {
      forkId: "f9",
      ownerId: "root",
      levelKey: "L",
      intent: "identity",
      depth: 0,
    });
    station.childSpawnPort()(specFor("f9"));
    // The ticket is not awaited by the spawner, so wait for the record.
    const taken = await waitForReady(wiring.registry, station.forkLedgerPort(), {
      ownerId: "root",
      levelKey: "L",
    });
    expect(taken.fork.forkId).toBe("f9");
    const { identityForAgent } = await import("../src/host/fork-registry.mjs");
    const identity = identityForAgent(wiring.registry, "agent-child-9");
    expect(identity?.forkId).toBe("f9");
    expect(identity?.parentOwnerId).toBe("root");
  });

  test("a slow child leaves the join parked until it finishes", async () => {
    const wiring = createForkWiring();
    const station = stationOf();
    let release = null;
    const messages = [];
    const attached = attachForkPorts(station, wiring, {
      conversationKey: "c",
      createSession: async () => ({
        ok: true,
        session: {
          prompt: () =>
            new Promise((resolve) => {
              release = () => {
                messages.push(assistant("late"));
                resolve();
              };
            }),
          agent: { state: { messages, stopReason: "stop" } },
        },
      }),
    });
    registerFork(attached.ledger, {
      forkId: "slow",
      ownerId: "root",
      levelKey: "L",
      intent: "slow",
      depth: 0,
    });
    const waiting = waitForReady(wiring.registry, attached.ledger, {
      ownerId: "root",
      levelKey: "L",
    });
    station.childSpawnPort()(specFor("slow"));
    const early = await Promise.race([
      waiting.then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 5)),
    ]);
    expect(early).toBe("waiting");
    release();
    const taken = await waiting;
    expect(taken.fork.forkId).toBe("slow");
    expect(outcomeOf(wiring.registry, "slow").record).toBe("late");
  });

  test("the identity port round-trips a child identity", () => {
    const wiring = createForkWiring();
    const station = stationOf();
    attachForkPorts(station, wiring, {
      conversationKey: "c",
      identity: { forkId: "f1", parentOwnerId: "root", ownScopeId: "scope-9" },
    });
    expect(station.forkIdentityPort()).toEqual({
      forkId: "f1",
      parentOwnerId: "root",
      ownScopeId: "scope-9",
    });
  });

  test("the ledger port is stable across repeated reads", () => {
    const wiring = createForkWiring();
    const station = stationOf();
    attachForkPorts(station, wiring, { conversationKey: "same" });
    expect(station.forkLedgerPort()).toBe(station.forkLedgerPort());
  });
});

describe("child identity table", () => {
  test("an identity written before the spawn is visible by fork id", async () => {
    const {
      createForkRegistry,
      identityForAgent,
      identityOf,
      setIdentity,
    } = await import("../src/host/fork-registry.mjs");
    const registry = createForkRegistry();
    expect(setIdentity(registry, "f1", {
      parentOwnerId: "root",
      ownScopeId: "scope-7",
      agentId: "agent-7",
    })).toBe(true);
    expect(identityOf(registry, "f1")).toMatchObject({
      forkId: "f1",
      parentOwnerId: "root",
      ownScopeId: "scope-7",
    });
    expect(identityForAgent(registry, "agent-7")).toEqual(identityOf(registry, "f1"));
    expect(identityForAgent(registry, "unknown")).toBeNull();
  });

  test("two forks never overwrite each other's identity", async () => {
    const { createForkRegistry, identityOf, setIdentity } = await import(
      "../src/host/fork-registry.mjs"
    );
    const registry = createForkRegistry();
    setIdentity(registry, "a", { parentOwnerId: "root", agentId: "agent-a" });
    setIdentity(registry, "b", { parentOwnerId: "root", agentId: "agent-b" });
    expect(identityOf(registry, "a").forkId).toBe("a");
    expect(identityOf(registry, "b").forkId).toBe("b");
    expect(identityOf(registry, "ghost")).toBeNull();
  });

  test("clearing one identity leaves the others alone", async () => {
    const {
      clearIdentity,
      createForkRegistry,
      identityForAgent,
      setIdentity,
    } = await import("../src/host/fork-registry.mjs");
    const registry = createForkRegistry();
    setIdentity(registry, "a", { parentOwnerId: "root", agentId: "agent-a" });
    setIdentity(registry, "b", { parentOwnerId: "root", agentId: "agent-b" });
    expect(clearIdentity(registry, "a")).toBe(true);
    expect(identityForAgent(registry, "agent-a")).toBeNull();
    expect(identityForAgent(registry, "agent-b").forkId).toBe("b");
    expect(clearIdentity(registry, "a")).toBe(false);
  });

  test("the spawner records identity before the session exists", async () => {
    const wiring = createForkWiring();
    const station = stationOf();
    const seen = [];
    // The recorder runs inside createSession, so it needs the reader here
    // rather than in an enclosing scope.
    const { identityOf } = await import("../src/host/fork-registry.mjs");
    const attached = attachForkPorts(station, wiring, {
      conversationKey: "c",
      createSession: async (spec) => {
        seen.push(identityOf(wiring.registry, spec.forkId));
        return { ok: true, session: sessionOf("done") };
      },
    });
    registerFork(attached.ledger, {
      forkId: "f-ident",
      ownerId: "root",
      levelKey: "L",
      intent: "x",
      depth: 0,
    });
    station.childSpawnPort()({
      ...specFor("f-ident"),
      ownScopeId: "scope-3",
      agentId: "agent-3",
    });
    await waitForReady(wiring.registry, attached.ledger, { ownerId: "root", levelKey: "L" });
    expect(seen[0]).toMatchObject({
      forkId: "f-ident",
      parentOwnerId: "root",
      ownScopeId: "scope-3",
    });
  });

  test("a child station assembled during createSession already resolves its identity", async () => {
    const wiring = createForkWiring();
    const station = stationOf();
    let seenAtAssembly = null;
    const { identityForAgent } = await import("../src/host/fork-registry.mjs");
    attachForkPorts(station, wiring, {
      conversationKey: "c",
      createSession: async (spec) => {
        seenAtAssembly = identityForAgent(wiring.registry, spec.agentId);
        expect(spec.agentId).toMatch(/^fork-[a-f0-9-]+$/);
        return { ok: true, session: sessionOf("done") };
      },
    });
    const providerId = "call_42497d4f7b854b0581fdc0625ef1bdb5|fc_0f4ee638e46ccacf016b018e1f629487d29f4b7a0f3cd5e6d1";
    registerFork(station.forkLedgerPort(), {
      forkId: providerId,
      ownerId: "root",
      levelKey: "L",
      intent: "early identity",
      depth: 0,
    });
    station.childSpawnPort()(specFor(providerId));
    await waitForReady(wiring.registry, station.forkLedgerPort(), {
      ownerId: "root",
      levelKey: "L",
    });
    expect(seenAtAssembly).not.toBeNull();
    expect(seenAtAssembly.forkId).toBe(providerId);
    expect(seenAtAssembly.parentOwnerId).toBe("root");
  });
});

describe("ledger sharing across stations", () => {
  const pi = { on() {}, registerTool() {}, registerCommand() {} };
  const tickets = { steer: () => {}, canSteer: false, activateTools: () => undefined };

  test("two stations of one conversation share one ledger", async () => {
    const { SessionStation } = await import("../src/station/station.mjs");
    const { createForkWiring } = await import("../src/host/fork-wiring.mjs");
    const wiring = createForkWiring();
    const registry = { forkWiring: () => wiring, ports: () => ({}) };
    const manager = { getSessionId: () => "conversation-1" };
    const first = new SessionStation(manager, pi, tickets, registry, null);
    const second = new SessionStation(manager, pi, tickets, registry, null);
    expect(first.brackets).toBe(second.brackets);
    // The key is the shared session id, not the manager object: a forked child
    // holds a different manager proxy and must still land on this ledger.
    expect(first.brackets).toBe(
      ledgerFor(wiring.registry, conversationKeyOf(manager)),
    );
  });

  test("two conversations never share a ledger", async () => {
    const { SessionStation } = await import("../src/station/station.mjs");
    const { createForkWiring } = await import("../src/host/fork-wiring.mjs");
    const wiring = createForkWiring();
    const registry = { forkWiring: () => wiring, ports: () => ({}) };
    const one = { getSessionId: () => "conversation-1" };
    const two = { getSessionId: () => "conversation-2" };
    const a = new SessionStation(one, pi, tickets, registry, null);
    const b = new SessionStation(two, pi, tickets, registry, null);
    expect(a.brackets).not.toBe(b.brackets);
  });

  test("a station without a fork wiring keeps its own ledger", async () => {
    const { SessionStation } = await import("../src/station/station.mjs");
    const manager = { getSessionId: () => "solo" };
    const plain = new SessionStation(manager, pi, tickets, null, null);
    const other = new SessionStation(manager, pi, tickets, null, null);
    expect(plain.brackets).not.toBe(other.brackets);
  });

  test("a shared ledger carries a fork registered by one station to the other", async () => {
    const { SessionStation } = await import("../src/station/station.mjs");
    const { createForkWiring } = await import("../src/host/fork-wiring.mjs");
    const wiring = createForkWiring();
    const registry = { forkWiring: () => wiring, ports: () => ({}) };
    const manager = { getSessionId: () => "conversation-3" };
    const parent = new SessionStation(manager, pi, tickets, registry, null);
    const child = new SessionStation(manager, pi, tickets, registry, null);
    registerFork(parent.brackets, {
      forkId: "f-shared",
      ownerId: "root",
      levelKey: "L",
      intent: "shared",
      depth: 0,
    });
    expect(child.brackets.forks["f-shared"]).toBeDefined();
    expect(child.brackets.queues.root ?? []).toEqual([]);
    expect(child.brackets.forks["f-shared"].status).toBe("running");
  });
});

describe("child identities", () => {
  test("an identity is visible before the spawn and keyed by fork", async () => {
    const { createForkRegistry, identityOf, identityForAgent, setIdentity } = await import(
      "../src/host/fork-registry.mjs"
    );
    const registry = createForkRegistry();
    setIdentity(registry, "f1", {
      parentOwnerId: "root",
      ownScopeId: "scope-1",
      agentId: "agent-child-1",
    });
    expect(identityOf(registry, "f1")).toMatchObject({
      forkId: "f1",
      parentOwnerId: "root",
      ownScopeId: "scope-1",
    });
    expect(identityForAgent(registry, "agent-child-1").forkId).toBe("f1");
    expect(identityForAgent(registry, "someone-else")).toBeNull();
    expect(identityOf(registry, "ghost")).toBeNull();
  });

  test("two children keep separate identities", async () => {
    const { createForkRegistry, identityForAgent, identityOf, setIdentity } = await import(
      "../src/host/fork-registry.mjs"
    );
    const registry = createForkRegistry();
    setIdentity(registry, "a", { parentOwnerId: "root", ownScopeId: "s-a", agentId: "ag-a" });
    setIdentity(registry, "b", { parentOwnerId: "root", ownScopeId: "s-b", agentId: "ag-b" });
    expect(identityOf(registry, "a").ownScopeId).toBe("s-a");
    expect(identityOf(registry, "b").ownScopeId).toBe("s-b");
    expect(identityForAgent(registry, "ag-a").forkId).toBe("a");
    expect(identityForAgent(registry, "ag-b").forkId).toBe("b");
  });

  test("clearing an identity also clears its agent handle", async () => {
    const { clearIdentity, createForkRegistry, identityForAgent, setIdentity } = await import(
      "../src/host/fork-registry.mjs"
    );
    const registry = createForkRegistry();
    setIdentity(registry, "f9", { parentOwnerId: "root", ownScopeId: "s", agentId: "ag-9" });
    expect(clearIdentity(registry, "f9")).toBe(true);
    expect(identityForAgent(registry, "ag-9")).toBeNull();
    expect(clearIdentity(registry, "f9")).toBe(false);
  });

  test("a spawn records the identity before calling createSession", async () => {
    const wiring = createForkWiring();
    const station = stationOf();
    let seenAtAssembly = null;
    const { identityOf } = await import("../src/host/fork-registry.mjs");
    attachForkPorts(station, wiring, {
      conversationKey: "c",
      createSession: async (spec) => {
        seenAtAssembly = identityOf(wiring.registry, spec.forkId);
        return { ok: true, session: sessionOf("done") };
      },
    });
    registerFork(station.forkLedgerPort(), {
      forkId: "pre",
      ownerId: "root",
      levelKey: "L",
      intent: "x",
      depth: 0,
    });
    station.childSpawnPort()({ ...specFor("pre"), parentOwnerId: "root" });
    await waitForReady(wiring.registry, station.forkLedgerPort(), {
      ownerId: "root",
      levelKey: "L",
    });
    expect(seenAtAssembly).not.toBeNull();
    expect(seenAtAssembly.forkId).toBe("pre");
    expect(seenAtAssembly.parentOwnerId).toBe("root");
  });
});

describe("spawnChildTicket directly", () => {
  test("attaches the child display before the first prompt and detaches at the end", async () => {
    const wiring = createForkWiring();
    const ledger = ledgerFor(wiring.registry, "display");
    registerFork(ledger, { forkId: "disp", ownerId: "root", levelKey: "L", intent: "x", depth: 0 });
    const calls = [];
    const display = {
      attach(flowId, source) {
        calls.push(`attach:${flowId}:${typeof source.prompt}`);
        return () => calls.push(`detach:${flowId}`);
      },
    };
    const result = await spawnChildTicket(specFor("disp"), {
      registry: wiring.registry,
      ledger,
      display,
      createSession: async () => ({ ok: true, session: sessionOf("done") }),
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["attach:Scope 1:function", "detach:Scope 1"]);
  });

  test("reads a host that keeps the child messages on the session", async () => {
    const wiring = createForkWiring();
    const ledger = ledgerFor(wiring.registry, "shape");
    registerFork(ledger, { forkId: "shape", ownerId: "root", levelKey: "L", intent: "x", depth: 0 });
    const messages = [];
    const session = {
      messages,
      prompt: async () => messages.push(assistant("session-shaped")),
    };
    const result = await spawnChildTicket(specFor("shape"), {
      registry: wiring.registry,
      ledger,
      createSession: async () => ({ ok: true, session }),
    });
    expect(result.ok).toBe(true);
    expect(result.failed).toBe(false);
    expect(outcomeOf(wiring.registry, "shape").record).toContain("session-shaped");
  });

  test("an empty child turn is reported as a failure, not a blank success", async () => {
    const wiring = createForkWiring();
    const ledger = ledgerFor(wiring.registry, "empty");
    registerFork(ledger, { forkId: "empty", ownerId: "root", levelKey: "L", intent: "x", depth: 0 });
    const result = await spawnChildTicket(specFor("empty"), {
      registry: wiring.registry,
      ledger,
      createSession: async () => ({
        ok: true,
        session: { prompt: async () => {}, agent: { state: { messages: [] } } },
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.failed).toBe(true);
    expect(result.reason).toContain("produced no messages");
    expect(outcomeOf(wiring.registry, "empty").failed).toBe(true);
  });

  test("a display attach failure does not fail the child", async () => {
    const wiring = createForkWiring();
    const ledger = ledgerFor(wiring.registry, "display-fail");
    registerFork(ledger, { forkId: "display-fail", ownerId: "root", levelKey: "L", intent: "x", depth: 0 });
    const display = {
      attach() {
        throw new Error("no subscribe");
      },
    };
    const result = await spawnChildTicket(specFor("display-fail"), {
      registry: wiring.registry,
      ledger,
      display,
      createSession: async () => ({ ok: true, session: sessionOf("still done") }),
    });
    expect(result.ok).toBe(true);
    expect(result.failed).toBe(false);
    expect(outcomeOf(wiring.registry, "display-fail").record).toContain("still done");
  });

  test("prepares the child context before the first prompt", async () => {
    const wiring = createForkWiring();
    const ledger = ledgerFor(wiring.registry, "prepare");
    registerFork(ledger, { forkId: "prepare", ownerId: "root", levelKey: "L", intent: "x", depth: 0 });
    const calls = [];
    const session = {
      prompt: async () => calls.push("prompt"),
      agent: { state: { messages: [] } },
    };
    const result = await spawnChildTicket(specFor("prepare"), {
      registry: wiring.registry,
      ledger,
      prepareChild: () => {
        calls.push("prepare");
        return { ok: true };
      },
      createSession: async () => ({ ok: true, session }),
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["prepare", "prompt"]);
  });

  test("a child context preparation refusal does not fail the child", async () => {
    const wiring = createForkWiring();
    const ledger = ledgerFor(wiring.registry, "prepare-fail");
    registerFork(ledger, { forkId: "prepare-fail", ownerId: "root", levelKey: "L", intent: "x", depth: 0 });
    const result = await spawnChildTicket(specFor("prepare-fail"), {
      registry: wiring.registry,
      ledger,
      prepareChild: () => ({ ok: false, code: "NO_CONTEXT" }),
      createSession: async () => ({ ok: true, session: sessionOf("prepared anyway") }),
    });

    expect(result.ok).toBe(true);
    expect(result.failed).toBe(false);
    expect(outcomeOf(wiring.registry, "prepare-fail").record).toContain("prepared anyway");
  });

  test("returns ok with the failed flag instead of throwing", async () => {
    const wiring = createForkWiring();
    const ledger = ledgerFor(wiring.registry, "direct");
    registerFork(ledger, { forkId: "d1", ownerId: "root", levelKey: "L", intent: "x", depth: 0 });
    const result = await spawnChildTicket(specFor("d1"), {
      registry: wiring.registry,
      ledger,
      createSession: async () => {
        throw new Error("assembly failed");
      },
    });
    expect(result.ok).toBe(true);
    expect(result.failed).toBe(true);
    expect(result.reason).toContain("assembly failed");
    expect(outcomeOf(wiring.registry, "d1").failed).toBe(true);
  });

  test("leaves the fork running until the parent takes it", async () => {
    const wiring = createForkWiring();
    const ledger = ledgerFor(wiring.registry, "direct2");
    registerFork(ledger, { forkId: "d2", ownerId: "root", levelKey: "L", intent: "x", depth: 0 });
    await spawnChildTicket(specFor("d2"), {
      registry: wiring.registry,
      ledger,
      createSession: async () => ({ ok: true, session: sessionOf("done") }),
    });
    // The child returned: ready, not joined. Only the parent closes it.
    expect(outcomeOf(wiring.registry, "d2").record).toBe("done");
    expect(ledger.forks.d2.status).not.toBe(RUNNING);
    const taken = await waitForReady(wiring.registry, ledger, { ownerId: "root", levelKey: "L" });
    expect(taken.fork.forkId).toBe("d2");
  });

  test("a record frozen by scope_return is never overwritten by the spawner", async () => {
    const wiring = createForkWiring();
    const ledger = ledgerFor(wiring.registry, "direct3");
    registerFork(ledger, { forkId: "d3", ownerId: "root", levelKey: "L", intent: "x", depth: 0 });
    // The child returned first and wrote its own record.
    const { setOutcome } = await import("../src/host/fork-registry.mjs");
    setOutcome(wiring.registry, "d3", {
      record: "the child's own record",
      failed: false,
      reason: null,
    });
    await spawnChildTicket(specFor("d3"), {
      registry: wiring.registry,
      ledger,
      createSession: async () => ({ ok: true, session: sessionOf("the spawner's later copy") }),
    });
    // The parent must read what the child froze, not a different rendering.
    expect(outcomeOf(wiring.registry, "d3").record).toBe("the child's own record");
  });
});

describe("bracket ledger sharing", () => {
  function registryWith(wiring) {
    return {
      forkWiring: () => wiring,
      ports: () => ({}),
    };
  }

  function managerOf(id) {
    return { getSessionId: () => id };
  }

  async function station(manager, registry) {
    const { SessionStation } = await import("../src/station/station.mjs");
    return new SessionStation(manager, {}, {}, registry, null);
  }

  test("two stations of one conversation share the ledger", async () => {
    const wiring = createForkWiring();
    const registry = registryWith(wiring);
    const manager = managerOf("A");
    const first = await station(manager, registry);
    const second = await station(manager, registry);
    expect(first.brackets).toBe(second.brackets);
  });

  test("the station ledger is the registry ledger for that manager", async () => {
    const wiring = createForkWiring();
    const registry = registryWith(wiring);
    const manager = managerOf("A");
    const built = await station(manager, registry);
    expect(built.brackets).toBe(
      ledgerFor(wiring.registry, conversationKeyOf(manager)),
    );
  });

  test("two conversations keep separate ledgers", async () => {
    const wiring = createForkWiring();
    const registry = registryWith(wiring);
    const a = await station(managerOf("A"), registry);
    const b = await station(managerOf("B"), registry);
    expect(a.brackets).not.toBe(b.brackets);
  });

  test("a station with no registry falls back to its own ledger", async () => {
    const manager = managerOf("Z");
    const first = await station(manager, null);
    const second = await station(manager, null);
    expect(first.brackets).not.toBe(second.brackets);
  });

  test("the ledger survives a fresh station of the same conversation", async () => {
    const wiring = createForkWiring();
    const registry = registryWith(wiring);
    const manager = managerOf("A");
    const first = await station(manager, registry);
    first.brackets.forks.f1 = { forkId: "f1" };
    const rebuilt = await station(manager, registry);
    expect(rebuilt.brackets.forks.f1).toEqual({ forkId: "f1" });
  });
});
