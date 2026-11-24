// The path layer is pure: a ledger snapshot in, an address or a set of
// addresses out. These cases pin the consumer-visible edges that
// `scope_fork` (sibling naming) and `scope_send` (delivery) rely on.

import { describe, expect, test } from "bun:test";

import {
  allocateSiblingScopeId,
  listActiveScopePaths,
  normalizeScopePath,
  resolveScopeTargets,
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
    { forkId: "ad", parentForkId: "a", scopeId: "d", path: "/a/d", status: "ready", woken: true },
  ]);

  test("always lists the root first and sorts the rest", () => {
    expect(listActiveScopePaths(ledger)).toEqual(["/", "/a", "/a/d"]);
  });

  test("omits a finished scope until it is woken", () => {
    expect(listActiveScopePaths(ledger)).not.toContain("/b");
    ledger.forks.ad.woken = false;
    expect(listActiveScopePaths(ledger)).toEqual(["/", "/a"]);
  });

  test("lists only the root on an empty ledger", () => {
    expect(listActiveScopePaths(snapshot([]))).toEqual(["/"]);
  });
});

describe("resolveScopeTargets", () => {
  const ledger = snapshot([
    { forkId: "a", scopeId: "a", path: "/a", status: "running" },
    { forkId: "b", scopeId: "b", path: "/b", status: "running" },
    { forkId: "ax", parentForkId: "a", scopeId: "x", path: "/a/x", status: "ready" },
    { forkId: "ay", parentForkId: "a", scopeId: "y", path: "/a/y", status: "joined" },
    { forkId: "az", parentForkId: "a", scopeId: "z", path: "/a/z", status: "ready", woken: true },
  ]);

  test("addresses the root", () => {
    const out = resolveScopeTargets(ledger, "/a", "/");
    expect(out.ok).toBe(true);
    expect(out.targets).toEqual([{ kind: "root", path: "/" }]);
  });

  test("an exact path resolves whether the scope is active or finished", () => {
    expect(resolveScopeTargets(ledger, "/b", "/a").targets).toEqual([
      { kind: "scope", forkId: "a", path: "/a" },
    ]);
    // Finished and not woken: naming it is how a wake is asked for.
    expect(resolveScopeTargets(ledger, "/b", "/a/x").targets).toEqual([
      { kind: "scope", forkId: "ax", path: "/a/x" },
    ]);
    expect(resolveScopeTargets(ledger, "/b", "/a/y").targets).toEqual([
      { kind: "scope", forkId: "ay", path: "/a/y" },
    ]);
  });

  test("an unknown exact path is refused by name", () => {
    const out = resolveScopeTargets(ledger, "/a", "/nope");
    expect(out.ok).toBe(false);
    expect(out.code).toBe("UNKNOWN_SCOPE_TARGET");
    expect(out.target).toBe("/nope");
  });

  test("a wildcard never wakes a finished scope", () => {
    // `/a/*` reaches only the active child; `/a/x` and `/a/y` stay asleep.
    expect(resolveScopeTargets(ledger, "/b", "/a/*").targets).toEqual([
      { kind: "scope", forkId: "az", path: "/a/z" },
    ]);
  });

  test("** reaches the whole active tree and skips the sender", () => {
    expect(resolveScopeTargets(ledger, "/", "**").targets.map((t) => t.path)).toEqual([
      "/a",
      "/a/z",
      "/b",
    ]);
  });

  test("a relative wildcard is resolved against the caller", () => {
    expect(resolveScopeTargets(ledger, "/b", "../*").targets.map((t) => t.path)).toEqual([
      "/a",
      "/a/z",
    ]);
    expect(resolveScopeTargets(ledger, "/a/z", "*").targets).toEqual([]);
  });

  test("a wildcard that matches nothing is refused", () => {
    const out = resolveScopeTargets(ledger, "/a/z", "/a/*");
    expect(out.ok).toBe(false);
    expect(out.code).toBe("NO_MATCHING_SCOPES");
  });

  test("accepts several targets and returns one address per scope", () => {
    const out = resolveScopeTargets(ledger, "/b", ["/a/z", "/a"]);
    expect(out.ok).toBe(true);
    expect(out.targets).toEqual([
      { kind: "scope", forkId: "a", path: "/a" },
      { kind: "scope", forkId: "az", path: "/a/z" },
    ]);
  });

  test("refuses an empty target list", () => {
    const out = resolveScopeTargets(ledger, "/a", []);
    expect(out.ok).toBe(false);
    expect(out.code).toBe("NO_MATCHING_SCOPES");
  });
});
