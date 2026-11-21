import { afterEach, expect, test } from "bun:test";
import {
	ACTIVE_TOOLS_WIDGET_KEY,
	CHILD_ACTIVITY_TYPE,
	captureTranscriptSubscriptions,
	childDisplayFor,
	registerToolCardComponent,
	renderChildActivity,
} from "../src/host/child-display.mjs";
import { createBracketLedger, markReady, registerFork } from "../src/scope/forkjoin.mjs";

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

	// Root assistant message carries a scope_join toolCall: the display copy
	// strips toolCall blocks so the host never creates an unfinalized card,
	// while the session's original message object stays untouched.
	const originalAssistant = {
		role: "assistant",
		content: [
			{ type: "text", text: "Waiting on child." },
			{ type: "toolCall", id: "join-1", name: "scope_join", arguments: { elder_report: null } },
		],
	};
	root.emit({ type: "message_start", message: originalAssistant });
	root.emit({ type: "message_end", message: originalAssistant });
	expect(originalAssistant.content).toHaveLength(2);
	const rootAssistantShown = seen.find((event) => event.type === "message_end" && event.message?.role === "assistant");
	expect(rootAssistantShown.message.content).toEqual([{ type: "text", text: "Waiting on child." }]);

	// Root join, child join, child slow bash, grandchild return all stay active
	// simultaneously without emitting raw tool_execution_start into the transcript.
	root.emit({ type: "tool_execution_start", toolCallId: "join-1", toolName: "scope_join", args: { elder_report: null } });
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
	// ToolExecutionComponent measures elapsed time with performance.now(), not Date.now().
	expect(FakeToolCard.instances[0].allocations.at(-1).frame.now).toBeLessThan(1e12);

	// Live partial updates refresh the single-row card in place without adding rows.
	const rendersBefore = host.renders;
	child.emit({
		type: "tool_execution_update",
		toolCallId: "bash-1",
		toolName: "bash",
		partialResult: { content: [{ type: "text", text: "step 2/5" }] },
	});
	expect(host.renders).toBeGreaterThan(rendersBefore);
	expect(host.renderActive(80)[1]).toBe(" Oh My Pie ⠋ bash · step 2/5");

	// Completed child work and completed tools append into the main transcript
	// at full size while the root join is still running.
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

	const completedRows = seen.filter((event) => event.message?.customType === CHILD_ACTIVITY_TYPE);
	expect(completedRows.map((event) => event.message.details.tool?.toolName ?? event.message.details.body)).toEqual([
		"Grandchild done",
		"bash",
	]);

	// Detaching grandchild clears its unsettled return from the active area.
	detachGrand();
	expect(display.activeTools).toBe(1);

	// Finishing root join removes the widget completely and appends the full card.
	root.emit({
		type: "tool_execution_end",
		toolCallId: "join-1",
		toolName: "scope_join",
		result: { content: [{ type: "text", text: "joined" }] },
		isError: false,
	});
	expect(display.activeTools).toBe(0);
	expect(host.widgets.has(ACTIVE_TOOLS_WIDGET_KEY)).toBe(false);
	const rootJoinRow = seen.at(-1);
	expect(rootJoinRow.message.customType).toBe(CHILD_ACTIVITY_TYPE);
	expect(rootJoinRow.message.details.label).toBeNull();
	expect(rootJoinRow.message.details.tool.toolName).toBe("scope_join");

	detachChild();
});

test.each(["root", "child"])("%s takes the free stream slot and the other stream falls back to one block", (first) => {
	const root = new Session();
	const child = new Session();
	const seen = [];
	root.subscribe((event) => seen.push([event.type, event.message?.role, event.message?.content]));
	childDisplayFor(root).attach("Child", child);
	const a = first === "root" ? root : child;
	const b = a === root ? child : root;
	const aText = answer("first partial").message;
	const bText = answer("second partial").message;
	a.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	a.emit({ type: "message_update", message: aText });
	b.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	b.emit({ type: "message_update", message: bText });
	b.emit(answer("second complete"));
	expect(JSON.stringify(seen)).toContain("first partial");
	expect(JSON.stringify(seen)).not.toContain("second");
	a.emit(answer("first complete"));
	const output = JSON.stringify(seen);
	expect(output).not.toContain("second partial");
	expect(output.indexOf("first complete")).toBeLessThan(output.indexOf("second complete"));
	if (b === root) {
		expect(seen.slice(-2).map(([type]) => type)).toEqual(["message_start", "message_end"]);
	} else {
		expect(seen.at(-1)).toEqual(["message_start", "custom", "Child\nsecond complete"]);
	}
});

test("the native working row follows the latest requester and omits Root", () => {
	const ledger = createBracketLedger();
	registerFork(ledger, { forkId: "opaque|id", ownerId: "root", scopeId: "oh-my-pie", intent: "parent", depth: 0 });
	registerFork(ledger, { forkId: "nested|id", ownerId: "opaque|id", scopeId: "sub_sub_scope", intent: "child", depth: 1 });
	registerFork(ledger, { forkId: "plan", ownerId: "root", scopeId: "plan", intent: "deferred", depth: 0, blocked: true });
	const root = new Session();
	root.isStreaming = true;
	let label;
	const display = childDisplayFor(root, { setWorkingMessage: (value) => { label = value; } });
	display.request(ledger, "root");
	expect(label()).toBe("[Busy: 3, Idle: 0]");
	display.rootWait(1);
	display.request(ledger, "nested|id");
	expect(label()).toBe("[Busy: 2, Idle: 1] Oh My Pie > Sub Sub Scope");
	markReady(ledger, "nested|id");
	expect(label()).toBe("[Busy: 1, Idle: 2] Oh My Pie > Sub Sub Scope");
	display.rootWait(-1);
	display.request(ledger, null);
	expect(label()).toBe("[Busy: 2, Idle: 1]");
});

test("child thinking streams with host thinkingText italic style and stays distinct from prose", () => {
	const root = new Session();
	const child = new Session();
	const seen = [];
	root.subscribe((event) => seen.push(event));
	childDisplayFor(root).attach("Oh My Pie", child);

	const created = [];
	class FakeContainer {
		children = [];
		addChild(childComponent) { this.children.push(childComponent); }
		clear() { this.children.length = 0; }
	}
	class FakeText {
		constructor(text) { this.text = text; }
	}
	class FakeSpacer {
		constructor(lines) { this.lines = lines; }
	}
	class FakeMarkdown {
		constructor(text, _px, _py, _mdTheme, style) {
			this.text = text;
			this.style = style ?? null;
			created.push(this);
		}
		setText(text) { this.text = text; }
	}
	const theme = { fg: (color, text) => `<${color}>${text}</${color}>` };
	const ui = {
		Container: FakeContainer,
		Markdown: FakeMarkdown,
		Spacer: FakeSpacer,
		Text: FakeText,
		getMarkdownTheme: () => ({}),
	};

	child.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	child.emit({
		type: "message_update",
		message: { role: "assistant", content: [{ type: "thinking", thinking: "checking frontier" }] },
	});
	const rowMessage = seen[0].message;
	const frame = renderChildActivity(ui, rowMessage, { expanded: false }, theme);
	expect(frame.children[0].text).toBe("<muted>Oh My Pie</muted>");
	expect(created).toHaveLength(1);
	expect(created[0].text).toBe("checking frontier");
	expect(created[0].style?.italic).toBe(true);
	expect(created[0].style?.color("dimmed")).toBe("<thinkingText>dimmed</thinkingText>");

	// Thinking grows and prose starts in the same message: thinking updates in
	// place with its style intact, prose appends as a separate normal block.
	child.emit({
		type: "message_update",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "checking frontier done" },
				{ type: "text", text: "Final answer." },
			],
		},
	});
	expect(created).toHaveLength(2);
	expect(created[0].text).toBe("checking frontier done");
	expect(created[1].text).toBe("Final answer.");
	expect(created[1].style).toBeNull();
	child.emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "checking frontier done" },
				{ type: "text", text: "Final answer." },
			],
		},
	});
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
	expect(seen.map(({ message }) => message.content)).toEqual(["new\ncurrent output"]);
});
