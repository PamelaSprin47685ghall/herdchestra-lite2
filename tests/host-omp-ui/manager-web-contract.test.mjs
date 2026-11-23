import { describe, test, expect } from "bun:test";

/**
 * Red contract for the manager-era Web client.
 *
 * Do not run Red. This file pins the minimal public API the Green slice must
 * provide in `host-omp-ui/web/src/protocol`.
 *
 * 1. Authoritative model display
 *    `meta.update { model }` changes the model the user sees. A command result
 *    only settles the request; it never changes the model by itself.
 *
 * 2. Correlated command results
 *    Every state-changing command carries a `requestId`. The store keeps
 *    `WebState.commands: Record<requestId, CommandEntry>`:
 *      { command, status: "pending" | "ok" | "error", sessionId?, code?,
 *        message?, value? }
 *    Frames:
 *      { type: "command.pending", requestId, command, sessionId? }
 *      { type: "command.result", requestId, ok, command?, code?, message?,
 *        value?, sessionId? }
 *    A frame without `sessionId` belongs to the active session. Unsolicited
 *    results are dropped; a duplicate result keeps the first outcome.
 *    The client also exposes:
 *      createCommandRequest(type, payload?, requestId?) ->
 *        { requestId, frame }  // JSON frame carries payload.requestId
 *
 * 3. Session isolation
 *    `session.select { sessionId, title?, instanceId? }` is the intent frame:
 *    it is never filtered by the active session. It makes that session the
 *    active view and clears session-scoped display state (model, meta,
 *    transcript) until the selected session's snapshot arrives. Any other
 *    scoped frame (`snapshot`, `meta.update`, `transcript.delta`,
 *    `command.pending`, `command.result`, `session.switched`) whose
 *    `sessionId` differs from the active session is ignored.
 */

const STORE = "../../host-omp-ui/web/src/protocol/store.ts";
const CLIENT = "../../host-omp-ui/web/src/protocol/client.ts";

const MODEL_A = { provider: "p", id: "mA", name: "Model A" };
const MODEL_B = { provider: "p", id: "mB", name: "Model B" };
const MODEL_A2 = { provider: "p", id: "mA2", name: "Model A2" };

async function loadStore() {
	try {
		return await import(STORE);
	} catch (error) {
		throw new Error(`Red contract: cannot load ${STORE}: ${error.message}`);
	}
}

function snapshot({ id = "A", title = "Session A", model = MODEL_A, messages = [], ...rest } = {}) {
	return {
		type: "snapshot",
		sessionId: id,
		session: { id, title },
		messages,
		streaming: false,
		models: [MODEL_A, MODEL_B, MODEL_A2],
		model,
		meta: { model, thinkingLevel: "high" },
		thinkingLevel: "high",
		modes: {},
		todos: [],
		queue: { steering: [], followUp: [] },
		usage: null,
		draft: { rev: 0, text: "", origin: "tui" },
		pendingInteractions: [],
		surface: { sf: "s:web", s: 1, ops: [] },
		notifications: [],
		fenceStatus: "live",
		sessions: [],
		artifacts: [],
		...rest,
	};
}

function metaUpdate(sessionId, model, extra = {}) {
	return { type: "meta.update", sessionId, model, ...extra };
}

function selectSession(sessionId, extra = {}) {
	return { type: "session.select", sessionId, ...extra };
}

function commandPending(requestId, command, sessionId) {
	return {
		type: "command.pending",
		requestId,
		command,
		...(sessionId ? { sessionId } : {}),
	};
}

function commandResult(requestId, ok, extra = {}) {
	return { type: "command.result", requestId, ok, ...extra };
}

async function hydratedA() {
	const api = await loadStore();
	let state = api.createInitialWebState();
	state = api.reduceWebState(state, snapshot());
	return { api, state };
}

describe("history request lifecycle", () => {
  test("correlates pages, rejects failures and cancellation, and prevents concurrent requests", async () => {
    const names = ["WebSocket", "location", "sessionStorage", "history", "window"];
    const saved = Object.fromEntries(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    class FakeSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      static current;
      readyState = 0;
      sent = [];
      constructor() { FakeSocket.current = this; }
      send(data) { this.sent.push(JSON.parse(data)); }
      close() { this.readyState = 3; }
      receive(frame) { this.onmessage({ data: JSON.stringify(frame) }); }
    }
    const set = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    try {
      set("WebSocket", FakeSocket);
      set("location", { search: "?token=test", href: "http://localhost/?token=test", origin: "http://localhost", protocol: "http:" });
      set("sessionStorage", { setItem() {}, getItem() { return null; } });
      set("history", { replaceState() {} });
      set("window", globalThis);
      const { createBridgeClient } = await import(CLIENT);
      const client = createBridgeClient();
      const socket = FakeSocket.current;
      socket.readyState = FakeSocket.OPEN;
      socket.onopen();
      const frames = [];
      const unsubscribe = client.subscribe((frame) => { if (frame) frames.push(frame); });
      const pending = client.requestHistory("before-1");
      const id = socket.sent.at(-1).payload.requestId;
      await expect(client.requestHistory("before-2")).rejects.toThrow();
      socket.receive({ type: "history.page", requestId: "wrong", messages: [] });
      expect(frames.some((frame) => frame.type === "history.page")).toBe(false);
      socket.receive({ type: "history.page", requestId: id, messages: [{ id: "old" }] });
      expect((await pending).messages).toEqual([{ id: "old" }]);
      expect(frames.filter((frame) => frame.type === "history.page")).toHaveLength(1);
      const failure = client.requestHistory("before-2");
      socket.receive({ type: "command.result", requestId: socket.sent.at(-1).payload.requestId, ok: false, code: "failed" });
      await expect(failure).rejects.toThrow();
      const switching = client.requestHistory("before-3");
      client.sendCommand("manager.select", { instanceId: "next" });
      await expect(switching).rejects.toThrow();
      const disconnected = client.requestHistory("before-4");
      socket.onclose({ code: 4401 });
      await expect(disconnected).rejects.toThrow();
      unsubscribe();
    } finally {
      for (const name of names) {
        if (saved[name]) Object.defineProperty(globalThis, name, saved[name]);
        else delete globalThis[name];
      }
    }
  });
});

describe("authoritative model display", () => {
	test("a flat meta.update changes the model the user sees", async () => {
		const { api, state: initial } = await hydratedA();
		const state = api.reduceWebState(initial, metaUpdate("A", MODEL_B));
		expect(api.selectModelKey(state.model)).toBe("p/mB");
		expect(api.selectModelKey(state.meta.model)).toBe("p/mB");
		expect(state.models.some((model) => model.id === "mB")).toBe(true);
	});

	test("an enveloped meta.update changes the same model", async () => {
		const { api, state: initial } = await hydratedA();
		const state = api.reduceWebState(initial, {
			type: "meta.update",
			payload: { model: MODEL_B },
		});
		expect(api.selectModelKey(state.model)).toBe("p/mB");
	});

	test("meta.update without a model keeps the current model", async () => {
		const { api, state: initial } = await hydratedA();
		const state = api.reduceWebState(initial, {
			type: "meta.update",
			models: [MODEL_A, MODEL_B, MODEL_A2],
		});
		expect(api.selectModelKey(state.model)).toBe("p/mA");
		expect(state.models.map((model) => model.id)).toEqual(["mA", "mB", "mA2"]);
	});

	test("a command result never changes the model before host meta arrives", async () => {
		const { api, state: initial } = await hydratedA();
		let state = api.reduceWebState(initial, commandPending("r1", "session.set_model", "A"));
		state = api.reduceWebState(
			state,
			commandResult("r1", true, {
				command: "session.set_model",
				sessionId: "A",
				value: MODEL_B,
			}),
		);
		expect(api.selectModelKey(state.model)).toBe("p/mA");
		state = api.reduceWebState(state, metaUpdate("A", MODEL_B));
		expect(api.selectModelKey(state.model)).toBe("p/mB");
	});
});

describe("correlated command results", () => {
	test("a successful command settles under its originating requestId", async () => {
		const { api, state: initial } = await hydratedA();
		let state = api.reduceWebState(initial, commandPending("r1", "session.set_model", "A"));
		expect(state.commands?.r1).toMatchObject({
			command: "session.set_model",
			status: "pending",
			sessionId: "A",
		});
		state = api.reduceWebState(
			state,
			commandResult("r1", true, {
				command: "session.set_model",
				sessionId: "A",
				value: MODEL_B,
			}),
		);
		expect(state.commands?.r1).toMatchObject({
			command: "session.set_model",
			status: "ok",
			value: MODEL_B,
		});
	});

	test("a failure keeps its code and notifies once for that request", async () => {
		const { api, state: initial } = await hydratedA();
		let state = api.reduceWebState(initial, commandPending("r2", "session.set_model", "A"));
		const before = state.notifications.length;
		state = api.reduceWebState(
			state,
			commandResult("r2", false, {
				command: "session.set_model",
				sessionId: "A",
				code: "unknown_model",
				message: "provider p has no model mB",
			}),
		);
		expect(state.commands?.r2).toMatchObject({
			command: "session.set_model",
			status: "error",
			code: "unknown_model",
		});
		expect(state.notifications.length).toBe(before + 1);
		expect(state.notifications.some((notice) => notice.message.includes("unknown_model"))).toBe(true);
	});

	test("concurrent requests settle independently and out of order", async () => {
		const { api, state: initial } = await hydratedA();
		let state = api.reduceWebState(initial, commandPending("r3", "session.set_model", "A"));
		state = api.reduceWebState(state, commandPending("r4", "session.set_thinking", "A"));
		state = api.reduceWebState(
			state,
			commandResult("r4", true, {
				command: "session.set_thinking",
				sessionId: "A",
				value: "max",
			}),
		);
		expect(state.commands?.r4).toMatchObject({ status: "ok", value: "max" });
		expect(state.commands?.r3).toMatchObject({ status: "pending" });
		state = api.reduceWebState(
			state,
			commandResult("r3", false, {
				command: "session.set_model",
				sessionId: "A",
				code: "unknown_model",
			}),
		);
		expect(state.commands?.r3).toMatchObject({ status: "error", code: "unknown_model" });
		expect(state.commands?.r4).toMatchObject({ status: "ok" });
	});

	test("an unsolicited result does not create a phantom command", async () => {
		const { api, state: initial } = await hydratedA();
		const state = api.reduceWebState(
			initial,
			commandResult("ghost", true, {
				command: "session.set_model",
				sessionId: "A",
				value: MODEL_B,
			}),
		);
		expect(state.commands?.ghost).toBeUndefined();
		expect(state.notifications).toEqual(initial.notifications);
	});

	test("a duplicate result keeps the first outcome", async () => {
		const { api, state: initial } = await hydratedA();
		let state = api.reduceWebState(initial, commandPending("r5", "session.set_model", "A"));
		state = api.reduceWebState(
			state,
			commandResult("r5", false, {
				command: "session.set_model",
				sessionId: "A",
				code: "unknown_model",
			}),
		);
		const settled = state.commands?.r5;
		state = api.reduceWebState(
			state,
			commandResult("r5", true, {
				command: "session.set_model",
				sessionId: "A",
				value: MODEL_B,
			}),
		);
		expect(state.commands?.r5).toEqual(settled);
		expect(state.commands?.r5.status).toBe("error");
	});

	test("the client can build a command envelope with a requestId", async () => {
		let client;
		try {
			client = await import(CLIENT);
		} catch (error) {
			throw new Error(`Red contract: cannot load ${CLIENT}: ${error.message}`);
		}
		expect(typeof client.createCommandRequest).toBe("function");
		const first = client.createCommandRequest("session.set_model", {
			provider: "p",
			modelId: "mB",
		});
		const second = client.createCommandRequest("session.set_model", {
			provider: "p",
			modelId: "mB",
		});
		expect(typeof first.requestId).toBe("string");
		expect(first.requestId.length).toBeGreaterThan(0);
		expect(second.requestId).not.toBe(first.requestId);
		const frame = JSON.parse(first.frame);
		expect(frame.type).toBe("session.set_model");
		expect(frame.payload).toMatchObject({
			provider: "p",
			modelId: "mB",
			requestId: first.requestId,
		});
		const explicit = client.createCommandRequest(
			"session.set_thinking",
			{ level: "max" },
			"req-fixed",
		);
		expect(explicit.requestId).toBe("req-fixed");
		expect(JSON.parse(explicit.frame).payload.requestId).toBe("req-fixed");
	});
});

describe("session selection isolation", () => {
	test("selecting another session clears the previous view and its pending commands", async () => {
		const { api, state: initial } = await hydratedA();
		let state = api.reduceWebState(initial, commandPending("rA", "session.set_model", "A"));
		state = api.reduceWebState(
			state,
			selectSession("B", { title: "Session B", instanceId: "i-b" }),
		);
		expect(state.session?.id).toBe("B");
		expect(state.liveSession.session?.id).toBe("B");
		expect(state.messages).toEqual([]);
		expect(state.model).toBeNull();
		expect(state.meta.model ?? null).toBeNull();
		expect(state.commands?.rA).toBeUndefined();
		expect(state.models.map((model) => model.id)).toContain("mB");
	});

	test("the selected session hydrates from its own snapshot", async () => {
		const { api, state: initial } = await hydratedA();
		let state = api.reduceWebState(initial, selectSession("B", { title: "Session B" }));
		expect(state.session?.id).toBe("B");
		state = api.reduceWebState(
			state,
			snapshot({
				id: "B",
				title: "Session B",
				model: MODEL_B,
				messages: [{ id: "b1", role: "user", blocks: [{ type: "text", text: "from B" }] }],
			}),
		);
		expect(state.session.id).toBe("B");
		expect(state.messages.map((message) => message.id)).toEqual(["b1"]);
		expect(api.selectModelKey(state.model)).toBe("p/mB");
		expect(state.meta.model.id).toBe("mB");
	});

	test("a background snapshot never replaces the selected view", async () => {
		const { api, state: initial } = await hydratedA();
		let state = api.reduceWebState(initial, selectSession("B", { title: "Session B" }));
		state = api.reduceWebState(
			state,
			snapshot({
				id: "B",
				title: "Session B",
				model: MODEL_B,
				messages: [{ id: "b1", role: "user", blocks: [{ type: "text", text: "from B" }] }],
			}),
		);
		state = api.reduceWebState(
			state,
			snapshot({
				id: "A",
				title: "Session A",
				model: MODEL_A2,
				messages: [{ id: "a2", role: "user", blocks: [{ type: "text", text: "from A" }] }],
			}),
		);
		expect(state.session.id).toBe("B");
		expect(state.messages.map((message) => message.id)).toEqual(["b1"]);
		expect(api.selectModelKey(state.model)).toBe("p/mB");
	});

	test("late meta and transcript frames from the old session are ignored", async () => {
		const { api, state: initial } = await hydratedA();
		let state = api.reduceWebState(initial, selectSession("B", { title: "Session B" }));
		state = api.reduceWebState(
			state,
			snapshot({
				id: "B",
				title: "Session B",
				model: MODEL_B,
				messages: [{ id: "b1", role: "user", blocks: [{ type: "text", text: "from B" }] }],
			}),
		);
		const messagesBefore = state.messages;
		state = api.reduceWebState(state, metaUpdate("A", MODEL_A2));
		state = api.reduceWebState(state, {
			type: "transcript.delta",
			sessionId: "A",
			kind: "text_delta",
			messageId: "a-late",
			blockIndex: 0,
			delta: "late",
		});
		expect(api.selectModelKey(state.model)).toBe("p/mB");
		expect(state.meta.model.id).toBe("mB");
		expect(state.messages).toEqual(messagesBefore);
	});

	test("switching back rehydrates instead of replaying dropped frames", async () => {
		const { api, state: initial } = await hydratedA();
		let state = api.reduceWebState(initial, selectSession("B", { title: "Session B" }));
		state = api.reduceWebState(
			state,
			snapshot({ id: "B", title: "Session B", model: MODEL_B, messages: [] }),
		);
		state = api.reduceWebState(state, metaUpdate("A", MODEL_A2));
		state = api.reduceWebState(state, selectSession("A", { title: "Session A" }));
		expect(state.session.id).toBe("A");
		expect(state.model).toBeNull();
		state = api.reduceWebState(
			state,
			snapshot({
				id: "A",
				title: "Session A",
				model: MODEL_A2,
				messages: [{ id: "a2", role: "user", blocks: [{ type: "text", text: "latest A" }] }],
			}),
		);
		expect(api.selectModelKey(state.model)).toBe("p/mA2");
		expect(state.messages.map((message) => message.id)).toEqual(["a2"]);
	});

	test("pending and results are scoped to the active session", async () => {
		const { api, state: initial } = await hydratedA();
		let state = api.reduceWebState(initial, commandPending("rB", "session.set_model", "B"));
		expect(state.commands?.rB).toBeUndefined();

		state = api.reduceWebState(state, selectSession("B", { title: "Session B" }));
		state = api.reduceWebState(state, commandPending("rB2", "session.set_model"));
		expect(state.commands?.rB2).toMatchObject({
			command: "session.set_model",
			status: "pending",
			sessionId: "B",
		});

		state = api.reduceWebState(
			state,
			commandResult("rB2", true, { command: "session.set_model" }),
		);
		expect(state.commands?.rB2).toMatchObject({ status: "ok" });
	});

	test("a late result from the old session cannot settle a request in the new session", async () => {
		const { api, state: initial } = await hydratedA();
		let state = api.reduceWebState(initial, commandPending("r1", "session.set_model", "A"));
		state = api.reduceWebState(state, selectSession("B", { title: "Session B" }));
		state = api.reduceWebState(state, commandPending("r1", "session.set_thinking", "B"));
		state = api.reduceWebState(
			state,
			commandResult("r1", true, {
				command: "session.set_model",
				sessionId: "A",
			}),
		);
		expect(state.commands?.r1).toMatchObject({
			command: "session.set_thinking",
			status: "pending",
		});
	});
});
