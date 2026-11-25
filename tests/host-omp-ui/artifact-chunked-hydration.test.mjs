import { describe, expect, test } from "bun:test";

import { createArtifactCollector, extractArtifacts } from "../../host-omp-ui/src/station/domain/tool-artistry.mjs";
import { reconstructRange, reconstructTranscriptFromEntries, buildHistoryIndex } from "../../host-omp-ui/src/station/domain/transcript-model.mjs";

// Hydration reads the whole branch to list artifacts — the list describes every
// file the session touched, not just the ones near the tail. It reads the branch
// in strips so the peak allocation is one strip rather than one transcript.
//
// The list must not change because of that: same paths, same order, same
// first-wins rule. A path written early and read much later is still one entry,
// and it keeps the write — including when the two calls land in different
// strips, which is the only case the chunking could get wrong.

const text = (value) => [{ type: "text", text: value }];

const toolCallMessage = (id, calls) => ({
  id,
  type: "message",
  timestamp: 1,
  message: {
    role: "assistant",
    content: calls.map((call) => ({
      type: "toolCall",
      id: call.id,
      name: call.name,
      args: call.args,
    })),
  },
});

/** A tool result entry, which the projection pairs onto the call's block. */
const toolResultEntry = (id, toolCallId, body) => ({
  id,
  type: "message",
  timestamp: 2,
  message: {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: text(body),
  },
});

const userEntry = (id, body) => ({
  id,
  type: "message",
  timestamp: 0,
  message: { role: "user", content: text(body) },
});

/** The projection hydration applies to every message, before collecting. */
const itemsOf = (messages) =>
  messages.map((message) => ({
    toolCall: message.blocks?.find((block) => block.type === "toolCall"),
    toolResult: message.role === "toolResult" ? message : undefined,
  }));

/** A branch whose calls straddle the 512-message strip boundary. */
function longBranch() {
  const entries = [userEntry("u0", "start")];
  // A write near the beginning of the branch.
  entries.push(
    toolCallMessage("a0", [
      { id: "c-write", name: "write", args: { path: "/work/early.txt", content: "one" } },
    ]),
  );
  entries.push(toolResultEntry("r0", "c-write", "wrote early.txt"));
  // Enough filler that the next call lands in a later strip.
  for (let index = 0; index < 700; index += 1) {
    entries.push(userEntry(`u-fill-${index}`, `filler ${index}`));
  }
  // The same path again, as a read: first wins, so this must not replace the
  // write — and it arrives in a different strip from the write.
  entries.push(
    toolCallMessage("a1", [
      { id: "c-read", name: "read", args: { path: "/work/early.txt" } },
    ]),
  );
  entries.push(toolResultEntry("r1", "c-read", "one"));
  // A distinct file late in the branch still has to appear.
  entries.push(
    toolCallMessage("a2", [
      { id: "c-write2", name: "write", args: { path: "/work/late.txt", content: "two" } },
    ]),
  );
  entries.push(toolResultEntry("r2", "c-write2", "wrote late.txt"));
  return entries;
}

/** What hydration used to do: project everything, then collect once. */
function artifactsWholeBranch(entries) {
  return extractArtifacts(itemsOf(reconstructTranscriptFromEntries(entries)));
}

/** What hydration does now: collect strip by strip from the same branch. */
function artifactsInStrips(entries, strip) {
  const index = buildHistoryIndex(entries);
  const total = index.entryOfMessage.length;
  const collector = createArtifactCollector();
  for (let from = 0; from < total; from += strip) {
    const to = Math.min(total, from + strip);
    collector.add(itemsOf(reconstructRange(entries, from, to, index)));
  }
  return collector.list();
}

describe("artifacts collected strip by strip", () => {
  test("equal the whole-branch list, including a path that straddles strips", () => {
    const entries = longBranch();
    const whole = artifactsWholeBranch(entries);

    expect(artifactsInStrips(entries, 512)).toEqual(whole);
    // The early write survives the later read of the same path.
    expect(whole.map((artifact) => artifact.path)).toEqual([
      "/work/early.txt",
      "/work/late.txt",
    ]);
    expect(whole[0].kind).toBe("write");
  });

  test("do not depend on the strip size", () => {
    const entries = longBranch();
    const whole = artifactsWholeBranch(entries);
    for (const strip of [1, 2, 7, 64, 512, 5000]) {
      expect(artifactsInStrips(entries, strip)).toEqual(whole);
    }
  });

  test("match on an empty branch and on a branch with nothing to list", () => {
    expect(artifactsInStrips([], 512)).toEqual([]);
    const plain = [userEntry("u1", "hello"), userEntry("u2", "again")];
    expect(artifactsInStrips(plain, 512)).toEqual(artifactsWholeBranch(plain));
    expect(artifactsInStrips(plain, 512)).toEqual([]);
  });

  test("a collector fed in several batches agrees with one fed at once", () => {
    const entries = longBranch();
    const items = itemsOf(reconstructTranscriptFromEntries(entries));

    const once = createArtifactCollector();
    once.add(items);

    const split = createArtifactCollector();
    for (let at = 0; at < items.length; at += 3) split.add(items.slice(at, at + 3));

    expect(split.list()).toEqual(once.list());
    expect(once.list()).toEqual(extractArtifacts(items));
  });
});
