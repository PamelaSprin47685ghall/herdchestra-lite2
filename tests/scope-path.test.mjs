// The path layer is pure: a ledger snapshot in, an address or a fork id list
// out. These cases pin the consumer-visible edges that `scope_fork` (strict
// path resolution, upscope lookup) and `scope_abandon` (exact path lookup)
// rely on.
//
// Every segment is `<role>.<name>`: the role decides which host tools the
// scope holds, so a segment without a role is not a scope id at all.

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
    expect(normalizeScopePath("/", "/manager.a/editor.b")).toEqual({
      ok: true,
      path: "/manager.a/editor.b",
      isGlob: false,
    });
  });

  test("resolves . to the caller's own path when allowRoot permits", () => {
    expect(normalizeScopePath("/manager.a/editor.b", ".").path).toBe("/manager.a/editor.b");
    expect(normalizeScopePath("/", ".").path).toBe("/");
  });

  test("resolves .. to the parent and refuses .. climbing past /", () => {
    expect(normalizeScopePath("/manager.a/editor.b", "..").path).toBe("/manager.a");
    expect(normalizeScopePath("/manager.a", "..").path).toBe("/");
    for (const [cwd, target] of [
      ["/", ".."],
      ["/manager.a", "../.."],
      ["/manager.a/editor.b", "../../.."],
    ]) {
      const out = normalizeScopePath(cwd, target);
      expect(out.ok).toBe(false);
      expect(out.code).toBe("INVALID_PATH");
    }
  });

  test("resolves a relative name under the caller", () => {
    expect(normalizeScopePath("/manager.a", "editor.sub").path).toBe("/manager.a/editor.sub");
    expect(normalizeScopePath("/manager.a", "./editor.sub").path).toBe("/manager.a/editor.sub");
    expect(normalizeScopePath("/manager.a", "inspector.x/editor.y").path).toBe(
      "/manager.a/inspector.x/editor.y",
    );
    expect(normalizeScopePath("/", "manager.a").path).toBe("/manager.a");
  });

  test("resolves a sibling through ..", () => {
    expect(normalizeScopePath("/manager.a/editor.b", "../inspector.sibling").path).toBe(
      "/manager.a/inspector.sibling",
    );
  });

  test("refuses wildcards, trailing slashes, empty segments, and root segment", () => {
    for (const [cwd, target] of [
      ["/manager.a", "**"],
      ["/", "*"],
      ["/manager.a", "x/*"],
      ["/manager.a", "x?"],
      ["/manager.a", "x/"],
      ["/", "/manager.a/"],
      ["/", "/manager.a//editor.b"],
      ["/manager.a", "editor.b//editor.c"],
      ["/", "//manager.a"],
      ["/", "root"],
      ["/", "/Root/sub"],
      ["/manager.a", "ROOT"],
      ["/manager.a", ""],
      ["/manager.a", "   "],
    ]) {
      const out = normalizeScopePath(cwd, target);
      expect(out.ok).toBe(false);
      expect(out.code).toBe("INVALID_PATH");
    }
  });

  test("refuses a segment that carries no role", () => {
    for (const [cwd, target] of [
      ["/", "worker"],
      ["/", "/a/b"],
      ["/", "/manager.a/worker"],
      ["/manager.a", "editor"],
      ["/", "/editor."],
      ["/", "/worker.manager"],
      ["/", "/Manager.tom"],
    ]) {
      const out = normalizeScopePath(cwd, target);
      expect(out.ok).toBe(false);
      expect(out.code).toBe("INVALID_PATH");
    }
    for (const role of ["manager", "devops", "editor", "inspector"]) {
      expect(normalizeScopePath("/", `${role}.ok`).ok).toBe(true);
    }
  });

  test("refuses resolving to / when allowRoot is false", () => {
    for (const [cwd, target] of [
      ["/", "/"],
      ["/", "."],
      ["/manager.a", ".."],
    ]) {
      const out = normalizeScopePath(cwd, target, { allowRoot: false });
      expect(out.ok).toBe(false);
      expect(out.code).toBe("INVALID_PATH");
    }
  });
});

describe("resolveForkPath, splitScopePath, and subscopePath", () => {
  test("resolveForkPath returns canonical path, upscopePath, and name", () => {
    expect(resolveForkPath("/", "manager.tom")).toEqual({
      ok: true,
      path: "/manager.tom",
      upscopePath: "/",
      name: "manager.tom",
    });
    expect(resolveForkPath("/manager.a/editor.b", "../devops.c/inspector.spy")).toEqual({
      ok: true,
      path: "/manager.a/devops.c/inspector.spy",
      upscopePath: "/manager.a/devops.c",
      name: "inspector.spy",
    });
    expect(resolveForkPath("/manager.a", "..").ok).toBe(false);
  });

  test("splitScopePath and subscopePath handle root and nested paths", () => {
    expect(splitScopePath("/")).toBeNull();
    expect(splitScopePath("/manager.a")).toEqual({ upscopePath: "/", name: "manager.a" });
    expect(splitScopePath("/manager.a/devops.b/editor.c")).toEqual({
      upscopePath: "/manager.a/devops.b",
      name: "editor.c",
    });
    expect(subscopePath("/", "manager.api")).toBe("/manager.api");
    expect(subscopePath("/manager.api", "inspector.spy")).toBe("/manager.api/inspector.spy");
  });
});

describe("findScopeByPath and forkIdsUnderPath", () => {
  const ledger = snapshot([
    { forkId: "a", scopeId: "manager.a", path: "/manager.a", status: "running" },
    { forkId: "b", scopeId: "manager.b", path: "/manager.b", status: "ready" },
    { forkId: "ac", upscopeId: "a", scopeId: "editor.c", path: "/manager.a/editor.c", status: "joined" },
    { forkId: "ad", upscopeId: "a", scopeId: "editor.d", path: "/manager.a/editor.d", status: "running" },
  ]);

  test("findScopeByPath matches case-insensitively across statuses and ignores /", () => {
    expect(findScopeByPath(ledger, "/")).toBeNull();
    expect(findScopeByPath(ledger, "/MANAGER.A/EDITOR.C")?.forkId).toBe("ac");
    expect(findScopeByPath(ledger, "/manager.b")?.forkId).toBe("b");
    expect(findScopeByPath(ledger, "/missing")).toBeNull();
  });

  test("forkIdsUnderPath collects the subtree under a path", () => {
    expect(forkIdsUnderPath(ledger, "/manager.a")).toEqual(["a", "ac", "ad"]);
    expect(forkIdsUnderPath(ledger, "/")).toEqual(["a", "b", "ac", "ad"]);
    expect(forkIdsUnderPath(ledger, "/none")).toEqual([]);
  });
});
