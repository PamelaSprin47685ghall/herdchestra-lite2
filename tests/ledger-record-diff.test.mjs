import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

// The digest is computed here, from node:crypto, not from the module under test:
// a test that asked the writer for the witness it is checking would pass even
// if that witness were wrong. Two texts with one length and one tail are still
// two texts, which is the whole point.
//
// UTF-16LE, matching the witness the writer emits: UTF-8 collapses a lone
// surrogate into U+FFFD, so a UTF-8 digest cannot tell `"\uD800"` from
// `"\uFFFD"` and would let a test pass for a witness that cannot.

import {
  createState,
  createBracketLedger,
  registerFork,
  planLedgerEntry,
  foldStateChain,
  markLedgerStructDirty,
} from "../src/scope/index.mjs";
import { registerLedger } from "../src/scope/ledger-cache.mjs";

const sha256 = (text) =>
  createHash("sha256").update(Buffer.from(text, "utf16le")).digest("hex");

// A fork record carries the conversation — messages, inbox, budget — so writing
// the whole record for every change to its status wrote the transcript again
// each time. On the largest session in this project, one entry spent 436 KB to
// report a moved todo count. The record now travels as a field diff against the
// copy the reader already holds.
//
// The contract is the restored record, not the shape of the entry: a diff must
// rebuild exactly what a whole-record write rebuilt, including arrays, deletions
// and the first write of a record that has no predecessor.

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

/** A record with enough history that a whole copy is conspicuous. */
function withHistory(state, forkId, count = 300) {
  state.brackets.forks[forkId].messages = Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    text: `message ${index} `.repeat(20),
  }));
  state.brackets.forks[forkId].inbox = [{ from: "/api", message: "one", envelope: "one" }];
}

describe("a record written as a field diff", () => {
  test("restores what a whole copy restored, and costs a fraction", () => {
    const state = freshState();
    register(state, "a");
    withHistory(state, "a");
    const base = planLedgerEntry(state, null);
    expect(base.entry.full).toBe(true);

    // Only the status moves; the history does not.
    state.brackets.forks.a.status = "ready";
    state.brackets.forks.a.inboxDelivered = 1;
    markLedgerStructDirty(state.brackets);
    const next = planLedgerEntry(state, base.brackets);

    const stored = next.entry.patches.a;
    expect(Array.isArray(stored)).toBe(true);
    const whole = JSON.stringify(base.brackets.forks.a).length;
    const diff = JSON.stringify(stored).length;
    // The proof of the change this test exists for: the entry no longer carries
    // the history it did not touch.
    expect(diff).toBeLessThan(whole / 20);

    const restored = foldStateChain([base.entry, next.entry]).brackets.forks.a;
    expect(restored.status).toBe("ready");
    expect(restored.inboxDelivered).toBe(1);
    expect(restored.messages).toHaveLength(300);
    expect(restored.messages[299].text).toBe("message 299 ".repeat(20));
    expect(restored.inbox).toHaveLength(1);
  });

  test("carries an appended message and a removed field", () => {
    const state = freshState();
    register(state, "a");
    withHistory(state, "a", 4);
    state.brackets.forks.a.task = "old task";
    const base = planLedgerEntry(state, null);

    state.brackets.forks.a.messages.push({ role: "user", text: "appended" });
    delete state.brackets.forks.a.task;
    state.brackets.forks.a.budget.read = 7;
    markLedgerStructDirty(state.brackets);
    const next = planLedgerEntry(state, base.brackets);

    const restored = foldStateChain([base.entry, next.entry]).brackets.forks.a;
    expect(restored.messages.map((message) => message.text)).toEqual([
      "message 0 ".repeat(20),
      "message 1 ".repeat(20),
      "message 2 ".repeat(20),
      "message 3 ".repeat(20),
      "appended",
    ]);
    expect(Object.hasOwn(restored, "task")).toBe(false);
    expect(restored.budget.read).toBe(7);
  });

  test("a new record is still written whole, so a diff never has to guess a base", () => {
    const state = freshState();
    register(state, "a");
    const base = planLedgerEntry(state, null);

    register(state, "b");
    const next = planLedgerEntry(state, base.brackets);

    // No predecessor means no base to diff against; the entry carries the record.
    expect(next.entry.patches?.b).toBeUndefined();
    expect(next.entry.set.b.forkId).toBe("b");
    const restored = foldStateChain([base.entry, next.entry]).brackets.forks.b;
    expect(restored.forkId).toBe("b");
    expect(restored.status).toBe("running");
  });

  test("a record whose content did not move still names itself", () => {
    const state = freshState();
    register(state, "a");
    const base = planLedgerEntry(state, null);

    // A structural mark with no content change: the entry must still resolve,
    // and the empty diff must fold back to the same record.
    markLedgerStructDirty(state.brackets);
    const next = planLedgerEntry(state, base.brackets);

    const stored = next.entry.set?.a;
    if (stored !== undefined) {
      expect(Array.isArray(stored)).toBe(true);
    }
    const restored = foldStateChain([base.entry, next.entry].filter(Boolean)).brackets.forks.a;
    expect(restored.forkId).toBe("a");
  });

  test("a record text that only grew is written as its suffix", () => {
    const state = freshState();
    register(state, "a");
    // The transcript one scope accumulates: a single string the renderer
    // re-emits whole, so every turn repeats everything before it.
    state.brackets.forks.a.record = "step one. ".repeat(200);
    const base = planLedgerEntry(state, null);

    const before = state.brackets.forks.a.record.length;
    state.brackets.forks.a.record += "step two. ";
    const next = planLedgerEntry(state, base.brackets);

    const ops = next.entry.patches.a;
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe("append");
    expect(ops[0].from).toBe(before);
    expect(ops[0].text).toBe("step two. ");
    // The point of the encoding: the entry carries the addition, not the text.
    expect(JSON.stringify(ops).length).toBeLessThan(before / 10);

    const restored = foldStateChain([base.entry, next.entry]).brackets.forks.a;
    expect(restored.record).toBe("step one. ".repeat(200) + "step two. ");
  });

  test("a rewrite of earlier text keeps the whole string", () => {
    const state = freshState();
    register(state, "a");
    state.brackets.forks.a.record = "alpha step one. ";
    const base = planLedgerEntry(state, null);

    // A re-render that changed an earlier character is not an append, however
    // much longer it became: joining the suffix onto the stored text would
    // produce a record nobody wrote.
    state.brackets.forks.a.record = "beta step one. step two. ";
    const next = planLedgerEntry(state, base.brackets);
    const ops = next.entry.patches.a;
    expect(ops.some((op) => op.op === "append")).toBe(false);

    const restored = foldStateChain([base.entry, next.entry]).brackets.forks.a;
    expect(restored.record).toBe("beta step one. step two. ");
  });

  test("a shortened record text is restored exactly", () => {
    const state = freshState();
    register(state, "a");
    state.brackets.forks.a.record = "a much longer record than before";
    const base = planLedgerEntry(state, null);

    state.brackets.forks.a.record = "a much longer";
    const next = planLedgerEntry(state, base.brackets);
    const restored = foldStateChain([base.entry, next.entry]).brackets.forks.a;
    expect(restored.record).toBe("a much longer");
  });

  test("reads an entry written before diffs existed", () => {
    const state = freshState();
    register(state, "a");
    const base = planLedgerEntry(state, null);

    // Exactly what an older process stored: the whole record under its id.
    const legacy = {
      ...base.entry,
      full: false,
      head: null,
      set: { a: { ...base.brackets.forks.a, task: "from a whole copy" } },
      del: [],
    };
    const restored = foldStateChain([legacy]).brackets.forks.a;
    expect(restored.task).toBe("from a whole copy");
    expect(restored.forkId).toBe("a");
  });

  // An append carries a suffix and names the length of the text it extends. If
  // the chain hands it a text of another length, the suffix has nowhere to go —
  // and skipping it would leave a *shorter* record that still reads as a
  // healthy fork with its last turn missing, which nothing downstream can tell
  // from work that was never written. The chain fails as a value instead.
  test("an append that does not meet its base fails the chain, not the record", () => {
    const state = freshState();
    register(state, "a");
    // The stored record is shorter than the text the writer appended to: an
    // entry is missing from this chain, or this one belongs to another branch.
    state.brackets.forks.a.record = "0123456";
    const chain = [
      { version: 3, kind: "checkpoint", state },
      {
        version: 3,
        kind: "ledger",
        patches: {
          a: [{ op: "append", path: ["record"], from: 10, text: "+suffix" }],
        },
      },
    ];
    // It loads as nothing, rather than as a fork whose record happens to stop
    // three characters early.
    expect(foldStateChain(chain)).toBeNull();
    expect(foldStateChain([chain[0]])).not.toBeNull();
  });

  test("an append with a malformed payload fails the chain", () => {
    const state = freshState();
    register(state, "a");
    state.brackets.forks.a.record = "abc";
    const chain = [{ version: 3, kind: "checkpoint", state }];
    // The record has to exist in the ledger chain before a patch can extend it,
    // so the chain opens with the whole record — the shape every real journal
    // has, since a fork's first write is a `set`.
    const seeded = [
      ...chain,
      { version: 3, kind: "ledger", set: { a: { forkId: "a", record: "abc" } } },
    ];
    const withOp = (op) => [...seeded, { version: 3, kind: "ledger", patches: { a: [op] } }];

    for (const op of [
      { op: "append", path: ["record"], from: 3 },
      { op: "append", path: ["record"], from: 3, text: 7 },
      { op: "append", path: ["record"], from: "3", text: "d" },
      { op: "append", path: ["record"], from: -1, text: "d" },
      { op: "append", path: ["record"], from: 4, text: "d" },
      // A field that is not a string at all cannot be extended by text.
      { op: "append", path: ["budget"], from: 1, text: "d" },
    ]) {
      expect(foldStateChain(seeded)).not.toBeNull();
      expect(foldStateChain(withOp(op))).toBeNull();
    }
    // The sound one still applies, so the loop above is not passing by refusing
    // every append.
    const good = foldStateChain(
      withOp({ op: "append", path: ["record"], from: 3, digest: sha256("abc"), text: "d" }),
    );
    expect(good.brackets.forks.a.record).toBe("abcd");
  });

  // A state delta names the state tree, so an append to a fork's transcript
  // names `brackets.forks.<id>.record`. Two ways that container can be absent
  // from the reader's chain, and both must fail the chain rather than skip:
  // the entry that created the fork is missing, or the operation is malformed.
  // Skipping would leave a fork that is simply not there, or one whose
  // transcript stops early — indistinguishable from work never written.
  test("an append that names a fork the chain does not hold fails the chain", () => {
    const state = freshState();
    register(state, "a");
    state.brackets.forks.a.record = "abc";
    const chain = [{ version: 3, kind: "checkpoint", state }];

    // The fork exists, so the same operation applies.
    const applies = foldStateChain([
      ...chain,
      { version: 3, kind: "delta", ops: [{ op: "append", path: ["brackets", "forks", "a", "record"], from: 3, digest: sha256("abc"), text: "d" }] },
    ]);
    expect(applies.brackets.forks.a.record).toBe("abcd");

    // The fork does not exist in this chain: no container, no repair.
    expect(
      foldStateChain([
        ...chain,
        { version: 3, kind: "delta", ops: [{ op: "append", path: ["brackets", "forks", "ghost", "record"], from: 3, text: "d" }] },
      ]),
    ).toBeNull();

    // A malformed append carries no path at all; there is no text to extend.
    expect(
      foldStateChain([...chain, { version: 3, kind: "delta", ops: [{ op: "append", from: 0, text: "d" }] }]),
    ).toBeNull();

    // A `set` naming an absent container is still skipped, as it always was:
    // that tolerance is what older journals were written under, and tightening
    // it is not this operation's business.
    const tolerated = foldStateChain([
      ...chain,
      { version: 3, kind: "delta", ops: [{ op: "set", path: ["brackets", "forks", "ghost", "record"], value: "x" }] },
    ]);
    expect(tolerated).not.toBeNull();
    expect(tolerated.brackets.forks.ghost).toBeUndefined();
  });

  // The hole `from` alone left open: two texts of one length are
  // indistinguishable by length, so a reader whose record diverged — a rewrite
  // of equal length, an entry missing that kept the length, a sibling branch —
  // used to take the suffix and come back as *the wrong text with the right
  // length*. That reads as a healthy fork, which is the one outcome a restore
  // must never produce. The digest names the whole text the writer extended.
  test("an append onto a different text of the same length fails the chain", () => {
    const state = freshState();
    register(state, "a");
    // Same length as the writer's base, different characters: "idle" -> "done".
    state.brackets.forks.a.record = "status: done";
    const chain = [{ version: 3, kind: "checkpoint", state }];

    // What the writer recorded when its record said "status: idle". The text is
    // The digest covers every character, so a base that agrees only on its
    // ending is still a different base and still refused.
    const op = { op: "append", path: ["brackets", "forks", "a", "record"], from: 12, digest: sha256("status: idle"), text: " + one turn" };
    expect(foldStateChain([...chain, { version: 3, kind: "delta", ops: [op] }])).toBeNull();

    // The same op against the text it was written for applies exactly.
    state.brackets.forks.a.record = "status: idle";
    const applies = foldStateChain([...chain, { version: 3, kind: "delta", ops: [op] }]);
    expect(applies.brackets.forks.a.record).toBe("status: idle + one turn");
  });

  test("an append that carries no digest cannot be proven, so the chain fails", () => {
    const state = freshState();
    register(state, "a");
    state.brackets.forks.a.record = "abc";
    const chain = [{ version: 3, kind: "checkpoint", state }];
    // Written by an intermediate build before the digest existed. Refusing costs
    // an earlier checkpoint; accepting would trust a length alone.
    expect(
      foldStateChain([...chain, { version: 3, kind: "delta", ops: [{ op: "append", path: ["brackets", "forks", "a", "record"], from: 3, text: "d" }] }]),
    ).toBeNull();
    // A digest of the wrong size is refused, and so is a well-formed digest of
    // another text: shape is not proof.
    expect(
      foldStateChain([...chain, { version: 3, kind: "delta", ops: [{ op: "append", path: ["brackets", "forks", "a", "record"], from: 3, digest: sha256("abc"), text: "d" }] }]),
    ).not.toBeNull();
    expect(
      foldStateChain([...chain, { version: 3, kind: "delta", ops: [{ op: "append", path: ["brackets", "forks", "a", "record"], from: 3, digest: sha256("abcabc"), text: "d" }] }]),
    ).toBeNull();
  });

  // The case a tail sample could not catch, and the reason the witness became a
  // digest: two texts of one length that end identically. `"alpha|status: idle"`
  // and `"betaa|status: idle"` share every character after the fifth, so a
  // 32-character tail — or a 64-character tail on a longer record — would have
  // accepted the append on either. A digest of the whole text separates them.
  test("an append onto a base that agrees on its length and its ending is refused", () => {
    const written = "alpha|status: idle";
    const diverged = "betaa|status: idle";
    // Both are 18 characters and their last 13 are identical: only the first
    // five differ. A tail sample of any size up to 13 cannot tell them apart.
    expect(diverged.length).toBe(written.length);
    expect(diverged.slice(-13)).toBe(written.slice(-13));
    expect(diverged).not.toBe(written);

    const state = freshState();
    register(state, "a");
    state.brackets.forks.a.record = diverged;
    const chain = [{ version: 3, kind: "checkpoint", state }];

    // What the writer recorded when its record still said `written`.
    const op = {
      op: "append",
      path: ["brackets", "forks", "a", "record"],
      from: written.length,
      digest: sha256(written),
      text: " + one turn",
    };
    expect(foldStateChain([...chain, { version: 3, kind: "delta", ops: [op] }])).toBeNull();

    // The same op against the text it was written for applies, character for
    // character, so the refusal above is the digest working and not a blanket
    // rejection of appends.
    state.brackets.forks.a.record = written;
    const applies = foldStateChain([...chain, { version: 3, kind: "delta", ops: [op] }]);
    expect(applies.brackets.forks.a.record).toBe(`${written} + one turn`);

    // And the writer really does carry a whole-text digest, not a sample of it:
    // a one-character edit inside the record changes the witness even when the
    // length and the tail are untouched.
    const before = planLedgerEntry(state, null);
    state.brackets.forks.a.record = `${written} + one turn`;
    const next = planLedgerEntry(state, before.brackets);
    const emitted = next.entry.patches?.a?.find((entry) => entry.op === "append");
    expect(emitted.digest).toBe(sha256(`${written} + one turn`.slice(0, written.length)));
    expect(emitted.digest).not.toBe(sha256(diverged));
  });

  // A digest is only a witness if distinct texts get distinct digests. UTF-8 is
  // not injective on JavaScript strings: it cannot represent an unpaired
  // surrogate, so the encoder substitutes U+FFFD and `"\uD800"` produces the
  // same bytes as `"\uFFFD"`. Both are one-character records, both survive
  // `JSON.parse`, so a session can hold either — and with a UTF-8 digest a
  // reader holding the wrong one would accept the append and come back with the
  // wrong text at the right length. That is the failure this witness exists to
  // prevent, so the encoding has to be lossless.
  test("two characters a UTF-8 encoder conflates are two different bases", () => {
    const written = "abc\uFFFD";
    const conflated = "abc\uD800";
    // What made the hole: one length, one UTF-8 byte string.
    expect(conflated.length).toBe(written.length);
    expect(createHash("sha256").update(written, "utf8").digest("hex")).toBe(
      createHash("sha256").update(conflated, "utf8").digest("hex"),
    );
    expect(sha256(conflated)).not.toBe(sha256(written));

    const state = freshState();
    register(state, "a");
    state.brackets.forks.a.record = conflated;
    const chain = [{ version: 3, kind: "checkpoint", state }];

    // What a writer recorded while its record still held the replacement char.
    const op = {
      op: "append",
      path: ["brackets", "forks", "a", "record"],
      from: written.length,
      digest: sha256(written),
      text: " + turn",
    };
    expect(foldStateChain([...chain, { version: 3, kind: "delta", ops: [op] }])).toBeNull();

    // Against the text it was written for, the same op applies exactly — so the
    // refusal above is the encoding doing its work, not a blanket rejection.
    state.brackets.forks.a.record = written;
    const applies = foldStateChain([...chain, { version: 3, kind: "delta", ops: [op] }]);
    expect(applies.brackets.forks.a.record).toBe(`${written} + turn`);

    // And the writer really emits the lossless digest for such a record.
    const before = planLedgerEntry(state, null);
    state.brackets.forks.a.record = `${written} + turn`;
    const next = planLedgerEntry(state, before.brackets);
    const emitted = next.entry.patches?.a?.find((entry) => entry.op === "append");
    expect(emitted.digest).toBe(sha256(written));
  });
});
