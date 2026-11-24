import { describe, expect, test } from "bun:test";
import {
  createBracketLedger,
  forkBudgetText,
  registerFork,
} from "../src/scope/forkjoin.mjs";
import { createClockOn } from "../src/scope/clock.mjs";

describe("remaining clock rendering", () => {
  test("floors the remaining seconds instead of rounding up", () => {
    const ledger = createBracketLedger();
    const registered = registerFork(
      ledger,
      {
        forkId: "fork_render",
        scopeId: "child",
        ownerId: "parent",
        fsm: "render",
        depth: 0,
        time: 60,
        startedAt: 1_000_000,
      },
      { clock: createClockOn(() => 1_000_000) },
    );
    expect(registered.ok).toBe(true);
    // 57.1s left must read 0:57, not 0:58.
    const line = forkBudgetText(registered.fork, 1_002_900);
    expect(line).toContain("time remaining 0:57/1:00");
  });
});
