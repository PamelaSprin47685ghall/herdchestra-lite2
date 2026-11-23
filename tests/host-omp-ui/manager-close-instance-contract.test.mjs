// Red contract for closing an OMP instance from the Web manager.
// Written, not run.
//
// The sidebar can close a live instance. Closing the last live instance must
// not take the manager down with it: like closing the last Firefox tab, it
// starts one empty keepalive OMP in the Desktop directory, waits for that
// instance to register, then shuts the old one down and moves the browser to
// the keepalive instance.
//
// Minimal interface under test:
//   createManagerServer({ ..., keepaliveCwd?, newSession? })
//     keepaliveCwd defaults to join(homedir(), "Desktop").
//
//   browser -> manager:
//     { type: "manager.close_instance", payload: { instanceId, requestId } }
//       -> { type: "command.result", requestId, ok: true }
//       -> { type: "command.result", requestId, ok: false, code }
//
//   manager -> agent:
//     { type: "manager.shutdown", requestId }
//
// Required ordering:
//   - With another live instance, no keepalive launch happens.
//   - Closing the last instance launches the keepalive session and waits for
//     its registration before sending manager.shutdown to the old instance.
//   - If the keepalive launch/registration fails, the old instance is NOT
//     shut down and the request fails.
//   - An unknown instanceId fails with code "instance_gone" and touches
//     nothing.
import { describe, test, expect, afterEach } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

const MODULE = "../../host-omp-ui/src/manager/server.mjs";
const token = "manager-close-instance-secret";
let manager;
const sockets = new Set();

function connect(url) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		const frames = [];
		const waiters = [];
		const timer = setTimeout(() => reject(new Error("websocket open timed out")), 2000);
		ws.onmessage = (event) => {
			const frame = JSON.parse(String(event.data));
			const index = waiters.findIndex((w) => w.predicate(frame));
			if (index < 0) frames.push(frame);
			else {
				const [waiter] = waiters.splice(index, 1);
				clearTimeout(waiter.timer);
				waiter.resolve(frame);
			}
		};
		ws.onerror = () => { clearTimeout(timer); reject(new Error("websocket rejected")); };
		ws.onopen = () => {
			clearTimeout(timer);
			sockets.add(ws);
			resolve({
				ws,
				send: (frame) => ws.send(JSON.stringify(frame)),
				next(predicate = () => true) {
					const index = frames.findIndex(predicate);
					if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]);
					return new Promise((done, fail) => {
						const waiter = { predicate, resolve: done, timer: setTimeout(() => {
							const position = waiters.indexOf(waiter);
							if (position >= 0) waiters.splice(position, 1);
							fail(new Error("expected frame timed out"));
						}, 2000) };
						waiters.push(waiter);
					});
				},
				frames,
			});
		};
	});
}

async function start(options = {}) {
	const { createManagerServer } = await import(MODULE);
	manager = await createManagerServer({ preferredPort: 0, token, idleTimeoutMs: 50, ...options });
	return manager;
}
function wsUrl(path, secret = token) {
	return `${manager.url.replace(/^http/, "ws")}${path}?token=${encodeURIComponent(secret)}`;
}

async function agent(id, { sessionId = `session-${id}`, cwd = "/tmp" } = {}) {
	const a = await connect(wsUrl("/agent"));
	a.received = [];
	const prior = a.ws.onmessage;
	a.ws.onmessage = (event) => {
		prior(event);
		const frame = JSON.parse(String(event.data));
		a.received.push(frame);
		if (frame.type === "manager.snapshot_request") {
			a.send({
				type: "agent.client_frame",
				clientId: frame.clientId,
				generation: frame.generation,
				frame: { type: "snapshot", session: { id: sessionId } },
			});
		}
	};
	a.send({
		type: "agent.register",
		instanceId: id,
		pid: process.pid,
		session: { id: sessionId, cwd },
		snapshot: { type: "snapshot", session: { id: sessionId } },
	});
	return a;
}

const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
const shutdowns = (a) => a.received.filter((frame) => frame.type === "manager.shutdown");

afterEach(async () => {
	for (const ws of sockets) ws.close();
	sockets.clear();
	if (manager) await manager.close();
	manager = undefined;
});

describe("closing a live instance from the Web", () => {
	test("with another instance alive, the target is shut down and the browser moves to the survivor", async () => {
		let keepaliveLaunches = 0;
		await start({
			idleTimeoutMs: 5000,
			newSession: async () => { keepaliveLaunches += 1; return { ok: false, code: "unexpected" }; },
		});
		const a = await agent("a");
		const b = await agent("b");
		const browser = await connect(wsUrl("/ws"));
		await browser.next((f) => f.type === "manager.instances" && f.instances.length === 2);
		browser.send({ type: "manager.select", instanceId: "a", requestId: "select-a" });
		await browser.next((f) => f.type === "snapshot" && f.session?.id === "session-a");

		browser.send({ type: "manager.close_instance", instanceId: "a", requestId: "close-a" });

		const shutdown = await a.next((f) => f.type === "manager.shutdown");
		expect(shutdown.requestId).toBe("close-a");
		expect((await browser.next((f) => f.type === "snapshot" && f.session?.id === "session-b")).session.id).toBe("session-b");
		const receipt = await browser.next((f) => f.type === "command.result" && f.requestId === "close-a");
		expect(receipt.ok).toBe(true);
		expect(keepaliveLaunches).toBe(0);
		expect(shutdowns(b)).toEqual([]);
	});

	test("closing the last instance starts a Desktop keepalive, waits for registration, then shuts the old one down", async () => {
		const keepaliveCwd = "/home/u/Desktop";
		const order = [];
		await start({
			idleTimeoutMs: 5000,
			keepaliveCwd,
			newSession: async (options) => {
				expect(options.cwd).toBe(keepaliveCwd);
				order.push("launch");
				await agent("keepalive", { sessionId: "session-keepalive", cwd: keepaliveCwd });
				order.push("register");
				return { ok: true, instanceId: "keepalive" };
			},
		});
		const a = await agent("a");
		const browser = await connect(wsUrl("/ws"));
		await browser.next((f) => f.type === "manager.instances" && f.instances.length === 1);
		browser.send({ type: "manager.select", instanceId: "a", requestId: "select-a" });
		await browser.next((f) => f.type === "snapshot" && f.session?.id === "session-a");

		browser.send({ type: "manager.close_instance", instanceId: "a", requestId: "close-last" });

		const shutdown = await a.next((f) => f.type === "manager.shutdown");
		order.push("shutdown");
		expect(order).toEqual(["launch", "register", "shutdown"]);
		expect(shutdown.requestId).toBe("close-last");
		expect((await browser.next((f) => f.type === "snapshot" && f.session?.id === "session-keepalive")).session.id).toBe("session-keepalive");
		const receipt = await browser.next((f) => f.type === "command.result" && f.requestId === "close-last");
		expect(receipt.ok).toBe(true);
	});

	test("a failed keepalive launch leaves the last instance alive and fails the request", async () => {
		let requestedCwd;
		await start({
			idleTimeoutMs: 5000,
			newSession: async (options) => {
				requestedCwd = options.cwd;
				return { ok: false, code: "launch_failed", message: "tmux: command not found" };
			},
		});
		const a = await agent("a");
		const browser = await connect(wsUrl("/ws"));
		await browser.next((f) => f.type === "manager.instances" && f.instances.length === 1);
		browser.send({ type: "manager.select", instanceId: "a", requestId: "select-a" });
		await browser.next((f) => f.type === "snapshot" && f.session?.id === "session-a");

		browser.send({ type: "manager.close_instance", instanceId: "a", requestId: "close-fail" });

		const receipt = await browser.next((f) => f.type === "command.result" && f.requestId === "close-fail");
		expect(receipt.ok).toBe(false);
		expect(receipt.code).toBe("launch_failed");
		expect(requestedCwd).toBe(join(homedir(), "Desktop"));
		await pause(120);
		expect(shutdowns(a)).toEqual([]);
		// The old instance must still be usable.
		browser.send({ type: "session.abort", requestId: "still-live" });
		await a.next((f) => f.type === "manager.command" && f.command?.requestId === "still-live");
	});

	test("an unknown instance fails with instance_gone and touches no other agent", async () => {
		let launches = 0;
		await start({
			idleTimeoutMs: 5000,
			newSession: async () => { launches += 1; return { ok: false, code: "unexpected" }; },
		});
		const a = await agent("a");
		const browser = await connect(wsUrl("/ws"));
		await browser.next((f) => f.type === "manager.instances" && f.instances.length === 1);

		browser.send({ type: "manager.close_instance", instanceId: "missing", requestId: "close-missing" });

		const receipt = await browser.next((f) => f.type === "command.result" && f.requestId === "close-missing");
		expect(receipt.ok).toBe(false);
		expect(receipt.code).toBe("instance_gone");
		expect(launches).toBe(0);
		await pause(60);
		expect(shutdowns(a)).toEqual([]);
	});
});
