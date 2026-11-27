import { afterEach, expect, test } from "bun:test";
import {
	ACTIVE_TOOLS_WIDGET_KEY,
	CHILD_ACTIVITY_TYPE,
	bindScopeView,
	captureTranscriptSubscriptions,
	childDisplayFor,
	registerToolCardComponent,
	renderChildActivity,
} from "../host-omp/src/host/child-display.mjs";
import { createBracketLedger, markReady, registerFork } from "../src/scope/ledger-brackets.mjs";
import { createScopes } from "../src/scope/scopes.mjs";

class Session {
	#listeners = new Set();
	subscribe(listener) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	emit(event) { for (const listener of this.#listeners) listener(event); }
}
captureTranscriptSubscriptions(Session.prototype);

function answer(text) {
	return { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function uiHost() {
	const widgets = new Map();
	let renders = 0;
	const tui = {
		requestRender() { renders += 1; },
		requestComponentRender() { renders += 1; },
		resetDisplay() {},
	};
	const theme = { fg: (_color, text) => text };
	return {
		widgets,
		tui,
		theme,
		get renders() { return renders; },
		ui: {
			setWidget(key, content, options) {
				const previous = widgets.get(key);
				previous?.component?.dispose?.();
				if (content === undefined) {
					widgets.delete(key);
					return;
				}
				const component = typeof content === "function" ? content(tui, theme) : null;
				widgets.set(key, { content, options, component });
			},
			setWorkingMessage() {},
		},
		renderActive(width = 80) {
			const entry = widgets.get(ACTIVE_TOOLS_WIDGET_KEY);
			return entry?.component ? entry.component.render(width) : [];
		},
	};
}

class FakeToolCard {
	static instances = [];
	constructor(toolName, args, _options, _def, ui, _cwd, toolCallId) {
		this.toolName = toolName;
		this.args = args;
		this.ui = ui;
		this.toolCallId = toolCallId;
		this.allocations = [];
		this.updates = [];
		this.sealed = false;
		this.disposed = false;
		FakeToolCard.instances.push(this);
	}
	setArgsComplete() {}
	setExecutionStarted() {}
	setTranscriptAllocation(rows, frame) { this.allocations.push({ rows, frame }); }
	updateResult(result, isPartial) {
		this.updates.push({ result, isPartial });
		this.ui.requestRender();
	}
	render(width) {
		const detail = this.updates.at(-1)?.result?.content?.[0]?.text ?? "running";
		const line = `⠋ ${this.toolName} · ${detail}`;
		return [line.slice(0, width)];
	}
	seal() { this.sealed = true; }
	dispose() { this.disposed = true; }
}

afterEach(() => {
	registerToolCardComponent(null);
	FakeToolCard.instances.length = 0;
});

test("an active tool tray requests render on its own clock and stops after disposal", async () => {
	const root = new Session();
	const child = new Session();
	const host = uiHost();
	const display = childDisplayFor(root, host.ui);
	display.attach("Ls", child);
	child.emit({ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "ls" } });
	const before = host.renders;
	await Bun.sleep(300);
	expect(host.renders).toBeGreaterThan(before);
	const running = host.renders;
	child.emit({ type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash", result: { content: [] }, isError: false });
	await Bun.sleep(300);
	expect(host.renders).toBe(running);
	child.emit({ type: "tool_execution_start", toolCallId: "bash-2", toolName: "bash", args: { command: "pwd" } });
	await Bun.sleep(300);
	expect(host.renders).toBeGreaterThan(running);
	child.emit({ type: "tool_execution_end", toolCallId: "bash-2", toolName: "bash", result: { content: [] }, isError: false });
});

test("unsettled root and child tools stay in the one-row active area and never leave open transcript cards", () => {
	registerToolCardComponent(FakeToolCard);
	const root = new Session();
	const child = new Session();
	const grandchild = new Session();
	const host = uiHost();
	const seen = [];
	root.subscribe((event) => seen.push(event));

	const display = childDisplayFor(root, host.ui);
	const detachChild = display.attach("Oh My Pie", child);
	const detachGrand = display.attach("Sub Sub Scope", grandchild);

	const originalAssistant = {
		role: "assistant",
		content: [
			{ type: "text", text: "Waiting on child." },
			{ type: "toolCall", id: "join-1", name: "scope_join", arguments: {} },
		],
	};
	root.emit({ type: "message_start", message: originalAssistant });
	root.emit({ type: "message_end", message: originalAssistant });
	expect(originalAssistant.content).toHaveLength(2);
	const rootAssistantShown = seen.find((event) => event.type === "message_end" && event.message?.role === "assistant");
	expect(rootAssistantShown.message.content).toEqual([{ type: "text", text: "Waiting on child." }]);

	root.emit({ type: "tool_execution_start", toolCallId: "join-1", toolName: "scope_join", args: {} });
	child.emit({ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "sleep 10" } });
	grandchild.emit({ type: "tool_execution_start", toolCallId: "ret-1", toolName: "scope_return", args: {} });
	expect(seen.some((event) => event.type.startsWith("tool_execution_"))).toBe(false);
	expect(display.activeTools).toBe(3);

	const initialRows = host.renderActive(80);
	expect(initialRows).toEqual([
		" ⠋ scope_join · running",
		" Oh My Pie ⠋ bash · running",
		" Sub Sub Scope ⠋ scope_return · running",
	]);
	expect(FakeToolCard.instances.every((card) => card.allocations.at(-1)?.rows === 1)).toBe(true);
	expect(FakeToolCard.instances[0].allocations.at(-1).frame.now).toBeLessThan(1e12);

	const rendersBefore = host.renders;
	child.emit({
		type: "tool_execution_update",
		toolCallId: "bash-1",
		toolName: "bash",
		partialResult: { content: [{ type: "text", text: "step 2/5" }] },
	});
	expect(host.renders).toBeGreaterThan(rendersBefore);
	expect(host.renderActive(80)[1]).toBe(" Oh My Pie ⠋ bash · step 2/5");

	grandchild.emit(answer("Grandchild done"));
	child.emit({
		type: "tool_execution_end",
		toolCallId: "bash-1",
		toolName: "bash",
		args: { command: "sleep 10" },
		result: { content: [{ type: "text", text: "ok" }] },
		isError: false,
	});
	expect(display.activeTools).toBe(2);
	const bashCard = FakeToolCard.instances.find((card) => card.toolCallId === "bash-1");
	expect(bashCard.sealed).toBe(true);
	expect(bashCard.disposed).toBe(true);

	const header = seen.find((event) => event.message?.customType === CHILD_ACTIVITY_TYPE);
	expect(header.message.details.label).toBe("Sub Sub Scope");
	const grandEnd = seen.find(
		(event) => event.type === "message_end" && event.message?.role === "assistant" && event.message.model === "Sub Sub Scope",
	);
	expect(grandEnd.message.content).toEqual([{ type: "text", text: "Grandchild done" }]);
	expect(seen.at(-1)).toMatchObject({ type: "tool_execution_end", toolName: "bash", args: { command: "sleep 10" } });

	detachGrand();
	expect(display.activeTools).toBe(1);

	root.emit({
		type: "tool_execution_end",
		toolCallId: "join-1",
		toolName: "scope_join",
		result: { content: [{ type: "text", text: "joined" }] },
		isError: false,
	});
	expect(display.activeTools).toBe(0);
	expect(host.widgets.has(ACTIVE_TOOLS_WIDGET_KEY)).toBe(false);
	expect(seen.at(-1)).toMatchObject({ type: "tool_execution_end", toolName: "scope_join" });

	detachChild();
});

test("child thinking streams on the native assistant channel with a settled label header and zero usage", () => {
	const root = new Session();
	const child = new Session();
	const seen = [];
	root.subscribe((event) => seen.push(event));
	childDisplayFor(root).attach("Worker", child);

	child.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	// Cumulative snapshot + delta arriving together (omp 19.2 wire shape) must
	// never double-append the delta on top of the cumulative snapshot.
	child.emit({
		type: "message_update",
		message: { role: "assistant", content: [{ type: "thinking", thinking: "先看源码" }] },
		assistantMessageEvent: {
			type: "thinking_delta",
			contentIndex: 0,
			delta: "源码",
			partial: { role: "assistant", content: [{ type: "thinking", thinking: "先看源码" }] },
		},
	});
	child.emit({
		type: "message_update",
		message: { role: "assistant", content: [{ type: "thinking", thinking: "先看源码再改" }] },
		assistantMessageEvent: {
			type: "thinking_delta",
			contentIndex: 0,
			delta: "再改",
			partial: { role: "assistant", content: [{ type: "thinking", thinking: "先看源码再改" }] },
		},
	});
	child.emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "先看源码再改" },
				{ type: "text", text: "已完成分析。" },
			],
		},
	});

	expect(seen.map((event) => [event.type, event.message?.role, event.message?.customType ?? null])).toEqual([
		["message_start", "custom", CHILD_ACTIVITY_TYPE],
		["message_start", "assistant", null],
		["message_update", "assistant", null],
		["message_update", "assistant", null],
		["message_end", "assistant", null],
	]);
	expect(seen[0].message.details.label).toBe("Worker");
	expect(seen[2].message.content).toEqual([{ type: "thinking", thinking: "先看源码" }]);
	expect(seen[2].assistantMessageEvent).toMatchObject({ type: "thinking_delta", delta: "先看源码" });
	expect(seen[3].message.content).toEqual([{ type: "thinking", thinking: "先看源码再改" }]);
	expect(seen[3].assistantMessageEvent).toMatchObject({ type: "thinking_delta", delta: "再改" });
	expect(seen[4].message.content).toEqual([
		{ type: "thinking", thinking: "先看源码再改" },
		{ type: "text", text: "已完成分析。" },
	]);
	expect(seen[4].message.usage.input).toBe(0);
	expect(seen[4].message.usage.output).toBe(0);
	expect(seen[4].message.stopReason).toBe("stop");
});

test("pure RPC delta frames append across a start shell and end block is authoritative", () => {
	const root = new Session();
	const child = new Session();
	const seen = [];
	root.subscribe((event) => seen.push(event));
	childDisplayFor(root).attach("Child", child);
	const shell = { role: "assistant", content: [] };
	child.emit({ type: "message_start", message: shell });
	child.emit({
		type: "message_update",
		message: shell,
		assistantMessageEvent: { type: "start", partial: shell },
	});
	child.emit({
		type: "message_update",
		message: { role: "assistant", content: [] },
		assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "先", partial: { role: "assistant", content: [] } },
	});
	child.emit({
		type: "message_update",
		message: { role: "assistant", content: [] },
		assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "思考", partial: { role: "assistant", content: [] } },
	});
	child.emit({
		type: "message_update",
		message: { role: "assistant", content: [] },
		assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "先思考完整", partial: { role: "assistant", content: [] } },
	});
	child.emit({ type: "message_end", message: { role: "assistant", content: [] } });

	const updates = seen.filter((event) => event.type === "message_update");
	expect(updates.map((event) => event.message.content)).toEqual([
		[{ type: "thinking", thinking: "先" }],
		[{ type: "thinking", thinking: "先思考" }],
		[{ type: "thinking", thinking: "先思考完整" }],
	]);
	// Empty message_end preserves accumulated thinking instead of wiping it.
	const end = seen.find((event) => event.type === "message_end");
	expect(end.message.content).toEqual([{ type: "thinking", thinking: "先思考完整" }]);
});

test("concurrent child streams hand off the live assistant lease seamlessly when the owner ends", () => {
	const root = new Session();
	const first = new Session();
	const second = new Session();
	const seen = [];
	root.subscribe((event) => seen.push(event));
	const display = childDisplayFor(root);
	display.attach("First", first);
	display.attach("Second", second);

	first.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	first.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "first step 1" }] } });

	// Second starts streaming while First still owns the live assistant slot.
	second.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	second.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "second draft" }] } });

	// While First is live, Second's updates are buffered rather than overwriting First.
	expect(seen.some((event) => JSON.stringify(event).includes("second draft"))).toBe(false);

	// The moment First finishes, Second is promoted into the live assistant slot
	// immediately with its accumulated thinking, and continues streaming live.
	first.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "first complete" }] } });
	expect(seen.some((event) => event.type === "message_update" && event.message?.model === "Second"
		&& event.message.content[0]?.thinking === "second draft")).toBe(true);

	second.emit({
		type: "message_update",
		message: { role: "assistant", content: [{ type: "thinking", thinking: "second draft continued" }] },
	});
	const latestSecond = seen.filter((event) => event.type === "message_update" && event.message?.model === "Second").at(-1);
	expect(latestSecond.message.content).toEqual([{ type: "thinking", thinking: "second draft continued" }]);

	second.emit({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "thinking", thinking: "second final" }] },
	});
	expect(seen.at(-1)).toMatchObject({
		type: "message_end",
		message: { role: "assistant", model: "Second", content: [{ type: "thinking", thinking: "second final" }] },
	});
});

test("todo tool events no longer become checklist cards, while the root toolResult still reaches listeners for the host TodoHud", () => {
	const root = new Session();
	const child = new Session();
	const seen = [];
	root.subscribe((event) => seen.push(event));
	const display = childDisplayFor(root);
	display.attach("Worker", child);

	const phases = [
		{ name: "诊断", tasks: [{ content: "定位根因", status: "in_progress" }, { content: "已完项", status: "completed" }] },
	];
	root.emit({ type: "tool_execution_start", toolCallId: "todo-1", toolName: "todo", args: { op: "init" } });
	root.emit({
		type: "tool_execution_end",
		toolCallId: "todo-1",
		toolName: "todo",
		args: { op: "init" },
		result: { content: [{ type: "text", text: "ok" }], details: { op: "init", phases } },
		isError: false,
	});
	// Root's persisted toolResult message_end still passes through so host TodoHud refreshes.
	root.emit({
		type: "message_end",
		message: { role: "toolResult", toolCallId: "todo-1", toolName: "todo", isError: false, details: { op: "init", phases } },
	});

	child.emit({ type: "tool_execution_start", toolCallId: "todo-2", toolName: "todo", args: { op: "init" } });
	child.emit({
		type: "tool_execution_end",
		toolCallId: "todo-2",
		toolName: "todo",
		args: { op: "init" },
		result: { content: [{ type: "text", text: "ok" }], details: { op: "init", phases } },
		isError: false,
	});

	// `todo` is not a bound capability any more, so the display never turns a
	// todo event into a checklist card. Raw tool events still pass through to
	// the host, which is the host's own business.
	const todoCards = seen.filter((event) => event.message?.customType === CHILD_ACTIVITY_TYPE && event.message.details?.todo);
	expect(todoCards).toHaveLength(0);
	// Root's toolResult message_end still reaches listeners for dock TodoHud sync.
	expect(seen.some((event) => event.type === "message_end" && event.message?.role === "toolResult" && event.message.toolName === "todo")).toBe(true);
});

test("the native working row follows the latest requester and omits Root", () => {
	const ledger = createBracketLedger();
	registerFork(ledger, { forkId: "opaque|id", ownerId: "root", path: "/oh-my-pie", fsm: "parent", depth: 0 });
	registerFork(ledger, { forkId: "nested|id", ownerId: "opaque|id", upscopePath: "/oh-my-pie", path: "/oh-my-pie/sub_sub_scope", fsm: "child", depth: 1 });
	registerFork(ledger, { forkId: "plan", ownerId: "root", path: "/plan", fsm: "deferred", depth: 0 });
	markReady(ledger, "plan");
	const root = new Session();
	root.isStreaming = true;
	let label;
	const display = childDisplayFor(root, { setWorkingMessage: (value) => { label = value; } });
	bindScopeView(createScopes({ forkWiring: { ledger } }));
	display.request(ledger, "root");
	expect(label()).toBe("[Busy: 3, Idle: 1]");
	display.rootWait(1);
	display.request(ledger, "nested|id");
	expect(label()).toBe("[Busy: 2, Idle: 2] /oh-my-pie > /oh-my-pie/sub_sub_scope");
	markReady(ledger, "nested|id");
	expect(label()).toBe("[Busy: 1, Idle: 3] /oh-my-pie > /oh-my-pie/sub_sub_scope");
  	display.rootWait(-1);
  	display.request(ledger, null);
  	expect(label()).toBe("[Busy: 2, Idle: 2]");
  	bindScopeView(null);
  });

  test("the working row shows Goal: ON while the root goal session is active", () => {
  	const ledger = createBracketLedger();
  	registerFork(ledger, { forkId: "opaque|id", ownerId: "root", path: "/oh-my-pie", fsm: "parent", depth: 0 });
  	registerFork(ledger, { forkId: "plan", ownerId: "root", path: "/plan", fsm: "deferred", depth: 0 });
  	markReady(ledger, "plan");
  	const root = new Session();
  	root.isStreaming = true;
  	let label;
  	let goal = false;
  	const display = childDisplayFor(root, { setWorkingMessage: (value) => { label = value; } }, { goalOf: () => goal });
  	bindScopeView(createScopes({ forkWiring: { ledger } }));
  	display.request(ledger, "root");
  	expect(label()).toBe("[Busy: 2, Idle: 1]");
  	goal = true;
  	expect(label()).toBe("[Busy: 2, Idle: 1, Goal: ON]");
  	goal = false;
  	expect(label()).toBe("[Busy: 2, Idle: 1]");
  	bindScopeView(null);
  });

test("renderChildActivity builds a one-line scope header", () => {
	const tui = {
		jsx(kind, props = {}) {
			return { kind, props: () => props, children: () => props.children ?? [] };
		},
	};
	const header = renderChildActivity({ details: { label: "Oh My Pie" } }, {}, {}, tui);
	expect(header.kind).toBe("text");
	expect(header.props().spans).toEqual([{ t: "Oh My Pie", s: "accent" }]);
});

test("a late child cannot write into the replacement root conversation", () => {
	const root = new Session();
	const child = new Session();
	let sessionId = "original";
	root.sessionManager = { getSessionId: () => sessionId };
	const seen = [];
	root.subscribe((event) => seen.push(event));
	childDisplayFor(root).attach("old", child);
	sessionId = "replacement";
	child.emit(answer("late output"));
	childDisplayFor(root).attach("new", child);
	child.emit(answer("current output"));
	const headers = seen.filter((event) => event.message?.customType === CHILD_ACTIVITY_TYPE);
	const ends = seen.filter((event) => event.type === "message_end" && event.message?.role === "assistant");
	expect(headers.map((event) => event.message.details.label)).toEqual(["new"]);
	expect(ends.map((event) => event.message.content)).toEqual([[{ type: "text", text: "current output" }]]);
});

function approvalRunner() {
	let installed = null;
	const events = [];
	return {
		events,
		get installed() { return installed; },
		setToolApprovalPreviewWaiter(waiter) {
			installed = waiter;
			events.push({ kind: "install", waiter });
			return () => {
				const matched = installed === waiter;
				if (matched) installed = null;
				events.push({ kind: "detach", matched, installed });
			};
		},
	};
}

test("approval preview suppression lives for exactly one display lease", () => {
	const root = new Session();
	root.sessionManager = { getSessionId: () => "one" };
	const runner = approvalRunner();
	root.extensionRunner = runner;
	root.subscribe(() => {});

	const display = childDisplayFor(root);
	expect(runner.events).toHaveLength(1);
	expect(runner.events[0].kind).toBe("install");
	expect(typeof runner.installed).toBe("function");

	expect(childDisplayFor(root)).toBe(display);
	expect(runner.events).toHaveLength(1);

	root.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
	root.emit({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: {} });
	expect(runner.events).toHaveLength(1);

	root.sessionManager = { getSessionId: () => "two" };
	childDisplayFor(root);
	expect(runner.events.map((event) => event.kind)).toEqual(["install", "detach", "install"]);
	expect(runner.events[1].matched).toBe(true);
	expect(runner.events[1].installed).toBeNull();
	expect(runner.events[2].waiter).toBe(runner.events[0].waiter);
});

test("releasing the plugin suppression never resurrects an earlier host waiter", () => {
	const root = new Session();
	root.sessionManager = { getSessionId: () => "one" };
	const runner = approvalRunner();
	const hostWaiter = () => Promise.resolve("host preview");
	runner.setToolApprovalPreviewWaiter(hostWaiter);
	root.extensionRunner = runner;

	childDisplayFor(root);
	expect(runner.events).toHaveLength(2);
	expect(runner.installed).not.toBe(hostWaiter);

	root.sessionManager = { getSessionId: () => "two" };
	childDisplayFor(root);
	const detach = runner.events.find((event) => event.kind === "detach");
	expect(detach).toMatchObject({ matched: true, installed: null });
	expect(runner.installed).not.toBe(hostWaiter);
	expect(runner.events.at(-1).kind).toBe("install");
});
