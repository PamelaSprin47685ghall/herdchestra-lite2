import { afterEach, describe, expect, test } from "bun:test";
import { createManagerServer } from "../../host-omp-ui/src/manager/server.mjs";

const token = "new-selection-test-token";
let manager;
const sockets = new Set();
const pause = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(path) {
 return new Promise((resolve, reject) => {
  const ws = new WebSocket(`${manager.url.replace(/^http/, "ws")}${path}?token=${token}`);
  const frames = [], waiters = [];
  ws.onerror = () => reject(new Error("websocket failed"));
  ws.onmessage = ({ data }) => {
   const frame = JSON.parse(String(data));
   const index = waiters.findIndex((item) => item.predicate(frame));
   if (index < 0) frames.push(frame);
   else { const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(frame); }
  };
  ws.onopen = () => {
   sockets.add(ws);
   resolve({ ws, frames, send: (frame) => ws.send(JSON.stringify(frame)), next(predicate) {
    const index = frames.findIndex(predicate);
    if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]);
    return new Promise((resolveFrame, rejectFrame) => {
     const waiter = { predicate, resolve: resolveFrame, timer: setTimeout(() => {
      const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1);
      rejectFrame(new Error("expected frame timed out"));
     }, 2000) }; waiters.push(waiter);
    });
   } });
  };
 });
}
const isRequest = (f) => f.type === "manager.snapshot_request";
const isSnapshot = (f) => f.type === "snapshot";
function register(agent, instanceId, session, launchId) {
 agent.send({ type: "agent.register", instanceId, pid: process.pid, session, launchId,
  snapshot: { type: "snapshot", session } });
}
function answer(agent, request, sessionId) {
 agent.send({ type: "agent.client_frame", clientId: request.clientId, generation: request.generation,
  frame: { type: "snapshot", session: { id: sessionId }, marker: sessionId } });
}
afterEach(async () => {
 for (const ws of sockets) ws.close(); sockets.clear();
 if (manager) await manager.close(); manager = undefined;
});

describe("new session selection preserves a usable browser view", () => {
 test("does not send a session selection without a real session id", async () => {
  let complete;
  manager = await createManagerServer({ preferredPort: 0, token, idleTimeoutMs: 5000,
   newSession: () => new Promise((resolve) => { complete = resolve; }) });
  const old = await connect("/agent"); register(old, "old", { id: "old-session", cwd: "/tmp" });
  const browser = await connect("/ws"); const first = await old.next(isRequest);
  answer(old, first, "old-session"); await browser.next(isSnapshot);
  browser.send({ type: "manager.new_session", payload: { cwd: "/tmp", requestId: "new-1" } });
  await pause();
  const fresh = await connect("/agent"); register(fresh, "fresh", { cwd: "/tmp" }, "launch-1");
  await pause(); complete({ ok: true, instanceId: "fresh", launchId: "launch-1" });
  await pause();
  expect(browser.frames.some((f) => f.type === "session.select" && !f.sessionId)).toBe(false);
  fresh.send({ type: "agent.update", session: { id: "fresh-session", cwd: "/tmp" },
   snapshot: { type: "snapshot", session: { id: "fresh-session" } } });
  const request = await fresh.next(isRequest); answer(fresh, request, "fresh-session");
  expect((await browser.next((f) => f.type === "session.select" && f.sessionId === "fresh-session")).instanceId).toBe("fresh");
  expect((await browser.next(isSnapshot)).marker).toBe("fresh-session");
 });

 test("a new instance disconnecting before its snapshot reports failure and restores the previous view", async () => {
  let complete;
  manager = await createManagerServer({ preferredPort: 0, token, idleTimeoutMs: 5000,
   newSession: () => new Promise((resolve) => { complete = resolve; }) });
  const old = await connect("/agent"); register(old, "old", { id: "old-session", cwd: "/tmp" });
  const browser = await connect("/ws"); const first = await old.next(isRequest);
  answer(old, first, "old-session"); await browser.next(isSnapshot);
  browser.send({ type: "manager.new_session", payload: { cwd: "/tmp", requestId: "new-2" } });
  await pause(); const fresh = await connect("/agent");
  register(fresh, "fresh", { id: "fresh-session", cwd: "/tmp" }, "launch-2"); await pause();
  complete({ ok: true, instanceId: "fresh", launchId: "launch-2" });
  await fresh.next(isRequest); fresh.ws.close();
  const failure = await browser.next((f) => f.type === "command.result" && f.requestId === "new-2" && !f.ok);
  expect(failure.code).toBe("instance_gone");
  const rollback = await old.next(isRequest); answer(old, rollback, "old-session");
  expect((await browser.next((f) => f.type === "session.select" && f.sessionId === "old-session")).instanceId).toBe("old");
  expect((await browser.next(isSnapshot)).marker).toBe("old-session");
 });

 test("a new request supersedes a pending old barrier without timing out the new choice", async () => {
  let complete;
  manager = await createManagerServer({ preferredPort: 0, token, idleTimeoutMs: 5000,
   newSession: () => new Promise((resolve) => { complete = resolve; }) });
  const old = await connect("/agent"); register(old, "old", { id: "old-session", cwd: "/tmp" });
  const browser = await connect("/ws"); const stale = await old.next(isRequest);
  browser.send({ type: "manager.new_session", payload: { cwd: "/tmp", requestId: "new-3" } });
  await pause(); const fresh = await connect("/agent");
  register(fresh, "fresh", { id: "fresh-session", cwd: "/tmp" }, "launch-3"); await pause();
  complete({ ok: true, instanceId: "fresh", launchId: "launch-3" });
  const current = await fresh.next(isRequest);
  answer(old, stale, "old-session"); answer(fresh, current, "fresh-session");
  expect((await browser.next(isSnapshot)).marker).toBe("fresh-session");
  const outcome = await browser.next((f) => f.type === "command.result" && f.requestId === "new-3");
  expect(outcome.ok).toBe(true);
  await pause();
  expect(browser.frames.some((f) => f.type === "command.result" && f.requestId === "new-3" && !f.ok)).toBe(false);
 });
});
