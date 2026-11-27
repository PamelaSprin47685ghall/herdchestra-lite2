// The path layer is pure: a ledger snapshot in, an address or a fork id list
// out. These cases pin the consumer-visible edges that `scope_fork` (strict
// path resolution, upscope lookup) and `scope_abandon` (exact path lookup)
// rely on.

import { describe, expect, test } from "bun:test";

import {
  findScopeByPath,
  forkIdsUnderPath,
  normalizeScopePath,
  resolveForkPath,
  splitScopePath,
  subscopePath,
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
      upscopeId: null,
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

  test("resolves . to the caller's own path when allowRoot permits", () => {
    expect(normalizeScopePath("/a/b", ".").path).toBe("/a/b");
    expect(normalizeScopePath("/", ".").path).toBe("/");
  });

  test("resolves .. to the parent and refuses .. climbing past /", () => {
    expect(normalizeScopePath("/a/b", "..").path).toBe("/a");
    expect(normalizeScopePath("/a", "..").path).toBe("/");
    for (const [cwd, target] of [
      ["/", ".."],
      ["/a", "../.."],
      ["/a/b", "../../.."],
    ]) {
      const out = normalizeScopePath(cwd, target);
      expect(out.ok).toBe(false);
      expect(out.code).toBe("INVALID_PATH");
    }
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

  test("refuses wildcards, trailing slashes, empty segments, and root segment", () => {
    for (const [cwd, target] of [
      ["/a", "**"],
      ["/", "*"],
      ["/a", "x/*"],
      ["/a", "x?"],
      ["/a", "x/"],
      ["/", "/a/"],
      ["/", "/a//b"],
      ["/a", "b//c"],
      ["/", "//a"],
      ["/", "root"],
      ["/", "/Root/sub"],
      ["/a", "ROOT"],
      ["/a", ""],
      ["/a", "   "],
    ]) {
      const out = normalizeScopePath(cwd, target);
      expect(out.ok).toBe(false);
      expect(out.code).toBe("INVALID_PATH");
    }
  });

  test("refuses resolving to / when allowRoot is false", () => {
    for (const [cwd, target] of [
      ["/", "/"],
      ["/", "."],
      ["/a", ".."],
    ]) {
      const out = normalizeScopePath(cwd, target, { allowRoot: false });
      expect(out.ok).toBe(false);
      expect(out.code).toBe("INVALID_PATH");
    }
  });
});

describe("resolveForkPath, splitScopePath, and subscopePath", () => {
  test("resolveForkPath returns canonical path, upscopePath, and name", () => {
    expect(resolveForkPath("/", "worker")).toEqual({
      ok: true,
      path: "/worker",
      upscopePath: "/",
      name: "worker",
    });
    expect(resolveForkPath("/a/b", "../c/spy")).toEqual({
      ok: true,
      path: "/a/c/spy",
      upscopePath: "/a/c",
      name: "spy",
    });
    expect(resolveForkPath("/a", "..").ok).toBe(false);
  });

  test("splitScopePath and subscopePath handle root and nested paths", () => {
    expect(splitScopePath("/")).toBeNull();
    expect(splitScopePath("/worker")).toEqual({ upscopePath: "/", name: "worker" });
    expect(splitScopePath("/a/b/c")).toEqual({ upscopePath: "/a/b", name: "c" });
    expect(subscopePath("/", "api")).toBe("/api");
    expect(subscopePath("/api", "spy")).toBe("/api/spy");
  });
});

describe("findScopeByPath and forkIdsUnderPath", () => {
  const ledger = snapshot([
    { forkId: "a", scopeId: "a", path: "/a", status: "running" },
    { forkId: "b", scopeId: "b", path: "/b", status: "ready" },
    { forkId: "ac", upscopeId: "a", scopeId: "c", path: "/a/c", status: "joined" },
    { forkId: "ad", upscopeId: "a", scopeId: "d", path: "/a/d", status: "running" },
  ]);

  test("findScopeByPath matches case-insensitively across statuses and ignores /", () => {
    expect(findScopeByPath(ledger, "/")).toBeNull();
    expect(findScopeByPath(ledger, "/A/C")?.forkId).toBe("ac");
    expect(findScopeByPath(ledger, "/b")?.forkId).toBe("b");
    expect(findScopeByPath(ledger, "/missing")).toBeNull();
  });

  test("forkIdsUnderPath collects the subtree under a path", () => {
    expect(forkIdsUnderPath(ledger, "/a")).toEqual(["a", "ac", "ad"]);
    expect(forkIdsUnderPath(ledger, "/")).toEqual(["a", "b", "ac", "ad"]);
    expect(forkIdsUnderPath(ledger, "/none")).toEqual([]);
  });
});

