import { describe, test, expect } from "bun:test";

// Red contract for host-omp-ui/src/main.mjs and host-omp-ui/src/activation/index.mjs.
// Do not run Red. The module is expected to be implemented by the Green slice.
const MAIN = "../../host-omp-ui/src/main.mjs";

async function load() {
	try {
		return await import(MAIN);
	} catch (error) {
		throw new Error(`Red contract: ${MAIN} is not implemented yet (${error.message})`);
	}
}

function spy(impl = () => {}) {
	const calls = [];
	const fn = (...args) => {
		calls.push(args);
		return impl(...args);
	};
	fn.calls = calls;
	fn.called = () => calls.length > 0;
	return fn;
}

function makePi() {
	const renderers = [];
	const commands = [];
	const handlers = new Map();
	const tools = [];
	return {
		pi: { Composer: class Composer {}, CustomEditor: class CustomEditor {} },
		registerMessageRenderer(name, fn) {
			renderers.push({ name, fn });
		},
		registerCommand(name, definition) {
			commands.push({ name, definition });
		},
		on(event, fn) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(fn);
		},
		registerTool(tool) {
			tools.push(tool);
		},
		registerShortcut() {},
		registerFlag() {},
		setLabel() {},
		getFlag() {
			return undefined;
		},
		renderers,
		commands,
		handlers,
		tools,
	};
}

function makeUi() {
	const original = {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		editor: async () => undefined,
		askDialog: async () => ({ answers: [] }),
		formDialog: async () => ({ data: {} }),
		approve: async () => "deny",
		notify: () => {},
		setStatus: () => {},
		setWidget: () => {},
		setTitle: () => {},
		setWorkingMessage: () => {},
	};
	return {
		...original,
		original,
		getEditorComponent: () => undefined,
		setEditorComponent: spy(),
	};
}

function makeCtx(overrides = {}) {
	const ui = overrides.ui ?? makeUi();
	return {
		mode: "tui",
		hasUI: true,
		agent: { kind: "main", id: "main", name: "main", depth: 0 },
		cwd: "/tmp/work",
		ui,
		sessionManager: {
			getSessionId: () => "s1",
			getSessionFile: () => "/tmp/s1.jsonl",
			getSessionName: () => "Session 1",
			getCwd: () => "/tmp/work",
			getBranch: () => [],
			getEntries: () => [],
			getLeafId: () => null,
			getUsageStatistics: () => ({}),
		},
		models: {
			list: () => [],
			current: () => null,
			resolve: () => undefined,
			family: () => "family",
		},
		getContextUsage: () => ({ tokens: 0, contextWindow: 1000, percent: 0 }),
		isIdle: () => true,
		abort: spy(),
		resolvePlanReview: spy(() => true),
		getPendingPlanReview: () => undefined,
		sessionModes: undefined,
		...overrides,
	};
}

async function activate(pi, env = {}) {
	const api = await load();
	const fn = api.activate ?? api.default;
	expect(typeof fn).toBe("function");
	await fn(pi, {
		host: "127.0.0.1",
		port: 0,
		token: "tok",
		cwd: "/tmp/work",
		...env,
	});
	return api;
}

describe("activate factory", () => {
	test("registers herd-ui/noop to force eager loading and never starts a port", async () => {
		const pi = makePi();
		const env = { port: 0, token: "tok" };
		await activate(pi, env);

		const noop = pi.renderers.find((entry) => entry.name === "herd-ui/noop");
		expect(noop).toBeDefined();
		expect(noop.fn()).toBeUndefined();
		expect(pi.handlers.has("session_start")).toBe(true);
		expect(env.server).toBeUndefined();
	});

	test("registers a /web command that reports the URL or the reason it is unavailable", async () => {
		const pi = makePi();
		await activate(pi);
		const command = pi.commands.find((entry) => entry.name === "web");
		expect(command).toBeDefined();

		const output = [];
		const cmdCtx = { ui: { notify: (message) => output.push(message) } };
		await command.definition.handler("", cmdCtx);
		expect(output.length).toBeGreaterThan(0);
		expect(output.join(" ")).toMatch(/http:\/\/127\.0\.0\.1|not|unavailable|session/i);
	});
});

describe("session lifecycle", () => {
	test("a newly captured editor is rebound to the current session bridge", async () => {
		const pi = makePi();
		const ctx = makeCtx();
		await activate(pi);
		await pi.handlers.get("session_start")[0]({ type: "session_start" }, ctx);
		const editor = { setBridge: spy() };
		const composer = new pi.pi.Composer();
		composer.ui = {};
		composer.editor = editor;
		composer.renderFrame();
		expect(editor.setBridge.called()).toBe(true);
		await pi.handlers.get("session_shutdown")[0]({ type: "session_shutdown" }, ctx);
	});
	test("starts the server, decorates ui, installs the editor, and subscribes to official events", async () => {
		const pi = makePi();
		const ui = makeUi();
		const ctx = makeCtx({ ui });
		await activate(pi);

		const handler = pi.handlers.get("session_start")[0];
		await Promise.resolve(handler({ type: "session_start" }, ctx));

		expect(ui.setEditorComponent.called()).toBe(true);
		expect(Object.getOwnPropertyDescriptor(ui, "formDialog").value).not.toBe(ui.original.formDialog);

		for (const event of [
			"message_start",
			"message_update",
			"message_end",
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
			"agent_start",
			"agent_end",
			"queue_update",
			"todo_reminder",
			"model_changed",
			"thinking_level_changed",
			"mode_changed",
			"plan_review_requested",
			"plan_review_resolved",
			"session_switch",
			"session_clear",
			"session_branch",
			"session_shutdown",
		]) {
			expect(pi.handlers.has(event)).toBe(true);
		}

		const shutdown = pi.handlers.get("session_shutdown")[0];
		await expect(Promise.resolve(shutdown({ type: "session_shutdown" }, ctx))).resolves.toBeUndefined();
		expect(Object.getOwnPropertyDescriptor(ui, "formDialog").value).toBe(ui.original.formDialog);
	});

	test("registers a runnable RPC main session with the manager and leaves the TUI untouched", async () => {
		const pi = makePi();
		pi.sendUserMessage = spy(async () => {});
		const ui = makeUi();
		const ctx = makeCtx({ ui, mode: "rpc", hasUI: false });
		const blocker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
		const port = blocker.port;
		blocker.stop(true);
		await activate(pi, { port, token: "tok-rpc" });

		const handler = pi.handlers.get("session_start")[0];
		await Promise.resolve(handler({ type: "session_start" }, ctx));

		const deadline = Date.now() + 5000;
		let instance;
		while (Date.now() < deadline) {
			try {
				const response = await fetch(`http://127.0.0.1:${port}/api/instances`, {
					headers: { Authorization: "Bearer tok-rpc" },
				});
				if (response.ok) {
					const rows = await response.json();
					instance = rows.find((row) => row.session?.id === "s1");
					if (instance) break;
				}
			} catch {}
			await Bun.sleep(25);
		}
		expect(instance).toBeDefined();
		expect(instance.mode).toBe("rpc");
		expect(instance.capabilities.canCompose).toBe(true);
		expect(instance.capabilities.canUseTuiSurface).toBe(false);

		expect(ui.setEditorComponent.called()).toBe(false);
		expect(Object.getOwnPropertyDescriptor(ui, "formDialog").value).toBe(ui.original.formDialog);

		const shutdown = pi.handlers.get("session_shutdown")[0];
		await shutdown({ type: "session_shutdown" }, ctx);

		const stopDeadline = Date.now() + 5000;
		let unregistered = false;
		while (Date.now() < stopDeadline) {
			try {
				const response = await fetch(`http://127.0.0.1:${port}/api/instances`, {
					headers: { Authorization: "Bearer tok-rpc" },
				});
				if (!response.ok) {
					unregistered = true;
					break;
				}
				const rows = await response.json();
				if (!rows.some((row) => row.session?.id === "s1")) {
					unregistered = true;
					break;
				}
			} catch {
				unregistered = true;
				break;
			}
			await Bun.sleep(25);
		}
		expect(unregistered).toBe(true);
	});

	test("does not start the web surface for subagent sessions", async () => {
		const pi = makePi();
		const ui = makeUi();
		const ctx = makeCtx({ ui, agent: { kind: "sub", id: "sub-1", name: "worker", depth: 1 } });
		await activate(pi);

		const handler = pi.handlers.get("session_start")[0];
		await Promise.resolve(handler({ type: "session_start" }, ctx));

		expect(ui.setEditorComponent.called()).toBe(false);
	});

	test("contains a throwing ui and never rejects into the omp host", async () => {
		const pi = makePi();
		await activate(pi);
		const handler = pi.handlers.get("session_start")[0];
		const badCtx = makeCtx();
		Object.defineProperty(badCtx, "ui", {
			get() {
				throw new Error("ui exploded");
			},
		});

		let thrown;
		try {
			await Promise.resolve(handler({ type: "session_start" }, badCtx));
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeUndefined();
	});
});
