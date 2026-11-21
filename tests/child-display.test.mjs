import { expect, test } from "bun:test";
import { captureTranscriptSubscriptions, childDisplayFor, CHILD_ACTIVITY_TYPE } from "../src/host/child-display.mjs";
import { createBracketLedger, registerFork, markReady } from "../src/scope/forkjoin.mjs";

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

test("arbitrarily nested activity interleaves as flat custom rows without borrowing the root stream slot", () => {
	const root = new Session();
	const child = new Session();
	const grandchild = new Session();
	const greatGrandchild = new Session();
	const seen = [];
	root.subscribe((event) => seen.push(event));
	const display = childDisplayFor(root);
	const detach = display.attach("c1", child);
	display.attach("c2", grandchild);
	display.attach("c3", greatGrandchild);
	const start = { type: "agent_start" };
	const rootTool = { type: "tool_execution_start", toolCallId: "same-id", toolName: "scope_join" };
	const end = { type: "agent_end" };
	root.emit(start);
	child.emit({ type: "agent_start" });
	child.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	child.emit(answer("first answer"));
	grandchild.emit({ type: "tool_execution_start", toolCallId: "same-id", toolName: "read" });
	root.emit(rootTool);
	greatGrandchild.emit(answer("first answer"));
	child.emit(answer("second answer"));
	grandchild.emit({ type: "tool_execution_end", toolCallId: "same-id", toolName: "read", result: { content: [{ type: "text", text: "read output" }] } });
	child.emit({ type: "notice", level: "error", message: "do not show" });
	child.emit({ type: "agent_end" });
	detach();
	child.emit(answer("detached"));
	root.emit(end);
	const rows = seen.filter((event) => event.message?.customType === CHILD_ACTIVITY_TYPE);
	expect(seen.filter((event) => !rows.includes(event))).toEqual([start, rootTool, end]);
	expect(seen[3]).toBe(rootTool);
	expect(rows.map(({ message }) => message.content)).toEqual([
		"c1\nfirst answer", "c2\nread · started", "c3\nfirst answer", "c1\nsecond answer", "c2\nread · completed\nread output",
	]);
	expect(rows.every(({ message }) => message.role === "custom" && message.excludeFromContext)).toBe(true);
	expect(new Set(rows.map(({ message }) => message.timestamp)).size).toBe(5);
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
