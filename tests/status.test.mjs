import { describe, expect, test } from "bun:test";
import { hostname, userInfo } from "node:os";
import { createStatusRuntime } from "../src/host/index.mjs";

function makeUi() {
	const working = [];
	const statuses = new Map();
	const widgets = new Map();
	const widgetWrites = [];
	return {
		working,
		statuses,
		widgets,
		widgetWrites,
		setWorkingMessage(text) {
			working.push(text);
		},
		setStatus(key, text) {
			statuses.set(key, text);
		},
		setWidget(key, content, options) {
			widgetWrites.push({ key, content, options });
			widgets.set(key, { content, options });
		},
	};
}

function makeHost() {
	const handlers = new Map();
	const pi = {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
	};
	return { pi, handlers };
}

function makeManager(entries = [], name = "Herd 2A: mission") {
	return {
		getBranch: () => entries,
		getSessionName: () => name,
	};
}

function emit(handlers, event, payload, ctx) {
	for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
}

function usage(input, output = 0, cost = 0) {
	return { input_tokens: input, output_tokens: output, total_cost: cost };
}

function herdLine(ui) {
	return ui.widgets.get("herd").content[0];
}

describe("one-line status widget", () => {
	test("session_start writes usage, session, and host on one line", () => {
		const { pi, handlers } = makeHost();
		const runtime = createStatusRuntime();
		runtime.install(pi);
		const ui = makeUi();
		const ctx = { hasUI: true, ui, sessionManager: makeManager() };

		emit(handlers, "session_start", {}, ctx);

		expect(ui.widgets.get("herd").content).toHaveLength(1);
		const line = herdLine(ui);
		expect(line).toContain("Δ: 0.0k × 0.0% → 0.0k [¥𝟬.𝟬𝟬𝟬];");
		expect(line).toContain("Herd 2A");
		expect(line).toContain("@");
		expect(line.split("  ---  ")).toHaveLength(3);
		expect(ui.widgets.get("herd").options).toEqual({ placement: "aboveEditor" });
		expect(ui.statuses.size).toBe(0);
		expect(ui.working).toEqual([]);
	});

	test("message_end updates the same line and keeps it one line", () => {
		const { pi, handlers } = makeHost();
		const runtime = createStatusRuntime();
		runtime.install(pi);
		const ui = makeUi();
		const ctx = { hasUI: true, ui, sessionManager: makeManager() };

		emit(handlers, "session_start", {}, ctx);
		emit(handlers, "message_end", { message: { role: "assistant", usage: usage(1000, 200, 0.123) } }, ctx);

		const line = herdLine(ui);
		expect(ui.widgets.get("herd").content).toHaveLength(1);
		expect(line).toContain("Δ: 1.0k × 0.0% → 0.2k [¥𝟬.𝟭𝟮𝟯];");
		expect(line).toContain("Σ: 1.0k × 0.0% → 0.2k [¥𝟬.𝟭𝟮𝟯];");
		expect(line).toContain("Herd 2A");
		expect(line).toContain("@");
		expect(ui.statuses.size).toBe(0);
		expect(ui.working).toEqual([]);
	});

	test("identical text is not written twice", () => {
		const { pi, handlers } = makeHost();
		const runtime = createStatusRuntime();
		runtime.install(pi);
		const ui = makeUi();
		const ctx = { hasUI: true, ui, sessionManager: makeManager() };

		emit(handlers, "session_start", {}, ctx);
		const before = ui.widgetWrites.length;
		emit(handlers, "message_update", {}, ctx);
		emit(handlers, "tool_execution_update", {}, ctx);
		emit(handlers, "message_start", {}, ctx);
		expect(ui.widgetWrites.length).toBe(before);
		expect(ui.widgets.get("herd").content).toHaveLength(1);
	});

	test("sums the charge of each call after a model switch", () => {
		const { pi, handlers } = makeHost();
		const runtime = createStatusRuntime();
		runtime.install(pi);
		const ui = makeUi();
		const ctx = { hasUI: true, ui, sessionManager: makeManager() };

		emit(handlers, "session_start", {}, ctx);
		// The same 1000 tokens cost 0.030, then 0.002 on the next model.
		emit(handlers, "message_end", { message: { role: "assistant", usage: usage(1000, 0, 0.03) } }, ctx);
		emit(handlers, "message_end", { message: { role: "assistant", usage: usage(1000, 0, 0.002) } }, ctx);

		const line = herdLine(ui);
		expect(line).toContain("Σ: 2.0k × 0.0% → 0.0k [¥𝟬.𝟬𝟯𝟮];");
		expect(line).not.toContain("¥𝟬.𝟬𝟲𝟬");
		expect(line).not.toContain("¥𝟬.𝟬𝟬𝟰");
	});

	test("reads historical usage from the branch on session start", () => {
		const { pi, handlers } = makeHost();
		const runtime = createStatusRuntime();
		runtime.install(pi);
		const ui = makeUi();
		const manager = makeManager([
			{ type: "message", message: { role: "assistant", usage: usage(2000, 500, 0.2) } },
		]);
		const ctx = { hasUI: true, ui, sessionManager: manager };

		emit(handlers, "session_start", {}, ctx);
		expect(herdLine(ui)).toContain("Σ: 2.0k × 0.0% → 0.5k [¥𝟬.𝟮𝟬𝟬];");
		expect(ui.widgets.get("herd").content).toHaveLength(1);
	});

	test("dims the line, highlights only ¥ amounts, and puts host first", () => {
		const { pi, handlers } = makeHost();
		const runtime = createStatusRuntime();
		runtime.install(pi);
		const ui = makeUi();
		ui.theme = {
			fg(role, text) {
				return `<${role}>${text}</>`;
			},
		};
		const ctx = { hasUI: true, ui, sessionManager: makeManager() };

		emit(handlers, "session_start", {}, ctx);
		emit(
			handlers,
			"message_end",
			{ message: { role: "assistant", usage: usage(1000, 200, 0.123) } },
			ctx,
		);

		const line = herdLine(ui);
		const expectedHost = userInfo().username + "@" + hostname().split(".")[0];
		expect(line.startsWith("<accent>" + expectedHost + "</>")).toBe(true);
		expect(line).toContain("<dim>Herd 2A</>");
		expect(line.split("<dim>  ---  </>").length - 1).toBe(2);
		expect(line.indexOf("Δ:")).toBeLessThan(line.indexOf("Herd 2A"));
		expect(line.split("<accent>[¥").length - 1).toBe(2);
		expect(line).toContain("<accent>[¥𝟬.𝟭𝟮𝟯]</>");
	});
});

describe("subagents and degraded hosts", () => {
	test("a subagent never writes the main widget and the latest usage supplies the delta", () => {
		const { pi, handlers } = makeHost();
		const runtime = createStatusRuntime();
		runtime.install(pi);
		const ui = makeUi();
		const mainCtx = { hasUI: true, ui, sessionManager: makeManager([], "Herd 2A: main") };
		const subCtx = {
			hasUI: true,
			ui,
			agent: { kind: "sub", depth: 1 },
			sessionManager: makeManager([], "Herd 2A: sub"),
		};

		emit(handlers, "session_start", {}, subCtx);
		emit(handlers, "message_end", { message: { role: "assistant", usage: usage(1500, 100, 0.1) } }, subCtx);
		expect(ui.widgets.size).toBe(0);
		expect(ui.working).toEqual([]);

		emit(handlers, "session_start", {}, mainCtx);
		emit(handlers, "message_end", { message: { role: "assistant", usage: usage(10, 5, 0) } }, mainCtx);
		const line = herdLine(ui);
		expect(line).toContain("Δ: 0.0k × 0.0% → 0.0k [¥𝟬.𝟬𝟬𝟬];");
		expect(line).toContain("Herd 2A");
		expect(line).toContain("@");
	});

	test("a host without ui or session names degrades silently", () => {
		const { pi, handlers } = makeHost();
		const runtime = createStatusRuntime();
		runtime.install(pi);
		const ctx = { sessionManager: makeManager([], null) };
		expect(() => {
			emit(handlers, "session_start", {}, ctx);
			emit(handlers, "message_end", { message: { role: "assistant", usage: usage(10) } }, ctx);
			emit(handlers, "message_update", {}, ctx);
		}).not.toThrow();
	});

	test("retries the widget after the UI becomes available", () => {
		const { pi, handlers } = makeHost();
		const runtime = createStatusRuntime();
		runtime.install(pi);
		const ui = makeUi();
		const manager = makeManager();
		const hidden = { hasUI: false, ui, sessionManager: manager };
		emit(handlers, "session_start", {}, hidden);
		expect(ui.widgets.size).toBe(0);

		const visible = { hasUI: true, ui, sessionManager: manager };
		emit(
			handlers,
			"message_end",
			{ message: { role: "assistant", usage: usage(1000, 200, 0.123) } },
			visible,
		);
		const line = herdLine(ui);
		expect(ui.widgets.get("herd").content).toHaveLength(1);
		expect(line).toContain("Δ: 1.0k × 0.0% → 0.2k");
		expect(line).toContain("Herd 2A");
		expect(line).toContain("@");
	});

	test("writes when hasUI is absent but ui.setWidget exists", () => {
		const { pi, handlers } = makeHost();
		const runtime = createStatusRuntime();
		runtime.install(pi);
		const ui = makeUi();
		const ctx = { ui, sessionManager: makeManager() };
		emit(handlers, "session_start", {}, ctx);
		expect(herdLine(ui)).toContain("Δ:");
		expect(ui.widgets.get("herd").content).toHaveLength(1);
	});

	test("never calls setStatus or setWorkingMessage", () => {
		const { pi, handlers } = makeHost();
		const runtime = createStatusRuntime();
		runtime.install(pi);
		const ui = makeUi();
		ui.setStatus = () => {
			throw new Error("the extension must not write status entries");
		};
		ui.setWorkingMessage = () => {
			throw new Error("the extension must not write the native line");
		};
		const ctx = { hasUI: true, ui, sessionManager: makeManager() };
		expect(() => {
			emit(handlers, "session_start", {}, ctx);
			emit(handlers, "message_end", { message: { role: "assistant", usage: usage(10) } }, ctx);
		}).not.toThrow();
		expect(herdLine(ui)).toContain("Δ:");
		expect(ui.working).toEqual([]);
	});

	test("a rejecting setWidget does not break the event path", () => {
		const { pi, handlers } = makeHost();
		const runtime = createStatusRuntime();
		runtime.install(pi);
		const ui = makeUi();
		ui.setWidget = () => {
			throw new Error("host rejected the widget");
		};
		const ctx = { hasUI: true, ui, sessionManager: makeManager() };
		expect(() => {
			emit(handlers, "session_start", {}, ctx);
			emit(handlers, "message_end", { message: { role: "assistant", usage: usage(10) } }, ctx);
		}).not.toThrow();
		expect(ui.working).toEqual([]);
	});
});

describe("diagnostic count on the status line", () => {
	test("stays off the line when no diagnostic is recorded", () => {
		const { pi, handlers } = makeHost();
		const runtime = createStatusRuntime({ diagnostics: { total: () => 0 } });
		runtime.install(pi);
		const ui = makeUi();
		const ctx = { hasUI: true, ui, sessionManager: makeManager() };
		emit(handlers, "session_start", {}, ctx);
		expect(herdLine(ui)).not.toContain("⚠");
	});

	test("appends the count once a diagnostic is recorded", () => {
		let issues = 0;
		const { pi, handlers } = makeHost();
		const runtime = createStatusRuntime({
			diagnostics: { total: () => issues },
		});
		runtime.install(pi);
		const ui = makeUi();
		const ctx = { hasUI: true, ui, sessionManager: makeManager() };
		emit(handlers, "session_start", {}, ctx);
		issues = 3;
		emit(
			handlers,
			"message_end",
			{ message: { role: "assistant", usage: usage(10) } },
			ctx,
		);
		expect(herdLine(ui)).toContain("⚠ 3");
	});
});

describe("one ledger per session, shared across extension instances", () => {
	test("a flow's request reaches the owner's line even though the flow has no UI", () => {
		const owner = makeHost();
		createStatusRuntime().install(owner.pi);
		const ui = makeUi();
		const manager = makeManager();
		const ownerCtx = { hasUI: true, ui, sessionManager: manager };
		emit(owner.handlers, "session_start", {}, ownerCtx);

		// A fission flow loads the extension again: its own runtime, its own
		// handlers, and `hasUI: false`. The usage must still land on the owner's
		// line, and the owner must never be the one counted twice.
		const flow = makeHost();
		createStatusRuntime().install(flow.pi);
		const flowCtx = { hasUI: false, sessionManager: manager, agent: { kind: "main", id: "flow-a" } };
		emit(
			flow.handlers,
			"message_end",
			{ message: { role: "assistant", usage: usage(2000, 300, 0.5) } },
			flowCtx,
		);

		const line = herdLine(ui);
		expect(line).toContain("Δ: 2.0k × 0.0% → 0.3k [¥𝟬.𝟱𝟬𝟬];");
		expect(line).toContain("Σ: 2.0k × 0.0% → 0.3k [¥𝟬.𝟱𝟬𝟬];");
	});

	test("Δ and Σ advance once per request, not once per runtime", () => {
		const owner = makeHost();
		createStatusRuntime().install(owner.pi);
		const ui = makeUi();
		const manager = makeManager();
		const ownerCtx = { hasUI: true, ui, sessionManager: manager };
		emit(owner.handlers, "session_start", {}, ownerCtx);

		const flow = makeHost();
		createStatusRuntime().install(flow.pi);
		const flowCtx = { hasUI: false, sessionManager: manager, agent: { kind: "main", id: "flow-a" } };

		emit(owner.handlers, "message_end", { message: { role: "assistant", usage: usage(1000, 100, 0.1) } }, ownerCtx);
		emit(flow.handlers, "message_end", { message: { role: "assistant", usage: usage(3000, 400, 0.4) } }, flowCtx);

		const line = herdLine(ui);
		// Δ is the latest single request, Σ is both.
		expect(line).toContain("Δ: 3.0k × 0.0% → 0.4k [¥𝟬.𝟰𝟬𝟬];");
		expect(line).toContain("Σ: 4.0k × 0.0% → 0.5k [¥𝟬.𝟱𝟬𝟬];");
	});

	test("a new root session starts a fresh tree ledger", () => {
		const first = makeHost();
		createStatusRuntime().install(first.pi);
		const firstUi = makeUi();
		const firstCtx = { hasUI: true, ui: firstUi, sessionManager: makeManager() };
		emit(first.handlers, "session_start", {}, firstCtx);
		emit(first.handlers, "message_end", { message: { role: "assistant", usage: usage(1000) } }, firstCtx);
		expect(herdLine(firstUi)).toContain("Σ: 1.0k");

		// `/new`: another root session in the same process must not inherit the
		// previous tree's spend.
		const second = makeHost();
		createStatusRuntime().install(second.pi);
		const secondUi = makeUi();
		const secondCtx = { hasUI: true, ui: secondUi, sessionManager: makeManager() };
		emit(second.handlers, "session_start", {}, secondCtx);
		emit(second.handlers, "message_end", { message: { role: "assistant", usage: usage(5000) } }, secondCtx);

		expect(herdLine(secondUi)).toContain("Δ: 5.0k × 0.0% → 0.0k [¥𝟬.𝟬𝟬𝟬];");
		expect(herdLine(secondUi)).toContain("Σ: 5.0k × 0.0% → 0.0k [¥𝟬.𝟬𝟬𝟬];");
	});

	test("a flow's start does not wipe the tree ledger it joins", () => {
		const owner = makeHost();
		createStatusRuntime().install(owner.pi);
		const ui = makeUi();
		const manager = makeManager();
		const ownerCtx = { hasUI: true, ui, sessionManager: manager };
		emit(owner.handlers, "session_start", {}, ownerCtx);
		emit(owner.handlers, "message_end", { message: { role: "assistant", usage: usage(1000) } }, ownerCtx);

		const flow = makeHost();
		createStatusRuntime().install(flow.pi);
		const flowCtx = {
			hasUI: false,
			sessionManager: manager,
			agent: { kind: "main", id: "flow-a", parentId: "Main" },
		};
		emit(flow.handlers, "session_start", {}, flowCtx);
		emit(flow.handlers, "message_end", { message: { role: "assistant", usage: usage(3000) } }, flowCtx);

		expect(herdLine(ui)).toContain("Σ: 4.0k");
	});
});
