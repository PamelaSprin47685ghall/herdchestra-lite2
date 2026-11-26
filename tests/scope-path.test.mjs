// The path layer is pure: a ledger snapshot in, an address or a set of
// addresses out. These cases pin the consumer-visible edges that
// `scope_fork` (sibling naming), `scope_join` (who is outstanding), and
// `scope_request` (which addresses can answer) rely on.

import { describe, expect, test } from "bun:test";

import {
  allocateSiblingScopeId,
  listActiveScopePaths,
  listAddressableScopePaths,
  normalizeScopePath,
} from "../src/scope/path.mjs";

// A ledger snapshot: `forks` is the record map, `order` the registration
// order. No station, no clock, no ticket.
function snapshot(records) {
  const forks = {};
  for (const record of records) {
    forks[record.forkId] = {
      generation: 1,
      status: "running",
      woken: false,
      parentForkId: null,
      ...record,
    };
  }
  return { forks, order: records.map((record) => record.forkId) };
}

describe("normalizeScopePath", () => {
  test("keeps an absolute path as written", () => {
    expect(normalizeScopePath("/", "/a/b")).toEqual({
      ok: true,
      path: "/a/b",
      isGlob: false,
    });
  });

  test("resolves . to the caller's own path", () => {
    expect(normalizeScopePath("/a/b", ".").path).toBe("/a/b");
    expect(normalizeScopePath("/", ".").path).toBe("/");
  });

  test("resolves .. to the parent, clamped at the root", () => {
    expect(normalizeScopePath("/a/b", "..").path).toBe("/a");
    expect(normalizeScopePath("/a", "..").path).toBe("/");
    expect(normalizeScopePath("/", "..").path).toBe("/");
    expect(normalizeScopePath("/a/b", "../../..").path).toBe("/");
  });

  test("resolves a relative name under the caller", () => {
    expect(normalizeScopePath("/a", "sub").path).toBe("/a/sub");
    expect(normalizeScopePath("/a", "./sub").path).toBe("/a/sub");
    expect(normalizeScopePath("/a", "x/y").path).toBe("/a/x/y");
    expect(normalizeScopePath("/", "a").path).toBe("/a");
  });

  test("resolves a sibling through ..", () => {
    expect(normalizeScopePath("/a/b", "../sibling").path).toBe("/a/sibling");
  });

  test("marks a target that carries a wildcard", () => {
    expect(normalizeScopePath("/a", "**")).toEqual({
      ok: true,
      path: "/a/**",
      isGlob: true,
    });
    expect(normalizeScopePath("/", "*").isGlob).toBe(true);
    expect(normalizeScopePath("/a", "x/*").isGlob).toBe(true);
    expect(normalizeScopePath("/a", "x").isGlob).toBe(false);
  });

  test("refuses an empty target instead of resolving to the caller", () => {
    for (const target of ["", "   "]) {
      const out = normalizeScopePath("/a", target);
      expect(out.ok).toBe(false);
      expect(out.code).toBe("INVALID_SCOPE_TARGET");
    }
  });
});

describe("allocateSiblingScopeId", () => {
  test("keeps a free name at the root", () => {
    expect(allocateSiblingScopeId(snapshot([]), null, "worker")).toBe("worker");
  });

  test("appends the lowest free suffix on a sibling collision", () => {
    const ledger = snapshot([{ forkId: "f1", scopeId: "worker", path: "/worker" }]);
    expect(allocateSiblingScopeId(ledger, null, "worker")).toBe("worker-2");
    ledger.forks.f2 = { status: "ready", parentForkId: null, scopeId: "worker-2", path: "/worker-2" };
    ledger.order.push("f2");
    expect(allocateSiblingScopeId(ledger, null, "worker")).toBe("worker-3");
  });

  test("counts a name reserved earlier in the same batch", () => {
    const ledger = snapshot([]);
    expect(allocateSiblingScopeId(ledger, null, "worker", new Set(["worker"]))).toBe(
      "worker-2",
    );
  });

  test("scopes names to the sibling level, not the conversation", () => {
    const ledger = snapshot([
      { forkId: "a", scopeId: "a", path: "/a" },
      { forkId: "aw", parentForkId: "a", scopeId: "worker", path: "/a/worker" },
    ]);
    // A finished record still holds its name while it can be woken.
    ledger.forks.aw.status = "ready";
    expect(allocateSiblingScopeId(ledger, null, "worker")).toBe("worker");
    expect(allocateSiblingScopeId(ledger, "a", "worker")).toBe("worker-2");
  });
});

describe("listActiveScopePaths", () => {
  const ledger = snapshot([
    { forkId: "a", scopeId: "a", path: "/a", status: "running" },
    { forkId: "b", scopeId: "b", path: "/b", status: "ready" },
    { forkId: "ac", parentForkId: "a", scopeId: "c", path: "/a/c", status: "joined" },
    { forkId: "ad", parentForkId: "a", scopeId: "d", path: "/a/d", status: "running" },
  ]);

  test("always lists the root first and sorts the rest", () => {
    expect(listActiveScopePaths(ledger)).toEqual(["/", "/a", "/a/d"]);
  });

  test("lists only the root on an empty ledger", () => {
    expect(listActiveScopePaths(snapshot([]))).toEqual(["/"]);
  });
});

describe("listAddressableScopePaths", () => {
  // The address book `state.scopes` shows the model: root first, sorted, and
  // every record that can still answer one reply turn.
  const ledger = snapshot([
    { forkId: "a", scopeId: "a", path: "/a", status: "running" },
    { forkId: "b", scopeId: "b", path: "/b", status: "ready" },
    { forkId: "ac", parentForkId: "a", scopeId: "c", path: "/a/c", status: "joined" },
    { forkId: "ad", parentForkId: "a", scopeId: "d", path: "/a/d", status: "running" },
  ]);

  test("offers every scope that can still answer a request", () => {
    // `state.scopes` is the model's address book for `scope_request` fanout.
    // A returned or joined scope keeps a live agent that answers one reply
    // turn, so it belongs there; a failed record cannot answer and stays out.
    expect(listAddressableScopePaths(ledger)).toEqual(["/", "/a", "/a/c", "/a/d", "/b"]);
    ledger.forks.b.status = "failed";
    expect(listAddressableScopePaths(ledger)).not.toContain("/b");
  });
});

