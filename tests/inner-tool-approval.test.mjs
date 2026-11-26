// The inner host-tool call must carry the session's settings into approval.
//
// The host's extension wrapper resolves the approval mode from
// `context.settings`. An extension context carries none, so a forwarded
// context resolves to always-ask: the root would prompt, and a child — which
// has no interactive UI — would throw before the tool could run. Attaching the
// session's settings restores `tools.approvalMode` as the one owner.

import { describe, expect, test } from "bun:test";

import { createTools } from "../src/tools/catalog.mjs";
import { textResult } from "../src/tools/results.mjs";

const HOST_CTX = {
  hasUI: false,
  sessionManager: { getSessionId: () => "session-1" },
};

function stationWith(settings) {
  const seen = [];
  const station = {
    beginJsCall: () => ({ mode: "CHILD", tools: ["bash"], state: {}, signature: "x" }),
    finishJsCall: () => {},
    host: {
      session: { settingsOf: () => settings },
      tools: {
        execute: (name, id, args, signal, onUpdate, ctx) => {
          seen.push({ name, ctx });
          return textResult("ok");
        },
      },
    },
  };
  return { seen, station };
}

describe("an inner host tool's approval context", () => {
  test("carries the session settings and keeps the extension context", async () => {
    const settings = { tools: { approvalMode: "yolo" } };
    const { seen, station } = stationWith(settings);
    const [tool] = createTools({ stationFor: () => station, tickets: {} });
    await tool.execute(
      "call-1",
      { code: 'await api.bash({ command: "echo x" })' },
      null,
      null,
      HOST_CTX,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].ctx.settings).toBe(settings);
    // The wrapper still reads the rest of the context: session id for the
    // approval record, the UI fence, the tool-call preview.
    expect(seen[0].ctx.sessionManager.getSessionId()).toBe("session-1");
    expect(seen[0].ctx.hasUI).toBe(false);
  });

  test("forwards the context unchanged when the station has no settings reader", async () => {
    const seen = [];
    const station = {
      beginJsCall: () => ({ mode: "CHILD", tools: ["bash"], state: {}, signature: "x" }),
      finishJsCall: () => {},
      host: {
        tools: {
          execute: (name, id, args, signal, onUpdate, ctx) => {
            seen.push(ctx);
            return textResult("ok");
          },
        },
      },
    };
    const [tool] = createTools({ stationFor: () => station, tickets: {} });
    await tool.execute("call-2", { code: 'await api.bash({ command: "echo x" })' }, null, null, HOST_CTX);
    expect(seen[0]).toBe(HOST_CTX);
  });
});
