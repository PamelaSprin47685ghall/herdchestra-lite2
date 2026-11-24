import { describe, expect, test } from "bun:test";

import { CONTROL_TOOLS } from "../src/scope/state.mjs";
import { isFreeTool } from "../src/scope/turns.mjs";
import { sendParameters } from "../src/tools/descriptions.mjs";
import {
  createBracketLedger,
  forkOf,
  markReady,
  registerFork,
} from "../src/scope/forkjoin.mjs";
import { childScopePath, listActiveScopePaths, resolveScopeTargets } from "../src/scope/path.mjs";
import { handleSendCall } from "../src/station/send-controls.mjs";

const STATE = {
  scopes: [],
  autopilot: false,
  relay: { generation: 0, fullFlow: false },
};

function fork(ledger, forkId, ownerId = "root", depth = 0) {
  const out = registerFork(ledger, {
    forkId,
    ownerId,
    levelKey: "L0",
    fsm: `task ${forkId}`,
    depth,
  });
  expect(out.ok).toBe(true);
  return out.fork;
}

function stationFor(ledger, identity = null) {
  return {
    state: { ...STATE },
    forkLedgerPort: () => ledger,
    forkIdentityPort: () => identity,
  };
}

describe("scope_send is a free control tool", () => {
  test("lives in CONTROL_TOOLS and spends no turn", () => {
    expect(CONTROL_TOOLS.has("scope_send")).toBe(true);
    expect(isFreeTool("scope_send")).toBe(true);
  });

  test("requires a target and a message, and takes an optional budget", () => {
    expect(sendParameters.type).toBe("object");
    expect(sendParameters.required).toEqual(expect.arrayContaining(["target", "message"]));
    const target = sendParameters.properties.target;
    const accepts = target.anyOf ?? [target];
    expect(accepts.some((branch) => branch.type === "string")).toBe(true);
    expect(accepts.some((branch) => branch.type === "array")).toBe(true);
    expect(sendParameters.properties.message.type).toBe("string");
    expect(sendParameters.properties.budget).toBeDefined();
  });
});

describe("addressing", () => {
  test("a child path is its parent path plus the scope id", () => {
    expect(childScopePath("/", "worker")).toBe("/worker");
    expect(childScopePath("/api", "auth")).toBe("/api/auth");
  });

  test("the active list holds lexicographic paths and the root", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f-api", "root", 0);
    fork(ledger, "f-ui", "root", 0);
    forkOf(ledger, "f-api").path = "/api";
    forkOf(ledger, "f-ui").path = "/ui";
    expect(listActiveScopePaths(ledger)).toEqual(["/", "/api", "/ui"]);
  });

  test("a glob matches active scopes only and never the sender", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f-api", "root", 0);
    fork(ledger, "f-ui", "root", 0);
    fork(ledger, "f-old", "root", 0);
    forkOf(ledger, "f-api").path = "/api";
    forkOf(ledger, "f-ui").path = "/ui";
    forkOf(ledger, "f-old").path = "/old";
    markReady(ledger, "f-old", { ok: true, record: "done" });

    const sent = resolveScopeTargets(ledger, "/api", "**");
    expect(sent.ok).toBe(true);
    expect(sent.paths).toEqual(["/ui"]);

    const exact = resolveScopeTargets(ledger, "/api", "/old");
    expect(exact.ok).toBe(true);
    expect(exact.paths).toEqual(["/old"]);

    const parent = resolveScopeTargets(ledger, "/api", "..");
    expect(parent.paths).toEqual(["/"]);
  });

  test("an empty match is refused instead of silently doing nothing", () => {
    const ledger = createBracketLedger();
    const out = resolveScopeTargets(ledger, "/", "/ghost");
    expect(out.ok).toBe(false);
    expect(out.code).toBe("UNKNOWN_SCOPE_TARGET");
  });
});

describe("delivery", () => {
  test("a running child takes the message into its inbox with the sender envelope", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f-worker", "root", 0);
    forkOf(ledger, "f-worker").path = "/worker";
    const station = stationFor(ledger, null);

    const out = handleSendCall(station, {
      id: "call-send-1",
      arguments: { target: "/worker", message: "  report the cache hit rate  " },
    });
    expect(out.isError).toBeUndefined();
    const inbox = forkOf(ledger, "f-worker").inbox;
    expect(inbox).toHaveLength(1);
    expect(inbox[0].from).toBe("/");
    expect(inbox[0].message).toBe("report the cache hit rate");
    expect(inbox[0].envelope).toBe("[Message from /]\nreport the cache hit rate");
  });

  test("an optional budget adds turns to the target with the same grant arithmetic", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f-worker", "root", 0);
    const record = forkOf(ledger, "f-worker");
    record.path = "/worker";
    record.remaining = { read: 1 };
    const station = stationFor(ledger, null);

    const out = handleSendCall(station, {
      id: "call-send-2",
      arguments: { target: "/worker", message: "go on", budget: { read: 2 } },
    });
    expect(out.isError).toBeUndefined();
    expect(record.remaining.read).toBe(3);
  });

  test("a child replying to .. reaches the parent, and / reaches the root", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f-api", "root", 0);
    forkOf(ledger, "f-api").path = "/api";

    const child = stationFor(ledger, {
      forkId: "f-api",
      parentOwnerId: "root",
      ownScopeId: "api",
      path: "/api",
    });
    const up = handleSendCall(child, {
      id: "call-send-3",
      arguments: { target: "..", message: "the leak is in the parser" },
    });
    expect(up.isError).toBeUndefined();
    expect(ledger.rootInbox.at(-1).envelope).toBe(
      "[Message from /api]\nthe leak is in the parser",
    );

    const down = handleSendCall(child, {
      id: "call-send-4",
      arguments: { target: "/", message: "need a decision", budget: { read: 9 } },
    });
    expect(down.isError).toBeUndefined();
    expect(ledger.rootInbox.at(-1).from).toBe("/api");
    // The root has no budget to grant.
    expect(down.details.budgetGranted).toBe(false);
  });

  test("a glob fans out to every matching active scope", () => {
    const ledger = createBracketLedger();
    for (const id of ["f-api", "f-ui"]) {
      fork(ledger, id, "root", 0);
      forkOf(ledger, id).path = `/${id.slice(2)}`;
    }
    const station = stationFor(ledger, null);

    const out = handleSendCall(station, {
      id: "call-send-5",
      arguments: { target: ["*"], message: "stand down" },
    });
    expect(out.isError).toBeUndefined();
    expect(forkOf(ledger, "f-api").inbox).toHaveLength(1);
    expect(forkOf(ledger, "f-ui").inbox).toHaveLength(1);
    expect(out.details.delivered.sort()).toEqual(["/api", "/ui"]);
  });
});
