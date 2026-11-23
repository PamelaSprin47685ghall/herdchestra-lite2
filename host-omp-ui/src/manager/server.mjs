// Machine-local manager. Session state remains in the owning OMP process.
import { resolve, sep, extname, join } from "node:path";
import { statSync } from "node:fs";
import { homedir } from "node:os";

const mime = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };

export async function createManagerServer({ preferredPort = 37421, token, staticDir, idleTimeoutMs = 3000, keepaliveCwd = join(homedir(), "Desktop"), onListSessions, ensureSession, newSession, diagnostics, onClose } = {}) {
 if (typeof token !== "string" || !token) throw new Error("manager token required");
 const agents = new Map(), browsers = new Map(), knownSessionDirs = new Set();
 const rememberSessionDir = (session) => {
  if (typeof session?.sessionDir === "string" && session.sessionDir) knownSessionDirs.add(session.sessionDir);
 };
 const catalogOptions = () => ({ extraDirs: [...knownSessionDirs] });
 let nextClient = 0, timer, closed = false, hadAgent = false;
 const pending = new Map(), opening = new Map(), launchPending = new Map();
 function waitForAgent(predicate, table, id, timeout = 15000) {
  const found = [...agents.values()].find(predicate);
  if (found) return Promise.resolve(found);
  return new Promise((done) => {
   let waiters = table.get(id); if (!waiters) table.set(id, waiters = new Set());
   const finish = (agent) => { clearTimeout(deadline); waiters.delete(finish); if (!waiters.size) table.delete(id); done(agent); };
   const deadline = setTimeout(() => finish(null), timeout); waiters.add(finish);
  });
 }
 function waitForLaunch(id, timeout = 15000) {
  return waitForAgent((a) => a.launchId === id, launchPending, id, timeout);
 }
 const report = (where, error) => { try { diagnostics?.record?.(where, error); } catch {} };
 const send = (ws, value) => { try { ws.send(JSON.stringify(value)); return true; } catch { return false; } };
 const list = () => [...agents.values()].map(({ instanceId, pid, session, mode, capabilities }) => ({ instanceId, pid, session, mode, capabilities }));
 const publish = () => { const frame = { type: "manager.instances", instances: list() }; for (const client of browsers.values()) send(client.ws, frame); };
 const result = (ws, requestId, ok, code, message) => { if (requestId) send(ws, { type: "command.result", requestId, ok, ...(code ? { code } : {}), ...(message ? { message } : {}) }); };
 const cancelSelection = (client) => {
  if (client.operation) {
   result(client.ws, client.operation.requestId, false, "selection_superseded");
   client.operation = null;
  }
  if (client.awaitingSelection) {
   clearTimeout(client.awaitingSelection.timer);
   result(client.ws, client.awaitingSelection.requestId, false, "selection_superseded");
   client.awaitingSelection = null;
  }
  if (client.barrier) {
   clearTimeout(client.barrier.timer);
   result(client.ws, client.barrier.requestId, false, "selection_superseded");
   client.barrier = null;
  }
 };
 const select = (client, instanceId, requestId) => {
  const agent = agents.get(instanceId);
  if (!agent) { result(client.ws, requestId, false, "instance_gone"); return false; }
  cancelSelection(client);
  if (!agent.session?.id) {
   const waiting = { instanceId, requestId, generation: ++client.generation, timer: null };
   client.awaitingSelection = waiting;
   waiting.timer = setTimeout(() => {
    if (client.awaitingSelection !== waiting) return;
    client.awaitingSelection = null;
    result(client.ws, requestId, false, "snapshot_timeout");
   }, 15000);
   return true;
  }
  const previous = agents.get(client.selected);
  if (previous && previous !== agent) send(previous.ws, { type: "manager.client_disconnected", clientId: client.id });
  const generation = ++client.generation;
  client.historyRequests?.clear();
  client.selected = instanceId;
  const barrier = { generation, requestId, frames: [], bytes: 0, timer: null, previousId: previous?.instanceId };
  const restore = () => {
   const fallback = agents.get(barrier.previousId);
   if (fallback && fallback.instanceId !== instanceId) select(client, fallback.instanceId);
   else { client.selected = null; send(client.ws, { type: "manager.instance_gone", instanceId }); }
  };
  barrier.restore = restore;
  client.barrier = barrier;
  barrier.timer = setTimeout(() => {
   if (client.barrier !== barrier) return;
   client.barrier = null;
   result(client.ws, requestId, false, "snapshot_timeout");
   send(agent.ws, { type: "manager.client_disconnected", clientId: client.id });
   barrier.restore();
  }, 15000);
  send(client.ws, { type: "session.select", sessionId: agent.session?.id, instanceId: agent.instanceId });
  send(agent.ws, { type: "manager.client_connected", clientId: client.id });
  send(agent.ws, { type: "manager.snapshot_request", clientId: client.id, generation });
  return true;
 };
 const close = async () => {
  if (closed) return;
  closed = true;
  clearTimeout(timer);
  for (const waits of pending.values()) for (const waiter of waits) waiter(null);
  pending.clear();
  for (const waits of launchPending.values()) for (const waiter of waits) waiter(null);
  launchPending.clear();
  for (const client of browsers.values()) { if (client.barrier) clearTimeout(client.barrier.timer); if (client.awaitingSelection) clearTimeout(client.awaitingSelection.timer); try { client.ws.close(); } catch {} }
  for (const agent of agents.values()) try { agent.ws.close(); } catch {}
  browsers.clear(); agents.clear();
  try { await onClose?.(); } catch (error) { report("manager-on-close", error); }
  await server.stop(true);
 };
 function waitForSession(id, timeout = 15000) {
  return waitForAgent((a) => a.session?.id === id, pending, id, timeout);
 }
 async function openSession(client, command) {
  const id = command.sessionId ?? command.payload?.sessionId;
  const requestId = command.requestId ?? command.payload?.requestId;
  cancelSelection(client);
  const generation = ++client.generation;
  if (typeof id !== "string" || !id || id.includes("/") || id.includes("\\")) return result(client.ws, requestId, false, "unknown_session");
  const operation = { requestId }; client.operation = operation;
  try {
   let agent = [...agents.values()].find((a) => a.session?.id === id);
   if (!agent) {
    if (typeof ensureSession !== "function") { client.operation = null; return result(client.ws, requestId, false, "unavailable"); }
    let task = opening.get(id);
    if (!task) {
     task = (async () => {
      const outcome = await ensureSession(id, catalogOptions());
      if (!outcome?.ok) return { outcome };
      return { outcome, agent: agents.get(outcome.instanceId) ?? await waitForSession(id) };
     })();
     opening.set(id, task);
     task.finally(() => { if (opening.get(id) === task) opening.delete(id); }).catch(() => {});
    }
    const resolved = await task;
    if (client.operation !== operation) return;
    if (!resolved.outcome?.ok) { client.operation = null; return result(client.ws, requestId, false, resolved.outcome?.code ?? "launch_failed", resolved.outcome?.message); }
    agent = resolved.agent;
   }
   if (client.operation !== operation) return;
   client.operation = null;
   if (!agent) return result(client.ws, requestId, false, "registration_timeout");
   if (browsers.get(client.id) === client && client.generation === generation) select(client, agent.instanceId, requestId);
  } catch (error) {
   if (client.operation !== operation) return;
   client.operation = null;
   throw error;
  }
 }
 const server = Bun.serve({
  hostname: "127.0.0.1", port: preferredPort,
  async fetch(request, host) {
   try {
    const url = new URL(request.url), path = url.pathname;
    if (path === "/api/manager/identity") return Response.json({ name: "herd-omp-ui-manager" });
    if (path === "/api/health") return Response.json({ ok: true, service: "herd-omp-ui-manager", version: 1 });
    if (path === "/favicon.ico") return new Response(null, { status: 204 });
    const auth = url.searchParams.get("token") === token || request.headers.get("authorization") === `Bearer ${token}`;
    if (path === "/ws" || path === "/agent") {
     if (!auth) return new Response("unauthorized", { status: 401 });
     const origin = request.headers.get("origin");
     if (origin && origin !== url.origin.replace(/^ws/, "http")) return new Response("forbidden origin", { status: 403 });
     if (host.upgrade(request, { data: { kind: path === "/agent" ? "agent" : "browser", id: `c${++nextClient}` } })) return;
     return new Response("upgrade failed", { status: 400 });
    }
    if (path.startsWith("/api/")) {
     if (!auth) return new Response("unauthorized", { status: 401 });
     if (path === "/api/sessions") return Response.json(await onListSessions?.(catalogOptions()) ?? []);
     if (path === "/api/instances") return Response.json(list());
     if (path === "/api/bootstrap") return Response.json({ instances: list() });
     return new Response("not found", { status: 404 });
    }
    if (!staticDir) return new Response("not found", { status: 404 });
    const decoded = decodeURIComponent(path);
    if (decoded.includes("\0") || decoded.split("/").includes("..")) return new Response("forbidden", { status: 403 });
    let rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    if (rel !== "index.html" && !rel.startsWith("dist/") && !rel.startsWith("assets/")) return new Response("forbidden", { status: 403 });
    const root = resolve(staticDir);
    let file = resolve(root, rel);
    if (!file.startsWith(root + sep)) return new Response("forbidden", { status: 403 });
    try { if (!statSync(file).isFile()) throw new Error(); } catch {
     if (!rel.startsWith("dist/")) return new Response("not found", { status: 404 });
     file = resolve(root, rel.slice(5));
     try { if (!file.startsWith(root + sep) || !statSync(file).isFile()) throw new Error(); } catch { return new Response("not found", { status: 404 }); }
    }
    const ext = extname(file).toLowerCase();
    const headers = { "content-type": mime[ext] ?? "application/octet-stream" };
    if (ext === ".html") headers["cache-control"] = "no-store";
    else headers["cache-control"] = "no-cache, must-revalidate";
    return new Response(Bun.file(file), { headers });
   } catch (error) { report("manager-fetch", error); return new Response("server error", { status: 500 }); }
  },
  websocket: {
   open(ws) { try { if (ws.data.kind === "browser") { const client = { id: ws.data.id, ws, selected: null, generation: 0 }; browsers.set(client.id, client); send(ws, { type: "manager.instances", instances: list() }); const first = agents.values().next().value; if (first) select(client, first.instanceId); } } catch (e) { report("manager-open", e); } },
   message(ws, raw) {
    try {
     const frame = JSON.parse(String(raw));
     if (!frame || typeof frame !== "object") return;
     if (ws.data.kind === "agent") {
      if (frame.type === "agent.register") {
       if (ws.data.instanceId || typeof frame.instanceId !== "string" || !frame.instanceId || agents.has(frame.instanceId)) { ws.close(); return; }
       clearTimeout(timer); hadAgent = true; ws.data.instanceId = frame.instanceId;
       const agent = { ws, instanceId: frame.instanceId, pid: frame.pid, session: frame.session, snapshot: frame.snapshot, launchId: frame.launchId, mode: frame.mode, capabilities: frame.capabilities };
       agents.set(agent.instanceId, agent); rememberSessionDir(agent.session); send(ws, { type: "manager.registered", instanceId: agent.instanceId }); publish();
       for (const finish of pending.get(agent.session?.id) ?? []) finish(agent);
       if (agent.launchId) for (const finish of launchPending.get(agent.launchId) ?? []) finish(agent);
       for (const client of browsers.values()) if (!client.selected) select(client, agent.instanceId);
      } else {
       const agent = agents.get(ws.data.instanceId);
       if (!agent || agent.ws !== ws) return;
       if (frame.type === "agent.frame" && frame.frame && typeof frame.frame === "object") {
        if (frame.frame.type === "snapshot") { agent.snapshot = frame.frame; if (frame.frame.session) agent.session = frame.frame.session; publish(); }
        for (const client of browsers.values()) if (client.selected === agent.instanceId) {
         if (!client.barrier) send(client.ws, frame.frame);
         else {
          const bytes = JSON.stringify(frame.frame).length;
          if (client.barrier.frames.length < 4096 && client.barrier.bytes + bytes <= 16 * 1024 * 1024) {
           client.barrier.frames.push({ revision: frame.revision, frame: frame.frame });
           client.barrier.bytes += bytes;
          } else {
           const barrier = client.barrier;
           clearTimeout(barrier.timer);
           result(client.ws, barrier.requestId, false, "snapshot_overflow");
           client.barrier = null;
           send(agent.ws, { type: "manager.client_disconnected", clientId: client.id });
           barrier.restore();
          }
         }
        }
       } else if (frame.type === "agent.client_frame") {
        const client = browsers.get(frame.clientId);
        if (client?.selected !== agent.instanceId) return;
        if (frame.frame?.type === "snapshot") {
         const barrier = client.barrier;
         if (!barrier || frame.generation !== barrier.generation) return;
         clearTimeout(barrier.timer); client.barrier = null;
         send(client.ws, frame.frame);
         const snapshotSeq = typeof frame.frame?.seq === "number"
          ? frame.frame.seq
          : typeof frame.frame?.payload?.seq === "number"
            ? frame.frame.payload.seq
            : null;
         for (const pendingFrame of barrier.frames) {
          const pendingSeq = typeof pendingFrame.frame?.seq === "number" ? pendingFrame.frame.seq : null;
          if (snapshotSeq !== null && pendingSeq !== null) {
           if (pendingSeq > snapshotSeq) send(client.ws, pendingFrame.frame);
          } else if (typeof frame.revision !== "number" || typeof pendingFrame.revision !== "number" || pendingFrame.revision > frame.revision) {
           send(client.ws, pendingFrame.frame);
          }
         }
         result(client.ws, barrier.requestId, true);
        } else if (!client.barrier) {
         if (frame.frame?.type === "history.page") {
          const request = client.historyRequests?.get(frame.frame.requestId);
          client.historyRequests?.delete(frame.frame.requestId);
          if (!request || request.generation !== client.generation || request.sessionId !== agent.session?.id) return;
         }
         if (frame.frame?.type === "command.result" && frame.frame.ok === false) client.historyRequests?.delete(frame.frame.requestId);
         send(client.ws, frame.frame);
        }
       } else if (frame.type === "agent.update") {
        agent.session = frame.session ?? agent.session; rememberSessionDir(agent.session); if (frame.snapshot) agent.snapshot = frame.snapshot; publish();
        for (const client of browsers.values()) {
         const waiting = client.awaitingSelection;
         if (waiting?.instanceId === agent.instanceId && waiting.generation === client.generation && agent.session?.id) { clearTimeout(waiting.timer); client.awaitingSelection = null; select(client, agent.instanceId, waiting.requestId); }
        }
       }
      }
      return;
     }
     const client = browsers.get(ws.data.id); if (!client) return;
     const command = frame.payload && typeof frame.payload === "object" ? { ...frame.payload, ...frame, payload: frame.payload } : frame;
     if (command.type === "manager.select") { select(client, command.instanceId, command.requestId); return; }
     if (command.type === "manager.open_session") { Promise.resolve(openSession(client, command)).catch((e) => { report("manager-open-session", e); result(ws, command.requestId, false, "failed", String(e)); }); return; }
     if (command.type === "manager.new_session") {
      if (typeof newSession !== "function") { result(ws, command.requestId, false, "unavailable"); return; }
      if (typeof command.cwd !== "string" || ![...agents.values()].some((agent) => agent.session?.cwd === command.cwd)) { result(ws, command.requestId, false, "invalid_cwd"); return; }
      cancelSelection(client);
      const generation = ++client.generation;
      const operation = { requestId: command.requestId }; client.operation = operation;
      Promise.resolve().then(() => newSession({ cwd: command.cwd }, waitForLaunch)).then((outcome) => {
       if (client.operation !== operation || browsers.get(client.id) !== client) return;
       client.operation = null;
       if (!outcome?.ok) { result(ws, command.requestId, false, outcome?.code || "launch_failed", outcome?.message); return; }
       const agent = agents.get(outcome.instanceId);
       if (!agent || !outcome.launchId || agent.launchId !== outcome.launchId) { result(ws, command.requestId, false, "registration_failed"); return; }
       if (client.generation === generation) select(client, agent.instanceId, command.requestId);
       else result(ws, command.requestId, false, "selection_superseded");
      }).catch((e) => {
       if (client.operation !== operation || browsers.get(client.id) !== client) return;
       client.operation = null;
       report("manager-new-session", e); result(ws, command.requestId, false, "failed");
      });
      return;
     }
     const agent = agents.get(client.selected);
     if (command.type === "manager.close_instance") {
      const target = agents.get(command.instanceId);
      if (!target) { result(ws, command.requestId, false, "instance_gone"); return; }
      const moveClients = (survivorId) => {
       for (const c of browsers.values()) if (c.selected === command.instanceId && survivorId) select(c, survivorId);
      };
      const shutdownTarget = () => { try { send(target.ws, { type: "manager.shutdown", requestId: command.requestId }); } catch (e) { report("manager-shutdown-send", e); } };
      if (agents.size > 1) {
       const survivor = [...agents.values()].find((candidate) => candidate.instanceId !== command.instanceId);
       moveClients(survivor?.instanceId);
       shutdownTarget(); publish();
       result(ws, command.requestId, true);
       return;
      }
      if (typeof newSession !== "function") { result(ws, command.requestId, false, "unavailable"); return; }
      Promise.resolve().then(() => newSession({ cwd: keepaliveCwd }, waitForLaunch)).then(async (outcome) => {
       if (!outcome?.ok) { result(ws, command.requestId, false, outcome?.code || "launch_failed", outcome?.message); return; }
       const deadline = Date.now() + 5000;
       const keepalive = await new Promise((resolve) => {
        const tick = () => {
         const candidate = outcome.instanceId ? agents.get(outcome.instanceId) : [...agents.values()].find((entry) => entry.instanceId !== command.instanceId);
         if (candidate) return resolve(candidate);
         if (Date.now() >= deadline) return resolve(null);
         setTimeout(tick, 10);
        };
        tick();
       });
       if (!keepalive || keepalive.instanceId === command.instanceId) { result(ws, command.requestId, false, "registration_failed"); return; }
       moveClients(keepalive.instanceId);
       if (client.selected !== keepalive.instanceId) select(client, keepalive.instanceId);
       shutdownTarget(); publish();
       result(ws, command.requestId, true);
      }).catch((e) => { report("manager-close-instance", e); result(ws, command.requestId, false, "failed"); });
      return;
     }
     if (!agent) { result(ws, command.requestId, false, "instance_gone"); return; }
     if (command.type === "manager.history" && typeof command.requestId === "string" && command.requestId) {
      client.historyRequests ??= new Map();
      client.historyRequests.clear();
      client.historyRequests.set(command.requestId, { generation: client.generation, sessionId: agent.session?.id });
     }
     send(agent.ws, { type: "manager.command", clientId: client.id, command });
    } catch (e) { report("manager-message", e); send(ws, { type: "client.error", code: "invalid_message" }); }
   },
   close(ws) {
    try {
     if (ws.data.kind === "browser") { const client = browsers.get(ws.data.id); if (client) { if (client.barrier) clearTimeout(client.barrier.timer); if (client.awaitingSelection) clearTimeout(client.awaitingSelection.timer); client.operation = null; browsers.delete(client.id); const agent = agents.get(client.selected); if (agent) send(agent.ws, { type: "manager.client_disconnected", clientId: client.id }); } return; }
     const agent = agents.get(ws.data.instanceId); if (!agent || agent.ws !== ws) return;
     agents.delete(agent.instanceId);
     for (const client of browsers.values()) {
      if (client.awaitingSelection?.instanceId === agent.instanceId) { clearTimeout(client.awaitingSelection.timer); result(client.ws, client.awaitingSelection.requestId, false, "instance_gone"); client.awaitingSelection = null; }
      if (client.selected !== agent.instanceId) continue;
      const barrier = client.barrier;
      if (barrier) { clearTimeout(barrier.timer); result(client.ws, barrier.requestId, false, "instance_gone"); client.barrier = null; barrier.restore(); }
      else { client.selected = null; send(client.ws, { type: "manager.instance_gone", instanceId: agent.instanceId }); }
     }
     publish();
     if (hadAgent && !agents.size) timer = setTimeout(() => { close().catch((e) => report("manager-close", e)); }, idleTimeoutMs);
    } catch (e) { report("manager-disconnect", e); }
   },
  },
 });
 return { port: server.port, url: `http://127.0.0.1:${server.port}`, token, close };
}
