import { afterEach, describe, expect, test } from "bun:test";
import { createManagerServer } from "../../host-omp-ui/src/manager/server.mjs";

// A snapshot request carries an opaque generation. An agent returns it unchanged
// on agent.client_frame. Only that generation can complete a browser selection.
const token = "snapshot-contract-secret";
const sockets = new Set();
let manager;
const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(path) {
 return new Promise((resolve, reject) => {
  const ws = new WebSocket(`${manager.url.replace(/^http/, "ws")}${path}?token=${token}`);
  const frames = [];
  const waiters = [];
  ws.onerror = () => reject(new Error("websocket connection failed"));
  ws.onmessage = (event) => {
   const frame = JSON.parse(String(event.data));
   const index = waiters.findIndex((item) => item.predicate(frame));
   if (index < 0) frames.push(frame);
   else { const [item] = waiters.splice(index, 1); clearTimeout(item.timer); item.resolve(frame); }
  };
  ws.onopen = () => {
   sockets.add(ws);
   resolve({ ws, frames, send: (frame) => ws.send(JSON.stringify(frame)), next(predicate) {
    const index = frames.findIndex(predicate);
    if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]);
    return new Promise((resolveFrame, rejectFrame) => {
     const waiter = { predicate, resolve: resolveFrame, timer: setTimeout(() => {
      const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1);
      rejectFrame(new Error("expected frame timed out"));
     }, 2000) };
     waiters.push(waiter);
    });
   } });
  };
 });
}
async function start() {
 manager = await createManagerServer({ preferredPort: 0, token, idleTimeoutMs: 5000 });
}
async function agent(id) {
 const a = await connect("/agent");
 a.send({ type: "agent.register", instanceId: id, pid: process.pid,
  session: { id: `session-${id}`, cwd: "/tmp" },
  snapshot: { type: "snapshot", session: { id: `session-${id}` }, marker: `cached-${id}` } });
 return a;
}
function answer(a, request, marker) {
 a.send({ type: "agent.client_frame", clientId: request.clientId, generation: request.generation,
  frame: { type: "snapshot", session: { id: `session-${marker[0]}` }, marker } });
}
const isRequest = (f) => f.type === "manager.snapshot_request";
const isSnapshot = (f) => f.type === "snapshot";
afterEach(async () => {
 for (const ws of sockets) ws.close();
 sockets.clear();
 if (manager) await manager.close();
 manager = undefined;
});

describe("manager session selection snapshot barrier", () => {
 test("delivers the requested snapshot before deltas arriving while it is pending", async () => {
  await start(); const a = await agent("a"); const browser = await connect("/ws");
  const request = await a.next(isRequest);
  expect(request.generation).toBeDefined();
  a.send({ type: "agent.frame", frame: { type: "transcript.delta", text: "after-request" } });
  await pause();
  expect(browser.frames.some((f) => isSnapshot(f) || f.text === "after-request")).toBe(false);
  answer(a, request, "a-authoritative");
  const snapshot = await browser.next(isSnapshot);
  const delta = await browser.next((f) => f.type === "transcript.delta");
  expect(snapshot.marker).toBe("a-authoritative");
  expect(delta.text).toBe("after-request");
 });

 test("a stale A response cannot overwrite a newer A selection after A → B → A", async () => {
  await start(); const a = await agent("a"); const b = await agent("b");
  const browser = await connect("/ws");
  const first = await a.next(isRequest);
  browser.send({ type: "manager.select", instanceId: "b", requestId: "b" });
  const middle = await b.next(isRequest);
  browser.send({ type: "manager.select", instanceId: "a", requestId: "a-again" });
  const latest = await a.next(isRequest);
  expect(latest.generation).not.toBe(first.generation);
  answer(a, first, "a-stale"); answer(b, middle, "b-stale");
  a.send({ type: "agent.frame", frame: { type: "transcript.delta", text: "a-current" } });
  await pause();
  expect(browser.frames.some((f) => isSnapshot(f) || f.text === "a-current")).toBe(false);
  answer(a, latest, "a-current-snapshot");
  expect((await browser.next(isSnapshot)).marker).toBe("a-current-snapshot");
  expect((await browser.next((f) => f.type === "transcript.delta")).text).toBe("a-current");
  await pause();
  expect(browser.frames.some((f) => f.marker === "a-stale" || f.marker === "b-stale")).toBe(false);
 });

 test("never forwards old-instance deltas during selection of a new instance", async () => {
  await start(); const a = await agent("a"); const b = await agent("b");
  const browser = await connect("/ws");
  const first = await a.next(isRequest); answer(a, first, "a-initial");
  await browser.next(isSnapshot);
  browser.send({ type: "manager.select", instanceId: "b", requestId: "select-b" });
  const request = await b.next(isRequest);
  a.send({ type: "agent.frame", frame: { type: "transcript.delta", text: "wrong-instance" } });
  b.send({ type: "agent.frame", frame: { type: "transcript.delta", text: "right-instance" } });
  await pause();
  expect(browser.frames.some((f) => f.text === "wrong-instance" || f.text === "right-instance")).toBe(false);
  answer(b, request, "b-current");
  expect((await browser.next(isSnapshot)).marker).toBe("b-current");
  expect((await browser.next((f) => f.type === "transcript.delta")).text).toBe("right-instance");
  await pause(); expect(browser.frames.some((f) => f.text === "wrong-instance")).toBe(false);
 });

 test("disconnect during a pending selection reports failure to that browser", async () => {
  await start(); const a = await agent("a"); const b = await agent("b");
  const browser = await connect("/ws");
  const first = await a.next(isRequest); answer(a, first, "a-initial"); await browser.next(isSnapshot);
  browser.send({ type: "manager.select", instanceId: "b", requestId: "waiting-b" });
  await b.next(isRequest); b.ws.close();
  const failure = await browser.next((f) => f.type === "command.result" && f.requestId === "waiting-b" && f.ok === false);
  expect(failure.code).toBe("instance_gone");
 });
});
