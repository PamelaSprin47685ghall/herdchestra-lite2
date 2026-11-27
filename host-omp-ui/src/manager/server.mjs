// Machine-local manager. Session state remains in the owning OMP process.
//
// This module is transport only: HTTP, static files, websocket wiring, and the
// command envelopes. Every mutable decision belongs to ManagerStation; every
// flow that waits belongs to manager/tickets/.
import { resolve, sep, extname, join } from "node:path";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { createManagerStation } from "./station.mjs";
import { openSessionTicket } from "./tickets/open-session.mjs";
import { newSessionTicket } from "./tickets/new-session.mjs";
import { closeInstanceTicket } from "./tickets/close-instance.mjs";

const mime = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };

export async function createManagerServer({ preferredPort = 37421, token, staticDir, idleTimeoutMs = 3000, keepaliveCwd = join(homedir(), "Desktop"), onListSessions, ensureSession, newSession, diagnostics, onClose } = {}) {
  if (typeof token !== "string" || !token) throw new Error("manager token required");

  const report = (where, error) => { try { diagnostics?.record?.(where, error); } catch {} };
  const send = (ws, value) => { try { ws.send(JSON.stringify(value)); return true; } catch { return false; } };
  const station = createManagerStation({ send, schedule: setTimeout, clearTimer: clearTimeout });

  let nextClient = 0;
  let idleTimer = null;
  let closed = false;

  const disarmIdle = () => {
    if (idleTimer === null) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };

  const armIdle = () => {
    disarmIdle();
    idleTimer = setTimeout(() => { close().catch((error) => report("manager-close", error)); }, idleTimeoutMs);
  };

  // A function declaration, not an arrow: armIdle closes over it, and hoisting
  // removes any temporal dependency between the two.
  async function close() {
    if (closed) return;
    closed = true;
    disarmIdle();
    station.closeAll();
    try { await onClose?.(); } catch (error) { report("manager-on-close", error); }
    await server.stop(true);
  }

  function handleAgentFrame(ws, frame) {
    if (frame.type === "agent.register") {
      if (station.registerAgent(ws, frame)) disarmIdle();
      return;
    }
    const agent = station.agentById(ws.data.instanceId);
    if (!agent || agent.ws !== ws) return;
    if (frame.type === "agent.frame" && frame.frame && typeof frame.frame === "object") station.agentFrame(agent, frame);
    else if (frame.type === "agent.client_frame") station.clientFrame(agent, frame);
    else if (frame.type === "agent.update") station.agentUpdate(agent, frame);
  }

  function handleBrowserFrame(ws, frame) {
    const client = station.clientById(ws.data.id);
    if (!client) return;
    const command = frame.payload && typeof frame.payload === "object" ? { ...frame.payload, ...frame, payload: frame.payload } : frame;
    const requestId = command.requestId;

    if (command.type === "manager.select") {
      station.select(client, command.instanceId, requestId);
      return;
    }
    if (command.type === "manager.open_session") {
      openSessionTicket({ station, client, command, ensureSession }).catch((error) => {
        report("manager-open-session", error);
        station.result(client, requestId, false, "failed", String(error));
      });
      return;
    }
    if (command.type === "manager.new_session") {
      newSessionTicket({ station, client, command, newSession }).catch((error) => {
        report("manager-new-session", error);
        station.result(client, requestId, false, "failed");
      });
      return;
    }
    if (command.type === "manager.close_instance") {
      closeInstanceTicket({ station, client, command, newSession, keepaliveCwd }).catch((error) => {
        report("manager-close-instance", error);
        station.result(client, requestId, false, "failed");
      });
      return;
    }

    const agent = station.agentById(client.selected);
    if (!agent) {
      station.result(client, requestId, false, "instance_gone");
      return;
    }
    if (command.type === "manager.history" && typeof requestId === "string" && requestId) station.noteHistoryRequest(client, requestId, agent);
    station.sendCommand(agent, client, command);
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: preferredPort,
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
          if (path === "/api/sessions") return Response.json((await onListSessions?.(station.catalogOptions())) ?? []);
          if (path === "/api/instances") return Response.json(station.list());
          if (path === "/api/bootstrap") return Response.json({ instances: station.list() });
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
        try {
          if (!statSync(file).isFile()) throw new Error();
        } catch {
          if (!rel.startsWith("dist/")) return new Response("not found", { status: 404 });
          file = resolve(root, rel.slice(5));
          try {
            if (!file.startsWith(root + sep) || !statSync(file).isFile()) throw new Error();
          } catch {
            return new Response("not found", { status: 404 });
          }
        }
        const ext = extname(file).toLowerCase();
        const headers = { "content-type": mime[ext] ?? "application/octet-stream" };
        if (ext === ".html") headers["cache-control"] = "no-store";
        else headers["cache-control"] = "no-cache, must-revalidate";
        return new Response(Bun.file(file), { headers });
      } catch (error) {
        report("manager-fetch", error);
        return new Response("server error", { status: 500 });
      }
    },
    websocket: {
      open(ws) {
        try {
          if (ws.data.kind === "browser") station.openBrowser(ws);
        } catch (error) {
          report("manager-open", error);
        }
      },
      message(ws, raw) {
        try {
          const frame = JSON.parse(String(raw));
          if (!frame || typeof frame !== "object") return;
          if (ws.data.kind === "agent") handleAgentFrame(ws, frame);
          else handleBrowserFrame(ws, frame);
        } catch (error) {
          report("manager-message", error);
          send(ws, { type: "client.error", code: "invalid_message" });
        }
      },
      close(ws) {
        try {
          if (ws.data.kind === "browser") {
            const client = station.clientById(ws.data.id);
            if (client) station.disconnectBrowser(client);
            return;
          }
          if (station.disconnectAgent(ws).idle) armIdle();
        } catch (error) {
          report("manager-disconnect", error);
        }
      },
    },
  });

  return { port: server.port, url: `http://127.0.0.1:${server.port}`, token, close };
}
