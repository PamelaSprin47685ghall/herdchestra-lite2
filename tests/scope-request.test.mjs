// `scope_request` is a question with an answer, not a mailbox.
//
// These cases pin the whole synchronous RPC: the queue that parks the caller,
// the wait graph that refuses a cycle instead of deadlocking a tree, the FIFO
// that gives every request exactly one reply turn, and the two station handlers
// that turn a model call into that round trip.
//
// The point of a test here is the user-visible consequence: a scope that asks
// gets an answer in the same script, and a scope that would wait forever is
// refused at the door.

import { describe, expect, test } from "bun:test";

import { CONTROL_TOOLS } from "../src/scope/state.mjs";
import { isFreeTool } from "../src/scope/turns.mjs";
import {
  createBracketLedger,
  registerFork,
} from "../src/scope/forkjoin.mjs";
import { createForkRegistry } from "../src/scope/fork-registry.mjs";
import {
  cancelRequest,
  currentRequest,
  enqueueRequest,
  forgetScope,
  hasPendingRequests,
  markRequestDelivered,
  pendingRequestCount,
  rejectPendingRequests,
  resolveRequest,
  runtimeTable,
  waitEdgesOf,
  wouldCycle,
} from "../src/scope/request-queue.mjs";
import {
  handleReplyToolCall,
  handleRequestToolCall,
  senderPathOf,
} from "../src/station/request-controls.mjs";

const STATE = {
  scopes: [],
  autopilot: false,
  relay: { generation: 0, fullFlow: false },
};

function ledgerWith(...paths) {
  const ledger = createBracketLedger();
  for (const [index, path] of paths.entries()) {
    const registered = registerFork(ledger, {
      forkId: `f-${index}`,
      ownerId: "root",
      levelKey: "L0",
      fsm: `task ${path}`,
      depth: 0,
      budget: { read: 1 },
      profession: "You are a worker.",
    });
    expect(registered.ok).toBe(true);
    registered.fork.path = path;
  }
  return ledger;
}

/**
 * The station shape the request path reads: a ledger, an identity, the shared
 * registry, and the delivery table derived from it — exactly how the real
 * station exposes the table.
 */
function stationFor(ledger, identity, registry = createForkRegistry()) {
  return {
    state: { ...STATE },
    forkLedgerPort: () => ledger,
    forkIdentityPort: () => identity,
    forkWaitPort: () => ({ registry, ledger }),
    forkRegistry: () => registry,
  };
}

describe("scope_request is a free control tool", () => {
  test("both directions live in CONTROL_TOOLS and spend no turn", () => {
    expect(CONTROL_TOOLS.has("scope_request")).toBe(true);
    expect(CONTROL_TOOLS.has("scope_reply")).toBe(true);
    expect(isFreeTool("scope_request")).toBe(true);
    expect(isFreeTool("scope_reply")).toBe(true);
  });
});

describe("the queue is a FIFO with one reply turn per request", () => {
  test("enqueue parks the caller on a promise and publishes a queue head", async () => {
    const registry = createForkRegistry();
    const queued = enqueueRequest(registry, {
      from: "/api",
      target: "/worker",
      message: "which field carries the token?",
    });
    expect(queued.ok).toBe(true);
    expect(hasPendingRequests(registry, "/worker")).toBe(true);
    expect(pendingRequestCount(registry, "/worker")).toBe(1);

    const head = currentRequest(registry, "/worker");
    expect(head.from).toBe("/api");
    expect(head.message).toBe("which field carries the token?");
    expect(head.delivered).toBe(false);

    // The caller is genuinely parked: no answer yet, so the promise is pending.
    let settled = false;
    queued.promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    markRequestDelivered(registry, "/worker");
    const resolved = resolveRequest(registry, "/worker", "accessToken");
    expect(resolved.ok).toBe(true);
    await expect(queued.promise).resolves.toBe("accessToken");
    expect(currentRequest(registry, "/worker")).toBeNull();
  });

  test("the queue head must be delivered before it can be answered", () => {
    const registry = createForkRegistry();
    enqueueRequest(registry, { from: "/api", target: "/worker", message: "hello" });
    const early = resolveRequest(registry, "/worker", "too soon");
    expect(early.ok).toBe(false);
    expect(early.code).toBe("REQUEST_NOT_DELIVERED");
    // The request is still queued: a speculative answer changes nothing.
    expect(pendingRequestCount(registry, "/worker")).toBe(1);
  });

  test("two requests are answered in arrival order", async () => {
    const registry = createForkRegistry();
    const first = enqueueRequest(registry, { from: "/a", target: "/w", message: "one" });
    const second = enqueueRequest(registry, { from: "/b", target: "/w", message: "two" });
    expect(currentRequest(registry, "/w").id).toBe(first.id);

    markRequestDelivered(registry, "/w");
    resolveRequest(registry, "/w", "answer-one");
    await expect(first.promise).resolves.toBe("answer-one");
    // The second request becomes the head, still undelivered.
    expect(currentRequest(registry, "/w").id).toBe(second.id);
    expect(currentRequest(registry, "/w").delivered).toBe(false);

    markRequestDelivered(registry, "/w");
    resolveRequest(registry, "/w", "answer-two");
    await expect(second.promise).resolves.toBe("answer-two");
    expect(hasPendingRequests(registry, "/w")).toBe(false);
  });
});

describe("a wait cycle is refused at the door", () => {
  test("a scope cannot request itself", () => {
    const registry = createForkRegistry();
    const refused = enqueueRequest(registry, { from: "/api", target: "/api", message: "?" });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("REQUEST_DEADLOCK_CYCLE");
    expect(hasPendingRequests(registry, "/api")).toBe(false);
  });

  test("a transitive cycle is refused, and a clean hop is allowed", async () => {
    const registry = createForkRegistry();
    // /a is already parked on /b: a request from /b to /a would close the loop.
    const parked = enqueueRequest(registry, { from: "/a", target: "/b", message: "first" });
    expect(wouldCycle(registry, "/b", "/a")).toBe(true);
    const refused = enqueueRequest(registry, { from: "/b", target: "/a", message: "second" });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("REQUEST_DEADLOCK_CYCLE");

    // The same edge the other way from an uninvolved scope is fine.
    expect(wouldCycle(registry, "/c", "/a")).toBe(false);

    // Finishing the parked request removes its edge, so the pair is free again.
    markRequestDelivered(registry, "/b");
    resolveRequest(registry, "/b", "done");
    await expect(parked.promise).resolves.toBe("done");
    expect(waitEdgesOf(registry, "/a")).toEqual([]);
    expect(wouldCycle(registry, "/b", "/a")).toBe(false);
  });
});

describe("failure paths never leave a caller waiting", () => {
  test("an undelivered request can be withdrawn", async () => {
    const registry = createForkRegistry();
    const queued = enqueueRequest(registry, { from: "/api", target: "/worker", message: "hi" });
    expect(cancelRequest(registry, "/worker", queued.id)).toBe(true);
    await expect(queued.promise).rejects.toThrow(/withdrawn/);
    expect(hasPendingRequests(registry, "/worker")).toBe(false);
    expect(waitEdgesOf(registry, "/api")).toEqual([]);
  });

  test("a delivered request is never withdrawn: its answer has a reader", async () => {
    const registry = createForkRegistry();
    const queued = enqueueRequest(registry, { from: "/api", target: "/worker", message: "hi" });
    markRequestDelivered(registry, "/worker");
    expect(cancelRequest(registry, "/worker", queued.id)).toBe(false);
    expect(pendingRequestCount(registry, "/worker")).toBe(1);
    resolveRequest(registry, "/worker", "fine");
    await expect(queued.promise).resolves.toBe("fine");
  });

  test("a dead target rejects every request parked on it", async () => {
    const registry = createForkRegistry();
    const a = enqueueRequest(registry, { from: "/a", target: "/worker", message: "one" });
    const b = enqueueRequest(registry, { from: "/b", target: "/worker", message: "two" });
    expect(rejectPendingRequests(registry, "/worker", "target scope terminated")).toBe(2);
    await expect(a.promise).rejects.toThrow(/terminated/);
    await expect(b.promise).rejects.toThrow(/terminated/);
    expect(hasPendingRequests(registry, "/worker")).toBe(false);
    // Both waiters are released from the wait graph too, so neither can block a
    // later request by looking parked.
    expect(waitEdgesOf(registry, "/a")).toEqual([]);
    expect(waitEdgesOf(registry, "/b")).toEqual([]);
  });

  test("forgetScope drops the scope's own queue and its edges", async () => {
    const registry = createForkRegistry();
    const queued = enqueueRequest(registry, { from: "/api", target: "/worker", message: "hi" });
    markRequestDelivered(registry, "/worker");
    expect(forgetScope(registry, "/worker")).toBe(1);
    await expect(queued.promise).rejects.toThrow(/terminated/);
    expect(hasPendingRequests(registry, "/worker")).toBe(false);
  });
});

describe("handleRequestToolCall drives the round trip as data", () => {
  test("a question resolves with the target's reply in details.result", async () => {
    const ledger = ledgerWith("/api", "/worker");
    // Both sides share one registry: the queue is process-wide, and a station
    // that minted its own would answer a request nobody made.
    const registry = createForkRegistry();
    const requester = stationFor(ledger, { forkId: "f-0", path: "/api" }, registry);
    const responder = stationFor(ledger, { forkId: "f-1", path: "/worker" }, registry);
    expect(senderPathOf(requester)).toBe("/api");
    expect(senderPathOf(responder)).toBe("/worker");

    const pending = handleRequestToolCall(requester, {
      id: "call-req-1",
      arguments: { target: "/worker", message: "which field carries the token?" },
    });
    expect(typeof pending.then).toBe("function");

    // The target answers as the model would: read, then reply.
    markRequestDelivered(registry, "/worker");
    const replied = handleReplyToolCall(responder, { id: "call-rep-1", arguments: "accessToken" });
    expect(replied.isError).toBeUndefined();
    expect(replied.details.result).toEqual({ ok: true });

    const answer = await pending;
    expect(answer.isError).toBeUndefined();
    expect(answer.content[0].text).toBe("accessToken");
    expect(answer.details.result).toEqual({
      ok: true,
      from: "/worker",
      reply: "accessToken",
    });
  });

  test("a relative target resolves against the sender", async () => {
    const ledger = ledgerWith("/api/auth", "/api");
    const registry = createForkRegistry();
    const child = stationFor(ledger, { forkId: "f-0", path: "/api/auth" }, registry);
    const parent = stationFor(ledger, { forkId: "f-1", path: "/api" }, registry);
    const pending = handleRequestToolCall(child, {
      id: "call-req-2",
      arguments: { target: "..", message: "status?" },
    });
    markRequestDelivered(registry, "/api");
    handleReplyToolCall(parent, { id: "call-rep-2", arguments: { reply: "on track" } });
    const answer = await pending;
    expect(answer.details.result).toEqual({ ok: true, from: "/api", reply: "on track" });
  });

  test("a wildcard target is refused: one exact path per request", () => {
    const ledger = ledgerWith("/api", "/worker");
    const station = stationFor(ledger, { forkId: "f-0", path: "/api" });
    const refused = handleRequestToolCall(station, {
      id: "call-req-3",
      arguments: { target: "**", message: "anyone?" },
    });
    expect(refused.isError).toBe(true);
    expect(refused.details.code).toBe("INVALID_SCOPE_TARGET");
    expect(refused.content[0].text).toMatch(/Promise\.all/);
  });

  test("an unregistered target is named, not silently queued", () => {
    const ledger = ledgerWith("/api");
    const station = stationFor(ledger, { forkId: "f-0", path: "/api" });
    const refused = handleRequestToolCall(station, {
      id: "call-req-4",
      arguments: { target: "/ghost", message: "hello?" },
    });
    expect(refused.isError).toBe(true);
    expect(refused.details.code).toBe("UNKNOWN_SCOPE_TARGET");
  });

  test("an empty message and a missing target are refused before queueing", () => {
    const ledger = ledgerWith("/api", "/worker");
    const station = stationFor(ledger, { forkId: "f-0", path: "/api" });
    const noMessage = handleRequestToolCall(station, {
      id: "call-req-5",
      arguments: { target: "/worker", message: "   " },
    });
    expect(noMessage.details.code).toBe("INVALID_MESSAGE");
    const noTarget = handleRequestToolCall(station, {
      id: "call-req-6",
      arguments: { message: "hello?" },
    });
    expect(noTarget.details.code).toBe("INVALID_SCOPE_TARGET");
    expect(hasPendingRequests(station.forkRegistry(), "/worker")).toBe(false);
  });

  test("a scope cannot request itself through the handler either", () => {
    const ledger = ledgerWith("/api");
    const station = stationFor(ledger, { forkId: "f-0", path: "/api" });
    const refused = handleRequestToolCall(station, {
      id: "call-req-7",
      arguments: { target: "/api", message: "me?" },
    });
    expect(refused.isError).toBe(true);
    expect(refused.details.code).toBe("REQUEST_DEADLOCK_CYCLE");
  });
});

describe("handleReplyToolCall answers only what it is holding", () => {
  test("a reply with nothing pending is refused, not invented", () => {
    const ledger = ledgerWith("/api", "/worker");
    const responder = stationFor(ledger, { forkId: "f-1", path: "/worker" });
    const out = handleReplyToolCall(responder, { id: "call-rep-3", arguments: "unsolicited" });
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("NO_PENDING_REQUEST");
  });

  test("a reply before the request is shown to the model is refused", () => {
    const ledger = ledgerWith("/api", "/worker");
    const responder = stationFor(ledger, { forkId: "f-1", path: "/worker" });
    enqueueRequest(responder.forkRegistry(), {
      from: "/api",
      target: "/worker",
      message: "did you read this?",
    });
    const out = handleReplyToolCall(responder, { id: "call-rep-4", arguments: "yes" });
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("REQUEST_NOT_DELIVERED");
  });

  test("the reply text may arrive bare or as { reply }", async () => {
    const ledger = ledgerWith("/api", "/worker");
    const registry = createForkRegistry();
    const requester = stationFor(ledger, { forkId: "f-0", path: "/api" }, registry);
    const responder = stationFor(ledger, { forkId: "f-1", path: "/worker" }, registry);
    const first = handleRequestToolCall(requester, {
      id: "call-req-8",
      arguments: { target: "/worker", message: "one" },
    });
    markRequestDelivered(responder.forkRegistry(), "/worker");
    handleReplyToolCall(responder, { id: "call-rep-5", arguments: "bare" });
    expect((await first).details.result.reply).toBe("bare");

    const second = handleRequestToolCall(requester, {
      id: "call-req-9",
      arguments: { target: "/worker", message: "two" },
    });
    markRequestDelivered(responder.forkRegistry(), "/worker");
    handleReplyToolCall(responder, { id: "call-rep-6", arguments: { reply: "boxed" } });
    expect((await second).details.result.reply).toBe("boxed");
  });
});
