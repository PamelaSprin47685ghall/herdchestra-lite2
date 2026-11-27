// Both card mappers are built on one shared core: `station/domain/tool-artistry.mjs`
// (the extension) and `web/src/protocol/tool-view.ts` (the browser) take their
// stripping, language table and scope-control projection from
// `host-omp-ui/shared/tool-view.mjs`. This file is the cross-surface check that
// the two thin wrappers keep producing the same cards from that core.
//
// The cases below are the ones the Node suite pins for the extension copy: a
// `js` call showing one child per inner call, and the scope control plane that
// would otherwise fall through to a raw JSON card. Both copies must agree on the
// card kind and on what each field carries.

import { describe, expect, test } from "bun:test";
import { describeTool } from "../../host-omp-ui/web/src/protocol/tool-view";

function execution(name: string, args: Record<string, unknown>, text = "", isError = false) {
  return {
    id: `${name}-1`,
    name,
    status: isError ? ("failed" as const) : ("completed" as const),
    args,
    result: { content: [{ type: "text", text }] },
    isError,
  };
}

describe("the js card", () => {
  test("renders one child per inner call and strips the REPL echo", () => {
    const view = describeTool({
      ...execution("js", { code: "await api.write(...)" }, "> await AsyncFunction('api')\nwrote 1 file"),
      details: {
        innerCalls: [
          { name: "write", args: { path: "src/a.mjs", content: "one" }, resultText: "ok" },
          { name: "bash", args: { command: "false" }, resultText: "exit 1", isError: true },
        ],
      },
    });
    expect(view.kind).toBe("eval");
    if (view.kind !== "eval") return;
    expect(view.output).toBe("wrote 1 file");
    expect(view.children?.map((child) => child.kind)).toEqual(["write", "bash"]);
    expect(view.children?.[0].path).toBe("src/a.mjs");
    expect(view.children?.[1].isError).toBe(true);
  });

  test("a js call without inner calls renders no children", () => {
    const view = describeTool(execution("js", { code: "1 + 1" }, "> await AsyncFunction(\n2"));
    if (view.kind !== "eval") throw new Error(`expected eval, got ${view.kind}`);
    expect(view.children).toBeUndefined();
    expect(view.output).toBe("2");
  });
});

describe("the scope control plane", () => {
  test("scope_request asks, and shows the reply once it returned", () => {
    const waiting = describeTool(
      execution("scope_request", { target: "/api", message: "字段名？", interrupt: true }),
    );
    expect(waiting.kind).toBe("ask");
    if (waiting.kind !== "ask") return;
    expect(waiting.title).toBe("scope_request → /api");
    expect(waiting.summary).toContain("→ /api · interrupt: 字段名？");

    const answered = describeTool(execution("scope_request", { target: "/api", message: "字段名？" }, "accessToken"));
    if (answered.kind !== "ask") throw new Error(`expected ask, got ${answered.kind}`);
    expect(answered.summary).toContain("← accessToken");
  });

  test("scope_reply reads as an answer", () => {
    const reply = describeTool(execution("scope_reply", {}, "accessToken"));
    expect(reply.kind).toBe("ask");
    if (reply.kind !== "ask") return;
    expect(reply.summary).toBe("← accessToken");
  });

  test("scope_fork lists the batch and scope_join shows the record", () => {
    const fork = describeTool(
      execution(
        "scope_fork",
        { forks: [{ scopeId: "api", fsm: "S1 audit\nS2 fix" }, { scopeId: "ui", fsm: "polish" }] },
        "Started (2): /api, /ui",
      ),
    );
    expect(fork.kind).toBe("task");
    if (fork.kind !== "task") return;
    expect(fork.title).toBe("scope_fork (2)");
    expect(fork.agent).toBe("scope_fork");
    expect(fork.prompt).toContain("api — S1 audit");
    expect(fork.prompt).toContain("ui — polish");
    expect(fork.result).toContain("Started (2)");

    const join = describeTool(execution("scope_join", {}, "Record from /api: done"));
    if (join.kind !== "task") throw new Error(`expected task, got ${join.kind}`);
    expect(join.title).toBe("scope_join");
    expect(join.result).toContain("Record from /api");
  });

  test("scope_return tells a rewind from a seal", () => {
    const rewind = describeTool(execution("scope_return", { scope: "/api", dafny: "done" }, "Rewound."));
    if (rewind.kind !== "task") throw new Error(`expected task, got ${rewind.kind}`);
    expect(rewind.title).toBe("scope_return /api");
    expect(rewind.prompt).toBe("rewind");

    const seal = describeTool(
      execution(
        "scope_return",
        {
          dafny: "done",
          signed_sealed_hands_off_nothing_left_on_the_table:
            "a_ferocious_audacious_master_would_change_nothing",
        },
        "Sealed.",
      ),
    );
    if (seal.kind !== "task") throw new Error(`expected task, got ${seal.kind}`);
    expect(seal.title).toBe("scope_return");
    expect(seal.prompt).toBe("seal");
  });
});
