import { describe, expect, test } from "bun:test";
import { activate } from "../../host-omp-ui/src/main.mjs";

// A real manager and websocket are used, but all ports and credentials belong
// to this test. No TUI editor or renderer is needed for an RPC main session.
function host() {
  const handlers = new Map();
  const commands = new Map();
  const sent = [];
  return {
    pi: {},
    sent,
    async sendUserMessage(content) { sent.push(content); },
    handlers,
    registerMessageRenderer() {},
    registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) { handlers.set(name, handler); },
    registerTool() {}, registerShortcut() {}, registerFlag() {}, setLabel() {},
    getFlag() {},
  };
}

function context(kind = "main") {
  return {
    mode: "rpc", hasUI: false, agent: { kind, id: kind }, cwd: "/tmp",
    // An RPC session must never touch a TUI slot, even if a host exposes one.
    get ui() { throw new Error("RPC must not access a TUI surface"); },
    sessionManager: {
      getSessionId: () => "rpc-session-1", getSessionFile: () => "/tmp/rpc-session-1.jsonl",
      getSessionName: () => "RPC session", getCwd: () => "/tmp", getSessionDir: () => "/tmp",
      getBranch: () => [], getEntries: () => [], getLeafId: () => null,
      getUsageStatistics: () => ({}),
    },
    models: { list: () => [], current: () => null, resolve: () => undefined },
    getContextUsage: () => null, isIdle: () => true, abort() {},
  };
}

async function eventually(fn, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last; } catch {}
    await Bun.sleep(25);
  }
  throw new Error(`Expected manager state not observed: ${JSON.stringify(last)}`);
}

async function fixture(kind = "main") {
  const blocker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = blocker.port;
  blocker.stop(true);
  const token = `rpc-test-${crypto.randomUUID()}`;
  const pi = host();
  const ctx = context(kind);
  await activate(pi, { port, token });
  await pi.handlers.get("session_start")({ type: "session_start" }, ctx);
  const url = `http://127.0.0.1:${port}`;
  return {
    pi, ctx, url, token,
    async instances() {
      const response = await fetch(`${url}/api/instances`, { headers: { Authorization: `Bearer ${token}` } });
      return response.ok ? response.json() : [];
    },
    async close() { await pi.handlers.get("session_shutdown")({ type: "session_shutdown" }, ctx); },
  };
}

describe("non-TUI manager instances", () => {
  test("an RPC main session registers without a TUI and unregisters on shutdown", async () => {
    const f = await fixture();
    try {
      const instances = await eventually(async () => {
        const rows = await f.instances();
        return rows.find((row) => row.session?.id === "rpc-session-1") ? rows : null;
      });
      const instance = instances.find((row) => row.session.id === "rpc-session-1");
      expect(instance.session.cwd).toBe("/tmp");
      expect(instance.mode).toBe("rpc");
      expect(instance.capabilities.canCompose).toBe(true);
      expect(instance.capabilities.canUseTuiSurface).toBe(false);
    } finally {
      await f.close();
    }
    await eventually(async () => {
      try { const rows = await f.instances(); return !rows.some((row) => row.session?.id === "rpc-session-1"); }
      catch { return true; } // The last registered instance may stop the manager.
    });
  }, 10000);

  test("an RPC subagent is not advertised as another user instance", async () => {
    const f = await fixture("sub");
    try {
      await Bun.sleep(150);
      let rows = [];
      try { rows = await f.instances(); } catch {}
      expect(rows.some((row) => row.session?.id === "rpc-session-1")).toBe(false);
    } finally { await f.close(); }
  });

  test("the manager submits plain text without a TUI editor", async () => {
    const f = await fixture();
    let socket;
    try {
      const rows = await eventually(async () => {
        const current = await f.instances();
        return current.find((row) => row.session?.id === "rpc-session-1") ? current : null;
      });
      const selected = rows.find((row) => row.session.id === "rpc-session-1");
      const frames = [];
      socket = new WebSocket(`${f.url.replace("http:", "ws:")}/ws?token=${encodeURIComponent(f.token)}`);
      socket.onmessage = (event) => frames.push(JSON.parse(event.data));
      await eventually(() => socket.readyState === WebSocket.OPEN);
      socket.send(JSON.stringify({ type: "manager.select", instanceId: selected.instanceId, requestId: "select-rpc" }));
      await eventually(() => frames.some((frame) => frame.type === "snapshot"));
      socket.send(JSON.stringify({ type: "composer.submit", payload: { text: "not submitted", requestId: "submit-rpc" } }));
      const result = await eventually(() => frames.find((frame) => frame.type === "command.result" && frame.requestId === "submit-rpc"));
      expect(result.ok).toBe(true);
      expect(f.pi.sent).toContain("not submitted");
    } finally { socket?.close(); await f.close(); }
  }, 10000);
});
