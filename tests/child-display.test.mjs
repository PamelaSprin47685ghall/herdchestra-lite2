import { afterEach, expect, test } from "bun:test";
import {
	ACTIVE_TOOLS_WIDGET_KEY,
	CHILD_ACTIVITY_TYPE,
	bindScopeView,
	captureTranscriptSubscriptions,
	childDisplayFor,
	renderChildActivity,
} from "../host-omp/src/host/child-display.mjs";
import { renderActiveToolTray } from "../host-omp/src/host/activity-render.mjs";
import { createBracketLedger, markReady, registerFork } from "../src/scope/forkjoin.mjs";
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

function fakeTui() {
	function signal(initial) {
		let value = initial;
		const observers = new Set();
		const read = () => value;
		read.set = (next) => { value = next; for (const observer of observers) observer(); };
		read.peek = () => value;
		read.subscribe = (observer) => { observers.add(observer); return () => observers.delete(observer); };
		return read;
	}
	function jsx(kind, props = {}) {
		if (typeof kind === "function") return kind(props);
		return {
			kind,
			props: () => props,
			children: () => {
				const children = props.children;
				if (typeof children === "function") return normalize(children());
				return normalize(children);
			},
		};
	}
	const normalize = (value) => value === undefined || value === null ? [] : Array.isArray(value) ? value.flatMap(normalize) : [value];
	const batch = (run) => run();
	function For({ each, children }) {
		const cache = new Map();
		return jsx("col", {
			children: () => {
				const items = typeof each === "function" ? each() : each ?? [];
				const seen = new Set();
				const built = items.map((item) => {
					seen.add(item);
					let node = cache.get(item);
					if (!node) {
						node = children(item);
						cache.set(item, node);
					}
					return node;
				});
				for (const key of [...cache.keys()]) if (!seen.has(key)) cache.delete(key);
				return built;
			},
		});
	}
	return { jsx, signal, batch, For };
}

const tui = fakeTui();
const theme = {
	fg: (_tone, text) => text,
	style: (_tokens, text) => text,
	bold: (text) => text,
	italic: (text) => text,
	dim: (text) => text,
};

function prop(node, key) {
	const value = node?.props?.()[key];
	return typeof value === "function" ? value() : value;
}

function walk(node, out = []) {
	if (!node || typeof node !== "object") return out;
	if (typeof node.kind === "string") {
		out.push(node);
		for (const child of node.children?.() ?? []) walk(child, out);
	}
	return out;
}

function nodes(node, kind) {
	return walk(node).filter((candidate) => candidate.kind === kind);
}

function uiHost() {
	const widgets = new Map();
	const calls = [];
	let working = null;
	let renders = 0;
	const uiRuntime = {
		requestRender() { renders += 1; },
		requestComponentRender() { renders += 1; },
		size: () => ({ width: 100, height: 30 }),
		suspend: async (run) => run?.(),
		resetDisplay() {},
	};
	const ui = {
		setWidget(key, content, options) {
			calls.push({ key, content, options });
			if (content === undefined) widgets.delete(key);
			else widgets.set(key, { content, options });
		},
		setWorkingMessage(value) { working = value; },
	};
	return {
		ui,
		uiRuntime,
		theme,
		widgets,
		calls,
		get renders() { return renders; },
		get working() { return working; },
		renderWidget(key = ACTIVE_TOOLS_WIDGET_KEY) {
			const entry = widgets.get(key);
			if (!entry || typeof entry.content !== "function") return [];
			return walk(entry.content(uiRuntime, theme));
		},
	};
}

afterEach(() => bindScopeView(null));

test("a child stream writes one custom start and no custom message_end on any update", () => {
	const root = new Session();
	const child = new Session();
	const seen = [];
	root.subscribe((event) => seen.push(event));
	childDisplayFor(root, uiHost().ui, { tui }).attach("Oh My Pie", child);

	child.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	child.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "先" }] } });
	child.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "先查源码" }] } });
	child.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "先查源码，再定位根因" }, { type: "text", text: "已定位问题" }] } });
	child.emit(answer("已定位问题"));

	const starts = seen.filter((event) => event.type === "message_start" && event.message?.customType === CHILD_ACTIVITY_TYPE);
	expect(starts).toHaveLength(1);
	expect(seen.filter((event) => event.type === "message_end" && event.message?.role === "custom")).toHaveLength(0);
	const row = starts[0].message;
	expect(row.role).toBe("custom");
	expect(row.display).toBe(true);
	expect(row.excludeFromContext).toBe(true);
	expect(row.details.parts.at(-1)?.text).toBe("已定位问题");
});

test("19.2 renderer returns a borderless reactive node; thinking and prose grow in place", () => {
	const root = new Session();
	const child = new Session();
	const seen = [];
	root.subscribe((event) => seen.push(event));
	childDisplayFor(root, uiHost().ui, { tui }).attach("Oh My Pie", child);
	child.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	child.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "先" }] } });

	const row = seen.find((event) => event.message?.customType === CHILD_ACTIVITY_TYPE).message;
	const frame = renderChildActivity(row, { expanded: false }, theme, tui);
	expect(frame.kind).toBe("col");
	expect(walk(frame).some((node) => node.kind === "card")).toBe(false);
	const assistant = nodes(frame, "col").find((node) => prop(node, "role") === "omp.assistant");
	expect(assistant).toBeTruthy();

	const thinking = nodes(assistant, "section").find((node) => String(prop(node, "role")).startsWith("omp.thinking"));
	expect(thinking).toBeTruthy();
	const firstMd = nodes(thinking, "md")[0];
	expect(firstMd).toBeTruthy();
	expect(prop(firstMd, "text")).toBe("先");

	child.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "先查源码，再定位根因" }] } });
	expect(prop(firstMd, "text")).toBe("先查源码，再定位根因");
	expect(nodes(frame, "section").find((node) => String(prop(node, "role")).startsWith("omp.thinking"))).toBe(thinking);

	child.emit({ type: "message_update", message: { role: "assistant", content: [
		{ type: "thinking", thinking: "先查源码，再定位根因" },
		{ type: "text", text: "已定位问题" },
	] } });
	expect(nodes(frame, "md").map((node) => prop(node, "text"))).toEqual(["先查源码，再定位根因", "已定位问题"]);
	expect(prop(firstMd, "stream")).toBeUndefined();

	// Ctrl+O re-render receives the same message object and reads live state.
	const reopened = renderChildActivity(row, { expanded: true }, theme, tui);
	expect(nodes(reopened, "md").map((node) => prop(node, "text"))).toEqual(["先查源码，再定位根因", "已定位问题"]);

	child.emit(answer("已定位问题"));
	const finalMd = nodes(frame, "md");
	expect(finalMd.every((node) => prop(node, "stream") === undefined)).toBe(true);
});

test("a historical custom message without a store still renders as a valid node", () => {
	const message = {
		role: "custom",
		customType: CHILD_ACTIVITY_TYPE,
		content: "Old scope\nRecorded answer",
		details: { label: "Old scope", body: "Recorded answer", parts: [{ kind: "text", text: "Recorded answer" }] },
	};
	const frame = renderChildActivity(message, { expanded: false }, theme, tui);
	expect(frame.kind).toBe("col");
	expect(nodes(frame, "md").map((node) => prop(node, "text"))).toContain("Recorded answer");
	expect(walk(frame).some((node) => node.kind === "card")).toBe(false);
});

test("completed tools render as native inline tool nodes and react to expanded", () => {
	const root = new Session();
	const child = new Session();
	const seen = [];
	root.subscribe((event) => seen.push(event));
	childDisplayFor(root, uiHost().ui, { tui }).attach("Oh My Pie", child);
	child.emit({
		type: "tool_execution_end",
		toolCallId: "bash-1",
		toolName: "bash",
		args: { command: "sleep 1" },
		result: { content: [{ type: "text", text: "ok" }] },
		isError: false,
	});
	const row = seen.find((event) => event.message?.customType === CHILD_ACTIVITY_TYPE).message;
	const frame = renderChildActivity(row, { expanded: false }, theme, tui);
	const tool = nodes(frame, "tool")[0];
	expect(tool).toBeTruthy();
	expect(prop(tool, "frame")).toBe("inline");
	expect(prop(tool, "status")).toBe("done");
	expect(prop(tool, "name")).toBe("bash");
	expect(prop(tool, "collapsed")).toBe(true);
	expect(prop(tool, "meta")).toContain("Oh My Pie");

	const expanded = renderChildActivity(row, { expanded: true }, theme, tui);
	expect(prop(nodes(expanded, "tool")[0], "collapsed")).toBe(false);

	const failed = { ...row, details: { ...row.details, tool: { ...row.details.tool, isError: true } } };
	expect(prop(nodes(renderChildActivity(failed, { expanded: false }, theme, tui), "tool")[0], "status")).toBe("error");
});

test("active tool tray mounts once, updates in place, then unmounts", () => {
	const host = uiHost();
	const root = new Session();
	const child = new Session();
	root.subscribe(() => {});
	const display = childDisplayFor(root, host.ui, { tui });
	const detach = display.attach("Oh My Pie", child);

	child.emit({ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "sleep 10" } });
	child.emit({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "a.txt" } });
	const mounts = host.calls.filter((call) => call.content !== undefined);
	expect(mounts).toHaveLength(1);
	expect(mounts[0].key).toBe(ACTIVE_TOOLS_WIDGET_KEY);
	expect(mounts[0].options).toEqual({ placement: "aboveEditor" });
	expect(display.activeTools).toBe(2);

	child.emit({ type: "tool_execution_update", toolCallId: "bash-1", toolName: "bash", partialResult: { content: [{ type: "text", text: "step 2/5" }] } });
	expect(host.calls.filter((call) => call.content !== undefined)).toHaveLength(1);
	const rows = host.renderWidget();
	const toolNodes = rows.filter((node) => node.kind === "tool");
	expect(toolNodes.some((node) => prop(node, "status") === "running")).toBe(true);
	expect(toolNodes.map((node) => prop(node, "note"))).toContain("step 2/5");

	child.emit({ type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash", args: {}, result: { content: [] }, isError: false });
	child.emit({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", args: {}, result: { content: [] }, isError: false });
	expect(host.widgets.has(ACTIVE_TOOLS_WIDGET_KEY)).toBe(false);
	expect(host.calls.at(-1).content).toBeUndefined();
	detach();
});

test("a standalone tray factory exposed for direct host rendering is reactive", () => {
	const entries = [{ label: "Oh My Pie", toolCallId: "x", toolName: "bash", partialText: "running", status: "running" }];
	const widget = renderActiveToolTray(() => entries, tui);
	expect(widget.kind).toBe("col");
	expect(nodes(widget, "tool").length).toBe(1);
});

test("root tool calls never mutate the original assistant message", () => {
	const root = new Session();
	const seen = [];
	root.subscribe((event) => seen.push(event));
	childDisplayFor(root, uiHost().ui, { tui });
	const original = { role: "assistant", content: [
		{ type: "text", text: "Waiting." },
		{ type: "toolCall", id: "join-1", name: "scope_join", arguments: {} },
	] };
	root.emit({ type: "message_start", message: original });
	root.emit({ type: "message_end", message: original });
	expect(original.content).toHaveLength(2);
	expect(seen.find((event) => event.type === "message_end" && event.message?.role === "assistant").message.content).toEqual([
		{ type: "text", text: "Waiting." },
	]);
});

test.each(["root", "child"])("%s takes the free stream slot and the other stream queues", (first) => {
	const root = new Session();
	const child = new Session();
	const seen = [];
	root.subscribe((event) => seen.push(event));
	childDisplayFor(root, uiHost().ui, { tui }).attach("Child", child);
	const a = first === "root" ? root : child;
	const b = a === root ? child : root;
	a.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	a.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "first partial" }] } });
	b.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	b.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "second partial" }] } });
	b.emit(answer("second complete"));
	expect(JSON.stringify(seen)).toContain("first partial");
	expect(JSON.stringify(seen)).not.toContain("second");
	a.emit(answer("first complete"));
	expect(JSON.stringify(seen)).toContain("first complete");
	expect(JSON.stringify(seen)).toContain("second complete");
	expect(JSON.stringify(seen)).not.toContain("second partial");
});

test("the working row follows the latest requester and omits Root", () => {
	const ledger = createBracketLedger();
	registerFork(ledger, { forkId: "opaque|id", ownerId: "root", scopeId: "oh-my-pie", fsm: "parent", depth: 0 });
	registerFork(ledger, { forkId: "nested|id", ownerId: "opaque|id", scopeId: "sub_sub_scope", fsm: "child", depth: 1 });
	registerFork(ledger, { forkId: "plan", ownerId: "root", scopeId: "plan", fsm: "deferred", depth: 0 });
	markReady(ledger, "plan");
	const root = new Session();
	root.isStreaming = true;
	const host = uiHost();
	const display = childDisplayFor(root, host.ui, { tui });
	bindScopeView(createScopes({ forkWiring: { ledger } }));
	display.request(ledger, "root");
	expect(host.working()).toBe("[Busy: 3, Idle: 1]");
	display.rootWait(1);
	display.request(ledger, "nested|id");
	expect(host.working()).toBe("[Busy: 2, Idle: 2] Oh My Pie > Sub Sub Scope");
	markReady(ledger, "nested|id");
	expect(host.working()).toBe("[Busy: 1, Idle: 3] Oh My Pie > Sub Sub Scope");
	display.rootWait(-1);
	display.request(ledger, null);
	expect(host.working()).toBe("[Busy: 2, Idle: 2]");
});

test("a late child cannot write into the replacement root conversation", () => {
	const root = new Session();
	const child = new Session();
	let sessionId = "original";
	root.sessionManager = { getSessionId: () => sessionId };
	const seen = [];
	root.subscribe((event) => seen.push(event));
	childDisplayFor(root, uiHost().ui, { tui }).attach("old", child);
	sessionId = "replacement";
	child.emit(answer("late output"));
	childDisplayFor(root, uiHost().ui, { tui }).attach("new", child);
	child.emit(answer("current output"));
	expect(seen.map(({ message }) => message.content)).toEqual(["new\ncurrent output"]);
});

function approvalRunner() {
	let installed = null;
	const events = [];
	const stable = () => Promise.resolve();
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
	const display = childDisplayFor(root, uiHost().ui, { tui });
	expect(runner.events).toHaveLength(1);
	expect(typeof runner.installed).toBe("function");
	expect(childDisplayFor(root, uiHost().ui, { tui })).toBe(display);
	root.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
	root.emit({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: {} });
	expect(runner.events).toHaveLength(1);
	root.sessionManager = { getSessionId: () => "two" };
	childDisplayFor(root, uiHost().ui, { tui });
	expect(runner.events.map((event) => event.kind)).toEqual(["install", "detach", "install"]);
	expect(runner.events[1]).toMatchObject({ matched: true, installed: null });
	expect(runner.events[2].waiter).toBe(runner.events[0].waiter);
});

test("releasing the plugin suppression never resurrects an earlier host waiter", () => {
	const root = new Session();
	root.sessionManager = { getSessionId: () => "one" };
	const runner = approvalRunner();
	const hostWaiter = () => Promise.resolve("host preview");
	runner.setToolApprovalPreviewWaiter(hostWaiter);
	root.extensionRunner = runner;
	childDisplayFor(root, uiHost().ui, { tui });
	expect(runner.events).toHaveLength(2);
	expect(runner.installed).not.toBe(hostWaiter);
	root.sessionManager = { getSessionId: () => "two" };
	childDisplayFor(root, uiHost().ui, { tui });
	expect(runner.events.find((event) => event.kind === "detach")).toMatchObject({ matched: true, installed: null });
	expect(runner.installed).not.toBe(hostWaiter);
});
