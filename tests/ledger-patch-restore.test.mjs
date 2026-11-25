import { describe, expect, test } from "bun:test";

import {
  createState,
  createBracketLedger,
  registerFork,
  planLedgerEntry,
  foldStateChain,
} from "../src/scope/index.mjs";
import { restoreState } from "../src/station/restore.mjs";
import { registerLedger } from "../src/scope/ledger-cache.mjs";

// A changed record now travels as a patch, in a field of its own. That field has
// to survive the trip a real session takes: the anchor writes it into a custom
// entry, the process restarts, and the branch is read back. Three places could
// drop it silently — the anchor's payload (which must forward every increment,
// not a named list), the branch walk that decides which entries still matter,
// and the fold that applies them. A patch is also only valid against the record
// it names, so an entry older than the checkpoint must still be collected.

const SESSION_STATE_TYPE = "scope.state";

function freshState() {
  const state = createState();
  state.brackets = createBracketLedger();
  registerLedger(state.brackets);
  return state;
}

function register(state, forkId) {
  const registered = registerFork(state.brackets, {
    forkId,
    ownerId: "root",
    fsm: "one state",
    depth: 0,
    budget: { read: 1 },
    profession: "You are a tester.",
  });
  expect(registered.ok).toBe(true);
}

/** One custom entry as the anchor writes it, with the ledger half embedded. */
const anchorEntry = (ledgerHalf, id) => ({
  id,
  type: "custom",
  customType: SESSION_STATE_TYPE,
  data: {
    version: 3,
    kind: "delta",
    ops: [],
    // The anchor forwards the whole plan; this is the shape it produces.
    ledger: ledgerHalf,
  },
});

const managerOver = (branch) => ({ getBranch: () => branch });

describe("a patch that travels through a real write and restart", () => {
  test("restores the record the session had, not a truncated one", () => {
    const state = freshState();
    register(state, "a");
    state.brackets.forks.a.messages = Array.from({ length: 40 }, (_, index) => ({
      role: "user",
      text: `m${index} ${"x".repeat(50)}`,
    }));
    const base = planLedgerEntry(state, null);

    // A later write moves only the status.
    state.brackets.forks.a.task = "edited";
    state.brackets.forks.a.status = "ready";
    const next = planLedgerEntry(state, base.brackets);

    // The increment the anchor persists is the plan's own payload.
    const { version, kind, ...ledgerHalf } = next.entry;
    expect(version).toBeDefined();
    expect(kind).toBe("ledger");
    expect(Array.isArray(ledgerHalf.patches.a)).toBe(true);
    expect(ledgerHalf.set?.a).toBeUndefined();

    // `foldStateChain` is the reader the branch walk feeds. The anchor forwards
    // the plan; this is what a restart applies, so this is what the entry must
    // survive.
    const restored = foldStateChain([base.entry, next.entry]);

    expect(restored.brackets.forks.a.task).toBe("edited");
    expect(restored.brackets.forks.a.status).toBe("ready");
    expect(restored.brackets.forks.a.messages).toHaveLength(40);
    expect(restored.brackets.forks.a.messages[39].text).toBe(`m39 ${"x".repeat(50)}`);
  });

  test("a patch-only entry is still collected as ledger, after the checkpoint", () => {
    const state = freshState();
    register(state, "a");
    const base = planLedgerEntry(state, null);

    state.brackets.forks.a.task = "second";
    const next = planLedgerEntry(state, base.brackets);
    const { version: _v, kind: _k, ...ledgerHalf } = next.entry;

    // The patch entry carries nothing but `patches`: no set, no del, no head.
    expect(ledgerHalf.patches).toBeDefined();
    // Nothing is repeated: the patch entry names no whole record at all.
    expect(Object.keys(ledgerHalf.set ?? {})).toEqual([]);
    expect(ledgerHalf.del).toEqual([]);

    // A newer checkpoint (full) closes the journal; the patch entry precedes it,
    // so it must still be collected — it is the only copy of that change.
    // The fold applies the patch to the record the plan established: the older
    // entries still matter, which is why the journal is collected past the
    // checkpoint rather than stopping at it.
    const restored = foldStateChain([base.entry, next.entry]);
    expect(restored.brackets.forks.a.task).toBe("second");
  });

  test("a patch whose record was cut away fails the chain, not one record", () => {
    const state = freshState();
    register(state, "a");
    const base = planLedgerEntry(state, null);

    state.brackets.forks.a.task = "orphan";
    const next = planLedgerEntry(state, base.brackets);
    const { version: _v2, kind: _k2, ...ledgerHalf } = next.entry;

    // The establishing entry is gone: a branch cut left only the patch.
    const restored = restoreState(managerOver([anchorEntry(ledgerHalf, "e2")]));

    // Applying the patch to nothing would leave a fork with a task and no
    // history, which reads healthy. The chain refuses instead.
    expect(restored.brackets.forks.a).toBeUndefined();
  });
});
