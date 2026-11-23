import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagerServer } from "../../host-omp-ui/src/manager/server.mjs";
import { scanMachineSessions } from "../../host-omp-ui/src/manager/machine-catalog.mjs";

// Contract: manager passes { extraDirs } to onListSessions and ensureSession.
// Registered sessionDir values remain known after an agent disconnects until
// the manager itself stops, so its historical conversations stay accessible.
const token = "catalog-integration-token";
function connect(url) {
 return new Promise((resolve, reject) => {
  const ws = new WebSocket(url); const frames = []; const waiters = [];
  const timeout = setTimeout(() => reject(new Error("open timed out")), 3000);
  ws.onerror = () => { clearTimeout(timeout); reject(new Error("websocket failed")); };
  ws.onmessage = ({ data }) => {
   const frame = JSON.parse(String(data)); const index = waiters.findIndex((w) => w.match(frame));
   if (index < 0) frames.push(frame); else { const [w] = waiters.splice(index, 1); clearTimeout(w.timer); w.resolve(frame); }
  };
  ws.onopen = () => { clearTimeout(timeout); resolve({ ws, send: (f) => ws.send(JSON.stringify(f)), next(match) {
   const index = frames.findIndex(match); if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]);
   return new Promise((resolve, reject) => { const w = { match, resolve, timer: setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); reject(new Error("frame timed out")); }, 3000) }; waiters.push(w); });
  } }); };
 });
}

test("machine catalogue includes all registered custom directories and retains them after disconnect", async () => {
 const root = await mkdtemp(join(tmpdir(), "omp-manager-catalog-"));
 const a = join(root, "a"), b = join(root, "b"); await mkdir(a); await mkdir(b);
 await writeFile(join(a, "one.jsonl"), JSON.stringify({ type: "session", id: "history-a", cwd: "/project-a", timestamp: "2025-01-01T00:00:00Z" }) + "\n");
 await writeFile(join(b, "two.jsonl"), JSON.stringify({ type: "session", id: "history-b", cwd: "/project-b", timestamp: "2025-01-01T00:00:00Z" }) + "\n");
 const calls = [];
 const list = async ({ extraDirs = [] } = {}) => { calls.push(extraDirs); return (await scanMachineSessions({ roots: [], extraDirs })).sessions; };
 const manager = await createManagerServer({ preferredPort: 0, token, idleTimeoutMs: 5000, onListSessions: list });
 const sockets = [];
 try {
  const url = manager.url.replace(/^http/, "ws");
  for (const [id, dir] of [["instance-a", a], ["instance-b", b]]) {
   const agent = await connect(`${url}/agent?token=${token}`); sockets.push(agent.ws);
   agent.send({ type: "agent.register", instanceId: id, pid: process.pid, session: { id: `live-${id}`, cwd: root, sessionDir: dir }, snapshot: { type: "snapshot" } });
   await agent.next((f) => f.type === "manager.registered");
  }
  const fetchSessions = async () => { const response = await fetch(`${manager.url}/api/sessions`, { headers: { authorization: `Bearer ${token}` } }); expect(response.status).toBe(200); return await response.json(); };
  const before = await fetchSessions();
  expect(before.map((s) => s.id).sort()).toEqual(["history-a", "history-b"]);
  expect(calls.at(-1).sort()).toEqual([a, b].sort());
  sockets[1].close();
  const browser = await connect(`${url}/ws?token=${token}`); sockets.push(browser.ws);
  await browser.next((f) => f.type === "manager.instances" && f.instances.length === 1);
  const after = await fetchSessions();
  expect(after.map((s) => s.id).sort()).toEqual(["history-a", "history-b"]);
 } finally { for (const ws of sockets) ws.close(); await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test("opening an idle conversation uses the same aggregated catalogue as listing", async () => {
 const root = await mkdtemp(join(tmpdir(), "omp-manager-open-catalog-"));
 const a = join(root, "a"), b = join(root, "b"); await mkdir(a); await mkdir(b);
 await writeFile(join(b, "history.jsonl"), JSON.stringify({ type: "session", id: "history-b", cwd: "/project-b", timestamp: "2025-01-01T00:00:00Z" }) + "\n");
 let resolved;
 const list = async ({ extraDirs = [] } = {}) => (await scanMachineSessions({ roots: [], extraDirs })).sessions;
 const ensureSession = async (id, options) => { resolved = { id, options, records: await list(options) }; return { ok: false, code: "launch_failed", message: "simulated launch" }; };
 const manager = await createManagerServer({ preferredPort: 0, token, idleTimeoutMs: 5000, onListSessions: list, ensureSession });
 const sockets = [];
 try {
  const url = manager.url.replace(/^http/, "ws");
  for (const [id, dir] of [["a", a], ["b", b]]) {
   const agent = await connect(`${url}/agent?token=${token}`); sockets.push(agent.ws);
   agent.send({ type: "agent.register", instanceId: id, pid: process.pid, session: { id: `live-${id}`, cwd: root, sessionDir: dir }, snapshot: { type: "snapshot" } });
   await agent.next((f) => f.type === "manager.registered");
  }
  const browser = await connect(`${url}/ws?token=${token}`); sockets.push(browser.ws);
  browser.send({ type: "manager.open_session", sessionId: "history-b", requestId: "open-history" });
  const result = await browser.next((f) => f.type === "command.result" && f.requestId === "open-history");
  expect(result.ok).toBe(false); expect(result.code).toBe("launch_failed");
  expect(resolved.id).toBe("history-b");
  expect(resolved.records.find((s) => s.id === "history-b")?.cwd).toBe("/project-b");
  expect(resolved.options.extraDirs.sort()).toEqual([a, b].sort());
 } finally { for (const ws of sockets) ws.close(); await manager.close(); await rm(root, { recursive: true, force: true }); }
});
