// A request the child never answers must not keep the spawn loop alive.
//
// The loop exited only when no request was pending, so one stuck head made that
// condition false forever: the child stayed busy, the bracket never closed, and
// the parent's join parked. The bound is two wake prompts; after that the
// caller is settled and the loop reaches its stop/nudge path.

import { describe, expect, test } from "bun:test";

import {
  RUNNING,
  createBracketLedger,
  forkOf,
  registerFork,
} from "../src/scope/forkjoin.mjs";
import { createForkRegistry, outcomeOf } from "../src/scope/fork-registry.mjs";
import { enqueueRequest } from "../src/scope/request-queue.mjs";
import { spawnChildTicket } from "../src/tools/spawn-ticket.mjs";

const RECEIPT = "You are now in the scope /worker,";
const WAKE = "A peer scope is waiting";

function setup() {
  const ledger = createBracketLedger();
  const registered = registerFork(ledger, {
    forkId: "f-stuck",
    ownerId: "root",
    levelKey: "L0",
    fsm: "never answers",
    depth: 0,
    budget: { read: 1 },
    profession: "You are a worker.",
  });
  expect(registered.ok).toBe(true);
  registered.fork.path = "/worker";
  return { ledger, registry: createForkRegistry() };
}

describe("a child that never answers a request", () => {
  test("the wake loop is bounded, the caller settles, and the bracket closes", async () => {
    const context = setup();
    const prompts = [];
    const session = {
      agent: { id: "agent-stuck", state: { messages: [], stopReason: "stop" }, abort() {} },
      // Every beat ends normally and never answers the queued request.
      async prompt(text) {
        prompts.push(text);
      },
    };
    const queued = enqueueRequest(context.registry, {
      from: "/",
      target: "/worker",
      message: "are you there?",
    });
    expect(queued.ok).toBe(true);

    // Fail fast: a regression that keeps prompting must not hang the suite.
    const spawned = await Promise.race([
      spawnChildTicket(
        { forkId: "f-stuck", receipt: RECEIPT },
        {
          registry: context.registry,
          ledger: context.ledger,
          createSession: async () => ({ ok: true, session }),
        },
      ),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("the spawn ticket did not terminate")), 2000);
      }),
    ]);

    expect(spawned.ok).toBe(true);
    expect(spawned.failed).toBe(true);
    const wakes = prompts.filter((text) => text.includes(WAKE));
    expect(wakes).toHaveLength(2);
    // One birth receipt, two wake prompts, then the return-nudge allowance:
    // five prompts at most, never a loop.
    expect(prompts.length).toBeLessThanOrEqual(5);
    await expect(queued.promise).rejects.toThrow("the scope did not answer");
    expect(forkOf(context.ledger, "f-stuck").status).not.toBe(RUNNING);
    expect(outcomeOf(context.registry, "f-stuck")?.failed).toBe(true);
  });
});
