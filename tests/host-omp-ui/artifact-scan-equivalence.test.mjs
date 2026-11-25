import { describe, expect, test } from "bun:test";

import { createUiBridgeStation } from "../../host-omp-ui/src/station/ui-bridge-station.mjs";
import {
  buildHistoryIndex,
  reconstructRange,
} from "../../host-omp-ui/src/station/domain/transcript-model.mjs";
import { createArtifactCollector } from "../../host-omp-ui/src/station/domain/tool-artistry.mjs";

// Hydration lists every file the session touched, and it used to find them by
// projecting every message in the branch. That is a whole-transcript tour to
// answer a question about file paths — two thirds of hydration on a long
// session. It now projects only the messages that can carry a tool call.
//
// The list must not change because of that. The projection that used to run is
// therefore reproduced here as the reference, and the two must agree on a branch
// that holds every shape a session can contain: several tool calls in one
// message, a call whose result is far away, the execution roles that build their
// blocks without reading content, an unknown block type that merely looks like a
// call, and two calls naming the same file.

const itemsOf = (message) => ({
  toolCall: message.blocks?.find((block) => block.type === "toolCall"),
  toolResult: message.role === "toolResult" ? message : undefined,
});

/** The scan hydration used to run: every message, in order, first call wins. */
function artifactsByFullScan(entries) {
  const index = buildHistoryIndex(entries);
  const total = index.entryOfMessage.length;
  const collector = createArtifactCollector();
  for (let ordinal = 0; ordinal < total; ordinal += 1) {
    collector.add(reconstructRange(entries, ordinal, ordinal + 1, index).map(itemsOf));
  }
  return collector.list();
}

/** What hydration answers now, read from the station's own frame. */
function artifactsFromHydration(entries) {
  const station = createUiBridgeStation({ capabilities: { dispatch() {} } });
  station.onSessionHydrate({ id: "s1", cwd: "/tmp" }, entries);
  return station.snapshot(1).artifacts;
}

const messageEntry = (id, role, content, extra = {}) => ({
  type: "message",
  id,
  timestamp: 1,
  message: { role, content, ...extra },
});

const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const text = (value) => [{ type: "text", text: value }];

/**
 * A branch with every shape the scan has to agree about.
 *
 * The calls are spread out so the interesting ones sit in different project
 * ranges than their results, and several entries sit between them that must
 * contribute nothing at all.
 */
function branch() {
  return [
    // A write, with its result far away.
    messageEntry("m1", "assistant", [call("c1", "write", { path: "/work/a.txt", content: "one" })]),
    messageEntry("m2", "user", text("keep going")),
    // Two calls in one message: the projection takes the first block only.
    messageEntry("m3", "assistant", [
      call("c2", "write", { path: "/work/first.txt", content: "first" }),
      call("c3", "write", { path: "/work/second.txt", content: "second" }),
    ]),
    // An unknown block type that looks like a call must stay unknown: the
    // projection only maps `type === "toolCall"`, and so does the scan.
    messageEntry("m4", "assistant", [{ type: "tool_use", name: "write", args: { path: "/work/ghost.txt" } }]),
    // The roles that build their blocks without reading content.
    messageEntry("m5", "bashExecution", text("ls"), { command: "ls", output: "a.txt" }),
    messageEntry("m6", "pythonExecution", text("print(1)"), { code: "print(1)", output: "1" }),
    messageEntry("m7", "fileMention", text("ignored"), { path: "/work/a.txt" }),
    // A read of a file already written: the path is listed once, as the write.
    messageEntry("m8", "assistant", [call("c4", "read", { path: "/work/a.txt" })]),
    // The results, all of them far from their calls.
    messageEntry("m9", "toolResult", text("wrote a.txt"), { toolCallId: "c1" }),
    messageEntry("m10", "toolResult", text("one"), { toolCallId: "c4" }),
    // An edit that produces a different path, and a bash call that produces none.
    messageEntry("m11", "assistant", [call("c5", "edit", { path: "/work/b.txt", old_string: "x", new_string: "y" })]),
    messageEntry("m12", "assistant", [call("c6", "bash", { command: "ls -la" })]),
    // String content, which yields a text block and no call.
    messageEntry("m13", "user", "plain string content"),
    // A call with no path: no artifact, and it must not disturb the order.
    messageEntry("m14", "assistant", [call("c7", "read", {})]),
    // The entry kinds that project to text only.
    { type: "custom_message", id: "x1", customType: "note", content: "note text", timestamp: 4 },
    { type: "branch_summary", id: "b1", summary: "branch said", timestamp: 5 },
    { type: "compaction", id: "k1", summary: "compacted", timestamp: 6 },
  ];
}

describe("the artifact list", () => {
  test("is the same list the whole-transcript scan produced", () => {
    const entries = branch();
    const scanned = artifactsByFullScan(entries);
    const hydrated = artifactsFromHydration(entries);

    expect(hydrated).toEqual(scanned);
    // And that list is the one a reader expects, in the order the calls appear.
    expect(scanned.map((artifact) => artifact.path)).toEqual([
      "/work/a.txt",
      "/work/first.txt",
      "/work/b.txt",
    ]);
    expect(scanned.map((artifact) => artifact.kind)).toEqual(["write", "write", "edit"]);
  });

  test("ignores a call whose block type is not exactly toolCall", () => {
    const entries = branch();
    const paths = artifactsByFullScan(entries).map((artifact) => artifact.path);
    // `tool_use` is carried through by the projection untouched, so nothing
    // finds it; the scan must not be more willing than the collector.
    expect(paths).not.toContain("/work/ghost.txt");
  });

  test("lists each path once, first call wins", () => {
    const entries = branch();
    const artifacts = artifactsFromHydration(entries);
    const forA = artifacts.filter((artifact) => artifact.path === "/work/a.txt");
    expect(forA).toHaveLength(1);
    // The write came before the read.
    expect(forA[0].kind).toBe("write");
  });

  test("takes the first tool call of a message that holds several", () => {
    const entries = branch();
    const paths = artifactsFromHydration(entries).map((artifact) => artifact.path);
    expect(paths).toContain("/work/first.txt");
    expect(paths).not.toContain("/work/second.txt");
  });
});

describe("the shapes the scan must not skip", () => {
  test("an assistant call whose content is not an array still contributes nothing", () => {
    const entries = [
      messageEntry("s1", "assistant", "a call written as a string"),
      messageEntry("s2", "assistant", [call("c1", "write", { path: "/work/real.txt", content: "x" })]),
    ];
    expect(artifactsFromHydration(entries)).toEqual(artifactsByFullScan(entries));
    expect(artifactsFromHydration(entries).map((artifact) => artifact.path)).toEqual(["/work/real.txt"]);
  });

  test("a call under an execution role never reaches the list, and the scan agrees", () => {
    const entries = [
      // These roles build their blocks from their own fields, so a call in
      // their content is invisible to the projection — the scan must not
      // project them and then believe it found one.
      messageEntry("e1", "bashExecution", [call("c1", "write", { path: "/work/hidden.txt", content: "x" })], {
        command: "true",
        output: "",
      }),
      messageEntry("e2", "pythonExecution", [call("c2", "write", { path: "/work/hidden2.txt", content: "x" })], {
        code: "pass",
        output: "",
      }),
      messageEntry("e3", "fileMention", [call("c3", "write", { path: "/work/hidden3.txt", content: "x" })], {
        path: "/work/hidden3.txt",
      }),
      messageEntry("e4", "assistant", [call("c4", "write", { path: "/work/shown.txt", content: "x" })]),
    ];
    const hydrated = artifactsFromHydration(entries);
    expect(hydrated).toEqual(artifactsByFullScan(entries));
    expect(hydrated.map((artifact) => artifact.path)).toEqual(["/work/shown.txt"]);
  });

  test("an empty branch lists nothing", () => {
    expect(artifactsFromHydration([])).toEqual([]);
  });

  test("a branch with no tool calls lists nothing", () => {
    const entries = [
      messageEntry("t1", "user", text("hello")),
      messageEntry("t2", "assistant", text("hi")),
      messageEntry("t3", "toolResult", text("out"), { toolCallId: "none" }),
    ];
    expect(artifactsFromHydration(entries)).toEqual([]);
    expect(artifactsFromHydration(entries)).toEqual(artifactsByFullScan(entries));
  });
});

describe("the cost of the scan", () => {
  test("projects the calls, not the transcript", () => {
    // A branch that is mostly plain conversation with a handful of calls: the
    // scan used to project every message, and the number of calls is what the
    // answer is made of.
    const entries = [];
    for (let index = 0; index < 400; index += 1) {
      entries.push(messageEntry(`f${index}`, index % 2 ? "assistant" : "user", text(`talk ${index}`)));
      if (index % 100 === 0) {
        entries.push(
          messageEntry(`w${index}`, "assistant", [
            call(`wc${index}`, "write", { path: `/work/${index}.txt`, content: "x" }),
          ]),
        );
      }
    }
    const started = performance.now();
    const hydrated = artifactsFromHydration(entries);
    const elapsed = performance.now() - started;

    expect(hydrated.map((artifact) => artifact.path)).toEqual([
      "/work/0.txt",
      "/work/100.txt",
      "/work/200.txt",
      "/work/300.txt",
    ]);
    // A per-message projection of 404 entries would still be far below this on
    // its own; the bound guards the shape, not a measured ratio.
    expect(elapsed).toBeLessThan(200);
  });
});
