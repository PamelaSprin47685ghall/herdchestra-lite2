// A per-OMP agent. The fixed-port listener is elected by binding it; every
// agent reconnects after the listener's host exits, preserving a stable URL.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createManagerServer } from "../manager/server.mjs";
import { createManagerTray } from "./manager-tray.mjs";
import { systemTray } from "./system-tray.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const portBusyMessage = (port) => `固定端口 ${port} 已被其他服务占用；如有旧版 DeerFlow 正在运行，请退出占用端口的旧实例后重启。`;

export async function sharedManagerToken() {
	const dir = join(process.env.XDG_RUNTIME_DIR || join(homedir(), ".omp", "run"), "herd-omp-ui");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const dirStat = await lstat(dir);
	if (!dirStat.isDirectory() || (process.getuid && dirStat.uid !== process.getuid()) || (dirStat.mode & 0o077)) throw new Error("unsafe manager token directory");
	const path = join(dir, "token");
	try {
		const file = await open(path, "wx", 0o600);
		try {
			const token = randomBytes(24).toString("hex");
			await file.writeFile(token, "utf8");
			return token;
		} finally { await file.close(); }
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
	}
	for (let i = 0; i < 20; i++) {
		const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		let token;
		try {
			const stat = await file.stat();
			if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw new Error("unsafe manager token file");
			token = (await file.readFile("utf8")).trim();
		} finally { await file.close(); }
		if (token) return token;
		await sleep(25);
	}
	throw new Error("manager token file is empty");
}

export async function createManagerClient(options = {}) {
	const { preferredPort = 37421, token, staticDir, diagnostics } = options;
	const instanceId = randomUUID();
	const url = `http://127.0.0.1:${preferredPort}`;
	let leader = null;
	let socket = null;
	let closed = false;
	let reconnectTimer = null;
	let revision = 0;
	const clients = new Set();
	const send = (frame) => {
		if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
	};
	const report = (label, error) => diagnostics?.record?.(label, error);
	const status = (state, reason) => options.onStatus?.(state, reason);
	const disconnectAll = () => {
		for (const clientId of clients) options.onClientDisconnect?.(clientId);
		clients.clear();
	};
	const facade = {
		port: preferredPort, url, token,
		get clientCount() { return clients.size; },
		broadcast(frame) { send({ type: "agent.frame", revision: ++revision, frame }); },
		update(session, snapshot) { send({ type: "agent.update", session, snapshot: { ...snapshot, type: "snapshot" } }); },
		sendToClient(clientId, frame) { send({ type: "agent.client_frame", clientId, frame }); },
		async close() {
			closed = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			disconnectAll();
			socket?.close();
			if (leader) await leader.close();
		},
	};
	async function connect() {
		if (closed) return;
		try {
			// Identity is checked before transmitting the shared token. A stale
			// unrelated listener is an error, not a reason to pick another port.
			let identity;
			try {
				const response = await fetch(`${url}/api/manager/identity`, { signal: AbortSignal.timeout(750) });
				identity = response.ok ? await response.json() : null;
			} catch { /* port may be free */ }
			if (!identity) {
				try {
					const tray = createManagerTray({ url, token, adapter: systemTray, diagnostics });
					let owner;
					owner = await createManagerServer({ preferredPort, token, staticDir, onListSessions: options.onListSessions, ensureSession: options.ensureSession, newSession: options.newSession, diagnostics, onClose: async () => { await tray.stop(); if (leader === owner) leader = null; } });
					leader = owner;
					void tray.start();
				} catch (error) {
					// Another instance may have bound while we were probing.
					await sleep(100);
					let listenerResponded = false;
					try {
						const response = await fetch(`${url}/api/manager/identity`, { signal: AbortSignal.timeout(750) });
						listenerResponded = true;
						identity = response.ok ? await response.json() : null;
					} catch { /* Preserve the original bind error. */ }
					if (!identity) {
						if (listenerResponded || error?.code === "EADDRINUSE" || String(error).includes("EADDRINUSE")) {
							throw new Error(portBusyMessage(preferredPort));
						}
						throw error;
					}
				}
			}
			if (identity && identity.name !== "herd-omp-ui-manager") throw new Error(portBusyMessage(preferredPort));
			if (closed) { await leader?.close(); return; }
			const ws = new WebSocket(`${url.replace(/^http/, "ws")}/agent?token=${encodeURIComponent(token)}`);
			socket = ws;
			ws.onopen = async () => {
				try {
					const snapshot = await options.onBootstrap?.() ?? {};
					send({ type: "agent.register", instanceId, pid: process.pid, launchId: process.env.OMP_UI_LAUNCH_ID ?? process.env.HERD_OMP_UI_LAUNCH_ID, mode: options.mode, capabilities: options.instanceCapabilities, session: snapshot.session ?? {}, snapshot: { ...snapshot, type: "snapshot" } });
				} catch (error) { report("manager-register", error); status("error", String(error)); ws.close(); }
			};
			ws.onmessage = (event) => {
				try {
					const frame = JSON.parse(String(event.data));
					if (frame.type === "manager.registered" && frame.instanceId === instanceId) {
						status("connected");
					} else if (frame.type === "manager.command") {
						const command = frame.command;
						const clientId = frame.clientId;
						const normalized = command?.payload && typeof command.payload === "object" ? { ...command.payload, ...command, payload: command.payload } : command;
						const requestId = normalized?.requestId ?? normalized?.payload?.requestId;
						Promise.resolve().then(() => options.onClientCommand?.(normalized, clientId)).catch((error) => {
							report("manager-command", error);
							if (clientId && requestId) send({ type: "agent.client_frame", clientId, frame: { type: "command.result", requestId, ok: false, code: "failed" } });
						});
					} else if (frame.type === "manager.client_connected") {
						clients.add(frame.clientId); options.onClientConnect?.(frame.clientId);
					} else if (frame.type === "manager.client_disconnected") {
						clients.delete(frame.clientId); options.onClientDisconnect?.(frame.clientId);
					} else if (frame.type === "manager.snapshot_request") {
						const snapshotRevision = revision;
						Promise.resolve(options.onBootstrap?.()).then((snapshot) => send({ type: "agent.client_frame", clientId: frame.clientId, generation: frame.generation, revision: snapshotRevision, frame: { ...snapshot, type: "snapshot" } })).catch((error) => report("manager-snapshot", error));
					} else if (frame.type === "manager.shutdown") {
						Promise.resolve().then(() => options.onShutdown?.(frame)).catch((error) => report("manager-shutdown", error));
					}
				} catch (error) { report("manager-message", error); }
			};
			ws.onerror = (error) => { report("manager-socket", error); status("error", "无法连接管理器或认证失败"); };
			ws.onclose = () => {
				disconnectAll();
				if (!closed) { status("disconnected", "管理器连接已断开，正在重试"); reconnectTimer = setTimeout(() => void connect(), 500); }
			};
		} catch (error) {
			report("manager-connect", error);
			status("error", String(error));
			if (!closed) reconnectTimer = setTimeout(() => void connect(), 1000);
		}
	}
	await connect();
	return facade;
}
