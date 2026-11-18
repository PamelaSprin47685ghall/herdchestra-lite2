import { describe, expect, test } from "bun:test";
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
		expect(line.startsWith("<accent>kunweiz@")).toBe(true);
		expect(line).toContain("<dim>Herd 2A</>");
		expect(line.split("<dim>  ---  </>").length - 1).toBe(2);
		expect(line.indexOf("Δ:")).toBeLessThan(line.indexOf("Herd 2A"));
		expect(line.split("<accent>[¥").length - 1).toBe(2);
		expect(line).toContain("<accent>[¥𝟬.𝟭𝟮𝟯]</>");
	});
});

describe("subagents and degraded hosts", () => {
	test("a subagent never writes the main widget but supplies the active delta", () => {
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
		expect(line).toContain("Δ: 1.5k × 0.0% → 0.1k [¥𝟬.𝟭𝟬𝟬];");
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
