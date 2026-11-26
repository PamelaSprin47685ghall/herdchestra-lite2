// Free built-in protocol calls.
//
// A read or write whose path is a URI the runtime resolves itself addresses
// harness state, not the project tree, so it spends no turn. A plain
// filesystem path and a web page keep their charge. The rule reads the call,
// not the scope: the root and a zero-turn branch reach the same verdict.

import { describe, expect, test } from "bun:test";

import { chargeBranch } from "../src/scope/accounting.mjs";
import { beatShares, internalScheme, isFreeCall } from "../src/scope/turns.mjs";
import { createBracketLedger, registerFork } from "../src/scope/forkjoin.mjs";
import { createState } from "../src/scope/state.mjs";

const INTERNAL_SCHEMES = [
  "agent",
  "cfg",
  "help",
  "history",
  "issue",
  "local",
  "mcp",
  "omp",
  "pr",
  "proc",
  "skill",
  "ssh",
  "xd",
];

function ledgerWith(forkId, budget) {
  const ledger = createBracketLedger();
  const registered = registerFork(ledger, {
    forkId,
    ownerId: "root",
    fsm: "task",
    depth: 0,
    budget,
    startedAt: 0,
  });
  expect(registered.ok).toBe(true);
  return ledger;
}

describe("built-in protocol calls are free", () => {
  test("every built-in scheme is free for read and for write", () => {
    for (const scheme of INTERNAL_SCHEMES) {
      const path = `${scheme}://target`;
      expect(internalScheme(path)).toBe(scheme);
      expect(isFreeCall("read", { path })).toBe(true);
      expect(isFreeCall("write", { path })).toBe(true);
    }
  });

  test("selectors after the scheme do not change the verdict", () => {
    expect(isFreeCall("read", { path: "local://0.log:raw:13-13" })).toBe(true);
    expect(isFreeCall("read", { path: "agent://all/key/0" })).toBe(true);
    expect(isFreeCall("write", { path: "xd://resolve" })).toBe(true);
    expect(isFreeCall("write", { path: "xd://reject" })).toBe(true);
  });

  test("the root runs them without a fork and records no charge", () => {
    const s = createState();
    const ledger = ledgerWith("f1", { read: 2, write: 2 });
    for (const [toolName, path] of [
      ["read", "local://report.md"],
      ["read", "skill://constitution"],
      ["read", "agent://all"],
      ["write", "local://note.md"],
      ["write", "xd://resolve"],
    ]) {
      const charged = chargeBranch(s, ledger, {
        ownerId: null,
        toolCallId: `free-${toolName}-${path}`,
        toolName,
        input: { path },
      });
      expect(charged).toEqual({ ok: true, free: true });
    }
    expect(s.charges ?? {}).toEqual({});
    expect(ledger.forks.f1.remaining.read).toBe(2);
    expect(ledger.forks.f1.remaining.write).toBe(2);
  });

  test("a scope with zero read and write budget still runs them", () => {
    const s = createState();
    const ledger = ledgerWith("f1", { read: 0, write: 0 });
    for (const [toolName, path] of [
      ["read", "local://0.log"],
      ["write", "local://note.md"],
    ]) {
      const charged = chargeBranch(s, ledger, {
        ownerId: "f1",
        toolCallId: `free-${toolName}`,
        toolName,
        input: { path },
      });
      expect(charged).toEqual({ ok: true, free: true });
    }
    expect(s.charges ?? {}).toEqual({});

    const paid = chargeBranch(s, ledger, {
      ownerId: "f1",
      toolCallId: "paid",
      toolName: "read",
      input: { path: "src/scope/turns.mjs" },
    });
    expect(paid.ok).toBe(true);
    expect(paid.panhandled).toBe(true);
    expect(paid.amount).toBe(0);
  });

  test("a filesystem path and a web page keep their charge", () => {
    for (const path of [
      "src/scope/turns.mjs",
      "./notes.txt",
      "/home/user/x.md",
      "https://example.com/page",
      "http://example.com/page",
      "file:///tmp/x.md",
    ]) {
      expect(internalScheme(path)).toBeNull();
      expect(isFreeCall("read", { path })).toBe(false);
      expect(isFreeCall("write", { path })).toBe(false);
    }
  });

  test("another tool on a built-in URI is not free", () => {
    expect(isFreeCall("grep", { path: "local://0.log" })).toBe(false);
    expect(isFreeCall("bash", { command: "cat local://0.log" })).toBe(false);
    expect(isFreeCall("read", { path: 42 })).toBe(false);
    expect(isFreeCall("read", "skill://constitution")).toBe(false);
    expect(isFreeCall("read", null)).toBe(false);
  });

  test("a free URI takes no share of the beat", () => {
    expect(
      beatShares([
        { name: "read", free: true },
        { name: "read", free: false },
      ]),
    ).toEqual({ read: 1 });
  });
});
