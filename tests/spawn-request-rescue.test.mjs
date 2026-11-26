// An interrupted beat is not a dead scope.
//
// `scope_request({ interrupt: true })` aborts the target's current beat to get
// an answer. The spawn loop sees a stop reason of "aborted" and, without a
// guard, would fail the whole child — turning a one-turn question into a lost
// branch. The guard is narrow on purpose: a pending request means the abort was
// that interrupt, so the loop clears the stale reason and drives the reply turn.
// A plain abort still fails the child, which is the control case below.

import { describe, expect, test } from "bun:test";

import {
  RUNNING,
  createBracketLedger,
  forkOf,
  markReady,
  registerFork,
} from "../src/scope/forkjoin.mjs";
import {
  createForkRegistry,
  outcomeOf,
  setOutcome,
} from "../src/scope/fork-registry.mjs";
import {
  enqueueRequest,
  markRequestDelivered,
  resolveRequest,
} from "../src/scope/request-queue.mjs";
import { spawnChildTicket } from "../src/tools/spawn-ticket.mjs";

const RECEIPT = "You are now in the scope /worker,";

function setup() {
  const ledger = createBracketLedger();
  const registered = registerFork(ledger, {
    forkId: "f-live",
    ownerId: "root",
    levelKey: "L0",
    fsm: "answer while interrupted",
    depth: 0,
    budget: { read: 2 },
    profession: "You are a worker.",
  });
  expect(registered.ok).toBe(true);
  registered.fork.path = "/worker";
  return { ledger, registry: createForkRegistry() };
}

/**
 * A session whose first beat is cut short by a request interrupt. The registry
 * is shared with the spawn ticket, so the queue the loop reads is the queue
 * these tests write.
 */
function interruptedSession({ ledger, registry }, { withPendingRequest, onReplyBeat }) {
  const prompts = [];
  const session = {
    agent: { id: "agent-live", state: { messages: [], stopReason: "stop" }, abort() {} },
    async prompt(text) {
      prompts.push(text);
      if (prompts.length === 1) {
        if (withPendingRequest) {
          enqueueRequest(registry, {
            from: "/",
            target: "/worker",
            message: "what is the cache hit rate?",
            interrupt: true,
          });
        }
        // The interrupt landed: the host reports the beat as aborted.
        session.agent.state.stopReason = "aborted";
        return;
      }
      onReplyBeat?.(session);
    },
  };
  return { session, prompts };
}

describe("an aborted beat with a pending request is rescued", () => {
  test("the child answers instead of failing", async () => {
    const context = setup();
    const { session, prompts } = interruptedSession(context, {
      withPendingRequest: true,
      onReplyBeat: (live) => {
        // The reply turn: the question is on screen, so it can be answered.
        markRequestDelivered(context.registry, "/worker");
        resolveRequest(context.registry, "/worker", "0.82");
        setOutcome(context.registry, "f-live", { record: "answered: 0.82", failed: false, reason: null });
        markReady(context.ledger, "f-live", { ok: true, record: "answered: 0.82" });
      },
    });

    const spawned = await spawnChildTicket(
      { forkId: "f-live", receipt: RECEIPT },
      {
        registry: context.registry,
        ledger: context.ledger,
        createSession: async () => ({ ok: true, session }),
      },
    );

    expect(spawned.ok).toBe(true);
    const outcome = outcomeOf(context.registry, "f-live");
    expect(outcome.failed).toBe(false);
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect(forkOf(context.ledger, "f-live").status).not.toBe(RUNNING);
  });

  test("without a pending request the same abort still fails the child", async () => {
    const context = setup();
    const { session, prompts } = interruptedSession(context, { withPendingRequest: false });

    const spawned = await spawnChildTicket(
      { forkId: "f-live", receipt: RECEIPT },
      {
        registry: context.registry,
        ledger: context.ledger,
        createSession: async () => ({ ok: true, session }),
      },
    );

    // One beat only: the loop did not drive a reply turn nobody asked for.
    expect(prompts).toHaveLength(1);
    // The control case proves the guard is conditioned on the pending request
    // and not on the word "aborted" alone: the same abort, with nothing queued,
    // still fails the child.
    const outcome = outcomeOf(context.registry, "f-live");
    expect(outcome.failed).toBe(true);
    expect(outcome.reason).toMatch(/aborted/);
  });
});
