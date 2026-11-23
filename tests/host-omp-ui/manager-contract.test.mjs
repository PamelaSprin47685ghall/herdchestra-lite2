import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Manager protocol contract. Red tests are deliberately not run before dispatch.
// Production API: createManagerServer({ preferredPort, token, staticDir, idleTimeoutMs })
// returns { port, url, close() }. /agent and /ws require the same token.
const MODULE = "../../host-omp-ui/src/manager/server.mjs";
const token = "manager-test-secret";
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
async function agent(id) {
	const a = await connect(wsUrl("/agent"));
	const prior = a.ws.onmessage;
	a.ws.onmessage = (event) => {
		prior(event);
		const frame = JSON.parse(String(event.data));
		if (frame.type === "manager.snapshot_request") a.send({ type: "agent.client_frame", clientId: frame.clientId, generation: frame.generation, frame: { type: "snapshot", session: { id: `session-${id}` } } });
	};
	a.send({ type: "agent.register", instanceId: id, pid: process.pid, session: { id: `session-${id}`, cwd: "/tmp" }, snapshot: { type: "snapshot", session: { id: `session-${id}` } } });
	return a;
}
const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
	for (const ws of sockets) ws.close();
	sockets.clear();
	if (manager) await manager.close();
	manager = undefined;
});

describe("machine manager", () => {
	test("history replies require a current matching request and session, and failed requests can retry", async () => {
		await start({ idleTimeoutMs: 5000 });
		const a = await agent("a");
		const browser = await connect(wsUrl("/ws"));
		await browser.next((f) => f.type === "snapshot");
		browser.send({ type: "manager.history", payload: { before: "m", requestId: "old" } });
		const old = await a.next((f) => f.type === "manager.command" && f.command?.requestId === "old");
		a.send({ type: "agent.update", session: { id: "new-session" } });
		await browser.next((f) => f.type === "manager.instances" && f.instances[0]?.session?.id === "new-session");
		a.send({ type: "agent.client_frame", clientId: old.clientId, frame: { type: "history.page", requestId: "old", messages: [{ id: "stale" }] } });
		browser.send({ type: "manager.history", payload: { before: "m", requestId: "retry" } });
		const retry = await a.next((f) => f.type === "manager.command" && f.command?.requestId === "retry");
		a.send({ type: "agent.client_frame", clientId: retry.clientId, frame: { type: "command.result", requestId: "retry", ok: false } });
		await browser.next((f) => f.type === "command.result" && f.requestId === "retry");
		a.send({ type: "agent.client_frame", clientId: retry.clientId, frame: { type: "history.page", requestId: "retry", messages: [{ id: "failed" }] } });
		browser.send({ type: "manager.history", payload: { before: "m", requestId: "good" } });
		const good = await a.next((f) => f.type === "manager.command" && f.command?.requestId === "good");
		a.send({ type: "agent.client_frame", clientId: good.clientId, frame: { type: "history.page", requestId: "wrong", messages: [{ id: "injected" }] } });
		a.send({ type: "agent.client_frame", clientId: good.clientId, frame: { type: "history.page", requestId: "good", messages: [{ id: "valid" }] } });
		expect((await browser.next((f) => f.type === "history.page")).messages[0].id).toBe("valid");
		await pause(30);
		expect(browser.frames.some((f) => f.type === "history.page")).toBe(false);
	});
	test("serves only public static assets and protects manager APIs", async () => {
		const dir = await mkdtemp(join(tmpdir(), "omp-manager-static-"));
		try {
			await mkdir(join(dir, "dist"));
			await writeFile(join(dir, "index.html"), "<title>manager</title>");
			await writeFile(join(dir, "dist", "app.js"), "console.log('manager')");
			await writeFile(join(dir, "secret.txt"), "private");
			await start({ staticDir: dir, idleTimeoutMs: 5000 });
			expect((await fetch(`${manager.url}/api/health`)).status).toBe(200);
			expect((await fetch(`${manager.url}/api/bootstrap`)).status).toBe(401);
			expect((await fetch(`${manager.url}/api/sessions`)).status).toBe(401);
			expect((await fetch(`${manager.url}/api/instances`)).status).toBe(401);
			expect((await fetch(`${manager.url}/api/bootstrap`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
			const indexResponse = await fetch(`${manager.url}/`);
			expect(await indexResponse.text()).toContain("manager");
			expect(indexResponse.headers.get("cache-control")).toBe("no-store");
			const appResponse = await fetch(`${manager.url}/dist/app.js`);
			expect(await appResponse.text()).toContain("console.log");
			expect(appResponse.headers.get("cache-control")).toContain("no-cache");
			expect(appResponse.headers.get("content-type")).toContain("javascript");
			expect((await fetch(`${manager.url}/secret.txt`)).status).not.toBe(200);
			expect((await fetch(`${manager.url}/dist/%2e%2e/secret.txt`)).status).not.toBe(200);
		} finally { await rm(dir, { recursive: true, force: true }); }
	});
	test("does not silently choose a different port when the fixed port is occupied", async () => {
		const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") });
		try {
			const { createManagerServer } = await import(MODULE);
			await expect(createManagerServer({ preferredPort: blocker.port, token })).rejects.toThrow();
			expect(await (await fetch(`http://127.0.0.1:${blocker.port}`)).text()).toBe("occupied");
		} finally { blocker.stop(true); }
	});

	test("reports a fixed port occupied by an old service without sending it credentials", async () => {
		const requests = [];
		const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
			requests.push({ url: request.url, authorization: request.headers.get("authorization") });
			return new Response("unauthorized", { status: 401 });
		} });
		let client;
		try {
			const { createManagerClient } = await import("../../host-omp-ui/src/host/manager-client.mjs");
			const statuses = [];
			client = await createManagerClient({ preferredPort: blocker.port, token, onStatus: (state, reason) => statuses.push({ state, reason }) });
			const error = statuses.find((item) => item.state === "error")?.reason ?? "";
			expect(error).toContain(String(blocker.port));
			expect(error).toContain("占用");
			expect(error).toContain("旧");
			expect(error).toContain("重启");
			expect(error).not.toContain(token);
			expect(client.port).toBe(blocker.port);
			expect(requests.length).toBeGreaterThan(0);
			expect(requests.every((request) => !request.url.includes(token) && !request.authorization)).toBe(true);
		} finally { await client?.close(); blocker.stop(true); }
	});

	test("routes snapshots and commands to the selected instance and excludes the previous instance", async () => {
		await start({ idleTimeoutMs: 5000 });
		const a = await agent("a");
		const b = await agent("b");
		const browser = await connect(wsUrl("/ws"));
		await browser.next((f) => f.type === "manager.instances" && f.instances.length === 2);
		browser.send({ type: "manager.select", instanceId: "a", requestId: "select-a" });
		expect((await browser.next((f) => f.type === "snapshot" && f.session?.id === "session-a")).session.id).toBe("session-a");
		browser.send({ type: "session.abort", requestId: "abort-a" });
		const command = await a.next((f) => f.type === "manager.command" && f.command?.requestId === "abort-a");
		expect(command.command.type).toBe("session.abort");
		browser.send({ type: "manager.select", instanceId: "b", requestId: "select-b" });
		await browser.next((f) => f.type === "snapshot" && f.session?.id === "session-b");
		a.send({ type: "agent.frame", frame: { type: "transcript.delta", text: "from-old" } });
		b.send({ type: "agent.frame", frame: { type: "transcript.delta", text: "from-current" } });
		expect((await browser.next((f) => f.type === "transcript.delta")).text).toBe("from-current");
		await pause();
		expect(browser.frames.some((f) => f.text === "from-old")).toBe(false);
		browser.send({ type: "session.abort", requestId: "abort-b" });
		expect((await b.next((f) => f.type === "manager.command" && f.command?.requestId === "abort-b")).command.type).toBe("session.abort");
	});

	test("one agent disconnecting leaves the other usable; last agent disconnect releases the port", async () => {
		await start({ idleTimeoutMs: 50 });
		const a = await agent("a");
		const b = await agent("b");
		const browser = await connect(wsUrl("/ws"));
		await browser.next((f) => f.type === "manager.instances" && f.instances.length === 2);
		a.ws.close();
		await browser.next((f) => f.type === "manager.instances" && f.instances.length === 1 && f.instances[0].instanceId === "b");
		browser.send({ type: "manager.select", instanceId: "b", requestId: "choose" });
		await browser.next((f) => f.type === "snapshot" && f.session?.id === "session-b");
		browser.send({ type: "session.abort", requestId: "still-live" });
		await b.next((f) => f.type === "manager.command" && f.command?.requestId === "still-live");
		const port = manager.port;
		b.ws.close();
		await pause(250);
		const replacement = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("free") });
		replacement.stop(true);
	});

	test("rejects unauthenticated agents and browsers before they can influence the session", async () => {
		await start({ idleTimeoutMs: 5000 });
		await expect(connect(wsUrl("/agent", "bad"))).rejects.toThrow();
		await expect(connect(wsUrl("/ws", "bad"))).rejects.toThrow();
		const a = await agent("a");
		const browser = await connect(wsUrl("/ws"));
		const list = await browser.next((f) => f.type === "manager.instances");
		expect(list.instances.map((i) => i.instanceId)).toEqual(["a"]);
		await pause();
		expect(a.frames.some((f) => f.type === "manager.command")).toBe(false);
	});
});
