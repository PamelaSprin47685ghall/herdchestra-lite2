// A requirement that arrives while the child works is delivered at the next
// turn boundary. The child has no inbox: it re-reads its ledger record.
import { describe, expect, test } from "bun:test";

import {
  createBracketLedger,
  forkOf,
  markReady,
  registerFork,
} from "../src/scope/forkjoin.mjs";
import { createForkRegistry } from "../src/host/fork-registry.mjs";
import { spawnChildTicket } from "../src/tools/fork-spawn-ticket.mjs";

function harness(returnAfterFirst = false) {
  const ledger = createBracketLedger();
  registerFork(ledger, {
    forkId: "f1",
    scopeId: "worker",
    ownerId: "root",
    intent: "first",
    depth: 0,
    budget: { read: 2 },
    time: 60,
    startedAt: Date.now(),
  });
  const registry = createForkRegistry();
  const prompts = [];
  const session = {
    agent: { id: "agent-1", state: { messages: [] } },
    prompt: async (text) => {
      prompts.push(text);
      if (text.startsWith("Additional requirements") || returnAfterFirst) {
        markReady(ledger, "f1", { record: "done" });
      }
    },
  };
  return {
    ledger,
    prompts,
    ports: { registry, ledger, createSession: async () => ({ ok: true, session }) },
  };
}

describe("requirement delivery", () => {
  test("prompts a queued requirement before the child returns", async () => {
    const { ledger, prompts, ports } = harness();
    const record = forkOf(ledger, "f1");
    record.requirements.push("also check the second file");
    const result = await spawnChildTicket(
      { forkId: "f1", scopeId: "worker", receipt: "You are the child of fork worker", childDepth: 1 },
      ports,
    );
    expect(result.ok).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Additional requirements from your parent:");
    expect(prompts[1]).toContain("also check the second file");
    expect(record.requirementsDelivered).toBe(1);
  });

  test("does not repeat a delivered requirement", async () => {
    const { ledger, prompts, ports } = harness(true);
    const record = forkOf(ledger, "f1");
    record.requirements.push("one");
    record.requirementsDelivered = 1;
    await spawnChildTicket(
      { forkId: "f1", scopeId: "worker", receipt: "receipt", childDepth: 1 },
      ports,
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("Additional requirements");
  });
});
