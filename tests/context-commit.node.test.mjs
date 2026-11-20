import assert from "node:assert/strict";
import { test } from "node:test";

import * as contextModule from "../src/host/hack-context.mjs";
import { rememberSession } from "../src/host/capture.mjs";

const { appendHistoryMessage, commitSkillReceipt, hackContext } = contextModule;
let nextAgent = 0;

function user(text = "start") {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function skill(text = "clock: 1", timestamp = 2) {
	return {
		role: "developer",
		content: [{ type: "text", text }],
		timestamp,
		herdSkill: true,
	};
}

function harness(initial = [user()]) {
	const entries = initial.map((message, index) => ({ type: "message", id: `e${index}`, message }));
	const manager = {
		getBranch: () => entries.slice(),
		appendMessage(message) {
			const id = `e${entries.length}`;
			entries.push({ type: "message", id, message });
			return id;
		},
	};
	const id = `context-commit-${nextAgent++}`;
	const session = {
		agent: { state: { messages: initial.slice() } },
		sessionManager: manager,
		getAgentId: () => id,
	};
	rememberSession(session);
	const ctx = { agent: { id, kind: "main" }, sessionManager: manager, session };
	return { entries, manager, session, ctx };
}

function contextHook(handler, options) {
	let hook;
	hackContext({ on: (name, callback) => { assert.equal(name, "context"); hook = callback; } }, handler, options);
	return hook;
}

test("append permits an explicit journal-only replay", () => {
	const appended = [];
	const message = user();
	assert.equal(appendHistoryMessage({ appendMessage: (item) => appended.push(item) }, message), true);
	assert.deepEqual(appended, [message]);
});

test("append permits a host without a live transcript", () => {
	const fixture = harness([]);
	const message = user();
	assert.equal(appendHistoryMessage(fixture.manager, message, {}), true);
	assert.equal(fixture.entries[0].message, message);
});

test("append reports a live write failure instead of partial success", () => {
	const fixture = harness([]);
	fixture.session.agent.state.messages = new Proxy([], {
		set() { throw new Error("live write refused"); },
	});
	assert.equal(appendHistoryMessage(fixture.manager, skill(), fixture.ctx), false);
});

test("append detects a manager that silently drops its write", () => {
	const fixture = harness([]);
	fixture.manager.appendMessage = () => undefined;
	assert.equal(appendHistoryMessage(fixture.manager, skill()), false);
});

test("append does not change live history after a failed journal write", () => {
	const fixture = harness([]);
	fixture.manager.appendMessage = () => { throw new Error("journal write refused"); };
	assert.equal(appendHistoryMessage(fixture.manager, skill(), fixture.ctx), false);
	assert.deepEqual(fixture.session.agent.state.messages, []);
});

test("commit keeps journal, live history, and output on the same receipt", () => {
	const fixture = harness();
	const outgoing = commitSkillReceipt(fixture.manager, [...fixture.session.agent.state.messages, skill()], fixture.ctx);
	const committed = fixture.entries.at(-1).message;
	assert.equal(outgoing.at(-1), committed);
	assert.equal(fixture.session.agent.state.messages.at(-1), committed);
	assert.match(committed.herdSkillTurn, /^[a-f0-9]{64}$/);
	assert.notEqual(outgoing, fixture.session.agent.state.messages);
});

test("commit reuses the first clock text when context preparation repeats", () => {
	const fixture = harness();
	const base = fixture.session.agent.state.messages.slice();
	const first = commitSkillReceipt(fixture.manager, [...base, skill("clock: 1", 2)], fixture.ctx);
	const repeated = commitSkillReceipt(fixture.manager, [...base, skill("clock: 2", 3)], fixture.ctx);
	assert.equal(repeated.at(-1), first.at(-1));
	assert.equal(fixture.entries.length, 2);
	assert.deepEqual(repeated, first);
});

test("commit restores missing live receipt without adding another journal entry", () => {
	const fixture = harness();
	const base = fixture.session.agent.state.messages.slice();
	const first = commitSkillReceipt(fixture.manager, [...base, skill()], fixture.ctx);
	fixture.session.agent.state.messages.pop();
	const restored = commitSkillReceipt(fixture.manager, [...base, skill("clock: later", 9)], fixture.ctx);
	assert.equal(restored.at(-1), first.at(-1));
	assert.equal(fixture.session.agent.state.messages.at(-1), first.at(-1));
	assert.equal(fixture.entries.length, 2);
});

test("commit retries a failed live write using the already persisted receipt", () => {
	const fixture = harness();
	const base = fixture.session.agent.state.messages.slice();
	let blocked = true;
	fixture.session.agent.state.messages = new Proxy(base.slice(), {
		set(target, key, value) {
			if (blocked) throw new Error("live write refused");
			return Reflect.set(target, key, value);
		},
	});
	assert.throws(
		() => commitSkillReceipt(fixture.manager, [...base, skill()], fixture.ctx),
		(error) => error.code === "CONTEXT_SKILL_COMMIT_FAILED" && error.phase === "live history write",
	);
	assert.equal(fixture.entries.length, 2);
	const committed = fixture.entries.at(-1).message;
	blocked = false;
	const restored = commitSkillReceipt(fixture.manager, [...base, skill("clock: later", 9)], fixture.ctx);
	assert.equal(restored.at(-1), committed);
	assert.equal(fixture.entries.length, 2);
	assert.deepEqual(fixture.session.agent.state.messages, restored);
});

test("commit creates a new receipt after a real assistant and tool result", () => {
	const fixture = harness();
	const first = commitSkillReceipt(fixture.manager, [...fixture.session.agent.state.messages, skill()], fixture.ctx);
	const answer = { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }], timestamp: 3 };
	const result = { role: "toolResult", toolCallId: "read-1", content: [{ type: "text", text: "result" }], timestamp: 4 };
	for (const message of [answer, result]) {
		fixture.manager.appendMessage(message);
		fixture.session.agent.state.messages.push(message);
	}
	const next = commitSkillReceipt(fixture.manager, [...fixture.session.agent.state.messages, skill("clock: 2", 5)], fixture.ctx);
	assert.equal(next[1], first[1]);
	assert.notEqual(next.at(-1).herdSkillTurn, first.at(-1).herdSkillTurn);
	assert.equal(fixture.entries.filter((entry) => entry.message.herdSkill).length, 2);
});

test("commit preserves a receipt already carried by a transformed projection", () => {
	const fixture = harness();
	const first = commitSkillReceipt(fixture.manager, [...fixture.session.agent.state.messages, skill()], fixture.ctx);
	const prefix = { role: "custom", customType: "scope.begin", content: "projected boundary" };
	const projected = commitSkillReceipt(fixture.manager, [prefix, ...first], fixture.ctx);
	assert.equal(projected.at(-1), first.at(-1));
	assert.equal(fixture.entries.length, 2);
});

test("legacy hook repairs an old persisted receipt missing from live history", () => {
	const old = skill("old committed clock", 2);
	const fixture = harness([user(), old]);
	fixture.session.agent.state.messages.pop();
	const hook = contextHook((event) => ({ messages: [...event.messages, skill("new clock", 99)] }));
	const result = hook({ messages: fixture.session.agent.state.messages.slice() }, fixture.ctx);
	assert.equal(result.messages.at(-1), old);
	assert.equal(fixture.session.agent.state.messages.at(-1), old);
	assert.equal(fixture.entries.length, 2);
});

test("legacy hook commits an asynchronous context handler result", async () => {
	const fixture = harness();
	const hook = contextHook(async (event) => ({ messages: [...event.messages, skill()] }));
	const result = await hook({ messages: fixture.session.agent.state.messages.slice() }, fixture.ctx);
	assert.equal(fixture.entries.length, 2);
	assert.equal(fixture.entries.at(-1).message, result.messages.at(-1));
	assert.equal(fixture.session.agent.state.messages.at(-1), result.messages.at(-1));
});

test("legacy hook does not fall back to the owner after flow routing fails", () => {
	const fixture = harness();
	const hook = contextHook(
		(event) => ({ messages: [...event.messages, skill()] }),
		{ managerFor: () => { throw new Error("flow is no longer bound"); } },
	);
	assert.throws(
		() => hook({ messages: fixture.session.agent.state.messages.slice() }, fixture.ctx),
		(error) => error.code === "CONTEXT_SKILL_COMMIT_FAILED" && error.phase === "session lookup",
	);
	assert.equal(fixture.entries.length, 1);
});

test("legacy hook returns a non-skill result unchanged", () => {
	const result = { messages: [user()] };
	const hook = contextHook(() => result);
	assert.equal(hook({}, {}), result);
});
