// The spawn chain: a station's scope_fork reaches a real branch session and
// that child's first request.
//
// The neighbouring suites stop on one side of this seam. fork-wiring uses a
// fake session factory, so it cannot see a createBranchSession refusal.
// branch-session builds the real factory, but never from a station, so it
// cannot see a missing agent id, a lost receipt, or a source frame that the
// host never wrote. A regression here is a fork that opens, answers
// "started", and never prompts a child — the parent then waits forever.

import { describe, expect, test } from "bun:test";

import { createBranchSession } from "../host-omp/src/host/branch-session.mjs";
import { createForkWiring } from "../src/wiring/fork-wiring.mjs";
import { SessionStation } from "../src/station/station.mjs";
import { attachForkPorts } from "./helpers/fork-attach.mjs";
import { bindStationPorts } from "./helpers/station-ports.mjs";
import {
  forkOf,
  markReady,
  RUNNING,
} from "../src/scope/forkjoin.mjs";
import {
  identityForAgent,
  outcomeOf,
  setOutcome,
  waitForReady,
} from "../src/scope/fork-registry.mjs";
import { handleForkCall } from "../src/station/fork-controls.mjs";

const AGENT_REGISTRY = { kind: "agentRegistry" };

/** A shared journal with the leaf contract createBranchSession proxies. */
function sharedManager() {
  const entries = new Map();
  let leaf = null;
  return {
    getSessionId: () => "session-1",
    getCwd: () => "/workspace",
    getHeader: () => ({ taskPromptCacheKey: "task-cache" }),
    getArtifactsDir: () => "/artifacts",
    getLeafId: () => leaf,
    getEntry: (id) => entries.get(id),
    getBranch(from = leaf) {
      const path = [];
      for (let id = from; id != null; id = entries.get(id).parentId) {
        path.unshift(entries.get(id));
      }
      return path;
    },
    branch(id) {
      leaf = id;
    },
    resetLeaf() {
      leaf = null;
    },
    seal() {},
    close() {},
    appendMessageToBranch(message, parentId) {
      const id = `entry-${entries.size}`;
      entries.set(id, { type: "message", id, parentId, message });
      return id;
    },
  };
}

/** The owner facts deriveBranchConfig requires, with no host attached. */
function ownerSession() {
  return {
    asyncJobManager: { kind: "asyncJobManager" },
    costGate: { kind: "costGate" },
    model: { id: "model-1" },
    modelRegistry: { authStorage: { kind: "authStorage" } },
    sessionId: "session-1",
    settings: { kind: "settings" },
    systemPrompt: ["owner prompt"],
    preparedExtensions: [{ name: "prepared-extension" }],
    extensionPaths: ["/extensions/base.mjs"],
    agent: { promptCacheKey: "agent-cache", thinkingLevel: "high" },
    getEnabledToolNames: () => ["read", "scope_fork"],
    getActiveToolNames: () => ["read", "scope_fork"],
    getMountedToolCommandNames: () => ["read"],
  };
}

function forkCall(id = "fork-call") {
  return {
    id,
    arguments: {
      forks: [
        {
          path: "/parser",
          fsm: "read the parser",
          profession: "You are a careful parser reader like Ada Lovelace.",
          budget: { read: 1 },
          time: 60,
          targets: ["src/parser.mjs"],
        },
      ],
    },
  };
}

function spawnStation(shared, wiring, extra = {}) {
  const station = Object.create(SessionStation.prototype);
  station.state = { relay: { generation: 0, fullFlow: false }, epoch: 0 };
  station.manager = shared;
  station.persist = () => {};
  station.ports = bindStationPorts(station.state);
  Object.assign(station, extra);
  return station;
}

describe("scope_fork through a real branch session", () => {
  test("prompts the child receipt and publishes the record", async () => {
    const wiring = createForkWiring();
    const shared = sharedManager();
    const rootTip = shared.appendMessageToBranch(
      { role: "user", content: "root work" },
      null,
    );
    shared.branch(rootTip);
    // The live assistant batch that carries the fork call. createBranchSession
    // must cut the child's branch before this whole batch: seeding the flow at
    // the live leaf makes the SDK treat the parent's own call as a crashed
    // turn.
    const forkFrame = shared.appendMessageToBranch(
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "fork-call", name: "scope_fork", arguments: {} },
        ],
      },
      rootTip,
    );
    shared.branch(forkFrame);

    const prompted = [];
    let branchResult = null;
    const station = spawnStation(shared, wiring);
    const attached = attachForkPorts(station, wiring, {
      conversationKey: "session:parent",
      ownerSession: ownerSession(),
      createSession: (spec) =>
        createBranchSession({
          session: spec.ownerSession,
          sessionManager: spec.manager ?? spec.sessionManager,
          flowId: spec.agentId,
          sourceToolCallId: spec.sourceToolCallId,
          agentDisplayName: "Parser",
          agentRegistry: AGENT_REGISTRY,
          model: spec.modelOverride,
          thinkingLevel: spec.thinkingLevel,
          async createAgentSession(config) {
            const messages = [];
            return {
              session: {
                agent: {
                  id: config.agentId,
                  state: { messages, stopReason: "stop" },
                },
                async prompt(text) {
                  prompted.push(text);
                  // Append through the flow's own manager, as the host turn
                  // does. The shared leaf must not move.
                  config.sessionManager.appendMessage({ role: "user", content: text });
                  messages.push({ role: "user", content: text, timestamp: 1 });
                  const answer = {
                    role: "assistant",
                    content: [{ type: "text", text: "the parser reads cleanly" }],
                  };
                  config.sessionManager.appendMessage(answer);
                  messages.push({ ...answer, timestamp: 2 });
                  // The child's own scope_return closes the bracket before the
                  // parent can take it, exactly as the real tool does.
                  setOutcome(wiring.registry, spec.forkId, {
                    record: "the parser reads cleanly",
                    failed: false,
                  });
                  markReady(attached.ledger, spec.forkId, {
                    ok: true,
                    record: "the parser reads cleanly",
                  });
                },
              },
            };
          },
        }).then((result) => {
          branchResult = result;
          return result;
        }),
    });

    const result = handleForkCall(station, forkCall());
    const fork = forkOf(attached.ledger, "fork-call");
    // The receipt is returned in this beat, so the bracket exists before the
    // child session does.
    expect(fork).not.toBeNull();
    expect(fork.status).toBe(RUNNING);
    expect(result).toBeTruthy();

    const taken = await waitForReady(wiring.registry, attached.ledger, {
      ownerId: "root",
      levelKey: fork.levelKey,
    });

    // The wiring survived the real factory, not a double.
    expect(taken.fork.forkId).toBe("fork-call");
    expect(branchResult.ok).toBe(true);
    expect(branchResult.config.agentId).toMatch(/^fork-/);
    // A per-flow proxy writes a branch; the shared journal is not handed back.
    expect(branchResult.config.sessionManager).not.toBe(shared);

    // The child's first request is the receipt, exactly once: no nudge, no
    // empty prompt, and the facts the child needs to know who it is.
    expect(prompted).toHaveLength(1);
    expect(prompted[0].startsWith("You are now in the scope /parser,")).toBe(true);
    expect(prompted[0]).toContain("read the parser");
    expect(prompted[0]).toContain("read 1");
    expect(prompted[0]).toContain("Targets: src/parser.mjs");

    // The host id is bound to the fork, which is how the child's own station
    // resolves scope_return. Without this the child is nobody's child.
    expect(identityForAgent(wiring.registry, branchResult.config.agentId)?.forkId).toBe(
      "fork-call",
    );

    // The branch starts before the live fork batch and carries the work.
    const childBranch = branchResult.config.sessionManager.getBranch();
    expect(childBranch.some((entry) => entry.id === forkFrame)).toBe(false);
    expect(childBranch.at(-1).message.content).toEqual([
      { type: "text", text: "the parser reads cleanly" },
    ]);
    // A child append never moves the parent's leaf.
    expect(shared.getLeafId()).toBe(forkFrame);

    expect(outcomeOf(wiring.registry, "fork-call").record).toContain(
      "the parser reads cleanly",
    );
  });

  test("a factory refusal fails the bracket and wakes the join", async () => {
    const wiring = createForkWiring();
    const shared = sharedManager();
    const rootTip = shared.appendMessageToBranch(
      { role: "user", content: "root work" },
      null,
    );
    shared.branch(rootTip);
    // No assistant frame carries the fork call, so createBranchSession refuses
    // with NO_FORK_FRAME. A started fork that cannot build its session must
    // not stay running: the parent would wait for a child that never exists.
    const station = spawnStation(shared, wiring);
    const attached = attachForkPorts(station, wiring, {
      conversationKey: "session:missing-frame",
      ownerSession: ownerSession(),
      createSession: (spec) =>
        createBranchSession({
          session: spec.ownerSession,
          sessionManager: spec.manager ?? spec.sessionManager,
          flowId: spec.agentId,
          sourceToolCallId: spec.sourceToolCallId,
          agentRegistry: AGENT_REGISTRY,
          async createAgentSession() {
            throw new Error("must not reach the host factory");
          },
        }),
    });

    handleForkCall(station, forkCall("fork-call-2"));
    const fork = forkOf(attached.ledger, "fork-call-2");
    expect(fork.status).toBe(RUNNING);

    const taken = await waitForReady(wiring.registry, attached.ledger, {
      ownerId: "root",
      levelKey: fork.levelKey,
    });

    expect(taken.fork.forkId).toBe("fork-call-2");
    const outcome = outcomeOf(wiring.registry, "fork-call-2");
    expect(outcome.failed).toBe(true);
    expect(outcome.reason.startsWith("NO_FORK_FRAME: ")).toBe(true);
    expect(outcome.record).toBe("");
    expect(taken.fork.status).not.toBe(RUNNING);
  });

  test("a rejected first prompt fails the bracket and wakes the join", async () => {
    const wiring = createForkWiring();
    const shared = sharedManager();
    const rootTip = shared.appendMessageToBranch(
      { role: "user", content: "root work" },
      null,
    );
    shared.branch(rootTip);
    // A complete fork frame lets the real factory build the session, so the
    // only failure under test is the provider rejecting the first turn.
    const forkFrame = shared.appendMessageToBranch(
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "fork-call-3", name: "scope_fork", arguments: {} },
        ],
      },
      rootTip,
    );
    shared.branch(forkFrame);

    const prompted = [];
    let persisted = 0;
    const station = spawnStation(shared, wiring, {
      persist: () => {
        persisted += 1;
      },
    });
    const attached = attachForkPorts(station, wiring, {
      conversationKey: "session:prompt-rejects",
      ownerSession: ownerSession(),
      createSession: (spec) =>
        createBranchSession({
          session: spec.ownerSession,
          sessionManager: spec.manager ?? spec.sessionManager,
          flowId: spec.agentId,
          sourceToolCallId: spec.sourceToolCallId,
          agentRegistry: AGENT_REGISTRY,
          model: spec.modelOverride,
          thinkingLevel: spec.thinkingLevel,
          async createAgentSession(config) {
            return {
              session: {
                agent: { id: config.agentId },
                async prompt(text) {
                  prompted.push(text);
                  throw new Error("provider rejected the turn");
                },
              },
            };
          },
        }),
    });

    handleForkCall(station, forkCall("fork-call-3"));
    const fork = forkOf(attached.ledger, "fork-call-3");
    expect(fork.status).toBe(RUNNING);

    const taken = await waitForReady(wiring.registry, attached.ledger, {
      ownerId: "root",
      levelKey: fork.levelKey,
    });

    expect(taken.fork.forkId).toBe("fork-call-3");
    expect(taken.fork.status).not.toBe(RUNNING);
    const outcome = outcomeOf(wiring.registry, "fork-call-3");
    expect(outcome.failed).toBe(true);
    expect(outcome.reason).toBe("provider rejected the turn");
    expect(outcome.record).toBe("");
    // The first prompt failed; the nudge loop must not issue a second one.
    expect(prompted).toHaveLength(1);
    // finish() persists even on failure, so a crash cannot leave the ledger
    // describing a child that is still running.
    expect(persisted).toBeGreaterThanOrEqual(1);
  });

  test("a throwing factory fails the fork and preserves the cause", async () => {
    const wiring = createForkWiring();
    const shared = sharedManager();
    const rootTip = shared.appendMessageToBranch(
      { role: "user", content: "root work" },
      null,
    );
    shared.branch(rootTip);
    // A complete fork frame reaches the host factory. The factory throws, so
    // branch-session refuses with CREATE_FAILED and carries the original error.
    const forkFrame = shared.appendMessageToBranch(
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "fork-call-4", name: "scope_fork", arguments: {} },
        ],
      },
      rootTip,
    );
    shared.branch(forkFrame);

    let prompted = 0;
    let persisted = 0;
    const station = spawnStation(shared, wiring, {
      persist: () => {
        persisted += 1;
      },
    });
    const attached = attachForkPorts(station, wiring, {
      conversationKey: "session:factory-throws",
      ownerSession: ownerSession(),
      createSession: (spec) =>
        createBranchSession({
          session: spec.ownerSession,
          sessionManager: spec.manager ?? spec.sessionManager,
          flowId: spec.agentId,
          sourceToolCallId: spec.sourceToolCallId,
          agentRegistry: AGENT_REGISTRY,
          model: spec.modelOverride,
          thinkingLevel: spec.thinkingLevel,
          async createAgentSession() {
            throw new Error("factory exploded");
          },
        }),
    });

    handleForkCall(station, forkCall("fork-call-4"));
    const fork = forkOf(attached.ledger, "fork-call-4");
    expect(fork.status).toBe(RUNNING);

    const taken = await waitForReady(wiring.registry, attached.ledger, {
      ownerId: "root",
      levelKey: fork.levelKey,
    });

    expect(taken.fork.forkId).toBe("fork-call-4");
    expect(taken.fork.status).not.toBe(RUNNING);
    const outcome = outcomeOf(wiring.registry, "fork-call-4");
    expect(outcome.failed).toBe(true);
    // The refusal code stays readable and the factory's own message survives.
    expect(outcome.reason).toBe("CREATE_FAILED: factory exploded");
    expect(outcome.record).toBe("");
    // No session exists, so no prompt could have been sent.
    expect(prompted).toBe(0);
    expect(persisted).toBeGreaterThanOrEqual(1);
  });
});
