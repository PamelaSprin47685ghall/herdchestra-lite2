import assert from "node:assert/strict";
import { test } from "node:test";

import { appendHistoryMessage, commitSkillReceipt } from "../host-omp/src/host/hack-context.mjs";
import { rememberSession } from "../host-omp/src/host/capture.mjs";

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

test("commit repairs a legacy receipt missing from live history", () => {
	const old = skill("old committed clock", 2);
	const fixture = harness([user(), old]);
	fixture.session.agent.state.messages.pop();
	const result = commitSkillReceipt(fixture.manager, [...fixture.session.agent.state.messages, skill("new clock", 99)], fixture.ctx);
	assert.equal(result.at(-1), old);
	assert.equal(fixture.session.agent.state.messages.at(-1), old);
	assert.equal(fixture.entries.length, 2);
});

function custom(text = "A queued context note") {
	return {
		role: "custom",
		customType: "queue-note",
		content: text,
		display: false,
		details: { __queueChipText: "preview" },
		timestamp: 10,
	};
}

function customEntry(message) {
	return {
		type: "custom_message",
		customType: message.customType,
		content: message.content,
		display: message.display,
		details: {},
		attribution: "agent",
		timestamp: new Date(message.timestamp).toISOString(),
	};
}

function useSemanticContext(fixture, messages) {
	const semantic = messages.slice();
	fixture.manager.buildSessionContext = () => ({ messages: semantic.slice() });
	const append = fixture.manager.appendMessage;
	fixture.manager.appendMessage = (message) => {
		const id = append(message);
		semantic.push(message);
		return id;
	};
}

for (const useBuilder of [true, false]) {
	test(`a persisted custom input starts a new receipt with${useBuilder ? "" : "out"} the host context builder`, () => {
		const fixture = harness();
		const first = commitSkillReceipt(fixture.manager, [...fixture.session.agent.state.messages, skill()], fixture.ctx);
		const note = custom();
		fixture.entries.push(customEntry(note));
		fixture.session.agent.state.messages.push(note);
		if (useBuilder) {
			useSemanticContext(fixture, [...first, { ...note, details: {}, attribution: "agent" }]);
		}
		const result = commitSkillReceipt(fixture.manager, [...fixture.session.agent.state.messages, skill("new clock", 20)], fixture.ctx);
		assert.equal(result.at(-2), note);
		assert.notEqual(result.at(-1), first.at(-1));
		assert.equal(fixture.entries.filter((entry) => entry.message?.herdSkill).length, 2);
		const repeated = commitSkillReceipt(fixture.manager, result, fixture.ctx);
		assert.equal(repeated.at(-1), result.at(-1));
		assert.equal(fixture.entries.length, 4);
	});
}

test("a legacy receipt after a custom input is reused despite display normalization", () => {
	const note = custom();
	const old = skill("old committed clock", 12);
	const fixture = harness([user(), note, old]);
	fixture.entries[1] = customEntry(note);
	fixture.session.agent.state.messages.pop();
	const result = commitSkillReceipt(fixture.manager, [...fixture.session.agent.state.messages, skill("later", 20)], fixture.ctx);
	assert.equal(result.at(-1), old);
	assert.equal(fixture.entries.length, 3);
});

test("a new custom input cannot reuse a legacy receipt for different input", () => {
	const oldNote = custom("Old direction");
	const fixture = harness([user(), oldNote, skill()]);
	fixture.entries[1] = customEntry(oldNote);
	fixture.session.agent.state.messages = [user(), custom("New direction")];
	assert.throws(
		() => commitSkillReceipt(fixture.manager, [...fixture.session.agent.state.messages, skill("later", 20)], fixture.ctx),
		(error) => error.code === "CONTEXT_SKILL_COMMIT_FAILED" && error.phase === "prefix check",
	);
	assert.equal(fixture.entries.length, 3);
});

test("a file mention after a receipt starts a new request", () => {
	const fixture = harness();
	commitSkillReceipt(fixture.manager, [...fixture.session.agent.state.messages, skill()], fixture.ctx);
	const mention = { role: "fileMention", files: [{ path: "notes.md", content: "Work notes" }], timestamp: 10 };
	fixture.manager.appendMessage(mention);
	fixture.session.agent.state.messages.push(mention);
	const result = commitSkillReceipt(fixture.manager, [...fixture.session.agent.state.messages, skill("next", 20)], fixture.ctx);
	assert.equal(result.at(-2), mention);
	assert.equal(fixture.entries.filter((entry) => entry.message?.herdSkill).length, 2);
});

for (const type of ["compaction", "branch_summary"]) {
	test(`the host context builder resolves a ${type} before a receipt is committed`, () => {
		const fixture = harness([user(), skill("before boundary", 2)]);
		const summary = { role: type === "compaction" ? "compactionSummary" : "branchSummary", summary: "Earlier work", timestamp: 10 };
		fixture.entries.push({ type, summary: "Earlier work", timestamp: new Date(10).toISOString() });
		fixture.session.agent.state.messages = [summary];
		useSemanticContext(fixture, [summary]);
		const result = commitSkillReceipt(fixture.manager, [summary, skill("after boundary", 20)], fixture.ctx);
		assert.equal(result[0], summary);
		assert.equal(result.at(-1).content[0].text, "after boundary");
		assert.equal(fixture.entries.length, 4);
	});
}

test("summary replay without a host context builder fails before it writes", () => {
	const fixture = harness();
	fixture.entries.push({ type: "compaction", summary: "Earlier work" });
	assert.throws(
		() => commitSkillReceipt(fixture.manager, [...fixture.session.agent.state.messages, skill()], fixture.ctx),
		(error) => error.code === "CONTEXT_SKILL_COMMIT_FAILED" && error.phase === "session lookup",
	);
	assert.equal(fixture.entries.length, 2);
});

test("state entries do not masquerade as model input after a receipt", () => {
	const fixture = harness();
	const first = commitSkillReceipt(fixture.manager, [...fixture.session.agent.state.messages, skill()], fixture.ctx);
	fixture.entries.push({ type: "custom", customType: "herd.state", data: { revision: 2 } });
	const repeated = commitSkillReceipt(fixture.manager, first, fixture.ctx);
	assert.equal(repeated.at(-1), first.at(-1));
	assert.equal(fixture.entries.length, 3);
});

test("missing journal output stops preparation before it writes a receipt", () => {
	const fixture = harness();
	const answer = { role: "assistant", content: "Not yet persisted", timestamp: 10 };
	fixture.session.agent.state.messages.push(answer);
	assert.throws(
		() => commitSkillReceipt(fixture.manager, [...fixture.session.agent.state.messages, skill()], fixture.ctx),
		(error) => error.code === "CONTEXT_SKILL_COMMIT_FAILED" && error.phase === "prefix check",
	);
	assert.equal(fixture.entries.length, 1);
});

test("an interrupted tail is checked against the journal without rewriting the committed prefix", () => {
	const fixture = harness();
	const first = commitSkillReceipt(fixture.manager, [...fixture.session.agent.state.messages, skill()], fixture.ctx);
	const interrupted = { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "partial" }], timestamp: 10 };
	fixture.manager.appendMessage(interrupted);
	fixture.session.agent.state.messages.push(interrupted);
	fixture.manager.buildSessionContext = ({ transcript } = {}) => ({
		messages: fixture.entries.map(({ message }) => message).filter((message) => transcript || message !== interrupted),
	});
	const next = commitSkillReceipt(fixture.manager, [...first, interrupted, skill("next", 20)], fixture.ctx);
	assert.deepEqual(next.slice(0, first.length), first);
	assert.equal(next.at(-2), interrupted);
	assert.equal(fixture.entries.at(-2).message, interrupted);
});

for (const [role, customType] of [
	["custom", "vibe-mode-context"],
	["hookMessage", "vibe-mode-context"],
	["custom", "prewalk-plan"],
]) {
	test(`host one-run ${role} ${customType} can follow a committed receipt`, () => {
		const fixture = harness();
		const first = commitSkillReceipt(fixture.manager, [...fixture.session.agent.state.messages, skill()], fixture.ctx);
		const note = { role, customType, content: "Live instructions", timestamp: 10 };
		fixture.session.agent.state.messages.push(note);
		const result = commitSkillReceipt(fixture.manager, [...fixture.session.agent.state.messages, skill("next", 20)], fixture.ctx);
		assert.equal(result.at(-2), note);
		assert.notEqual(result.at(-1), first.at(-1));
		assert.equal(fixture.entries.length, 3);
		const repeated = commitSkillReceipt(fixture.manager, result, fixture.ctx);
		assert.equal(repeated.at(-1), result.at(-1));
		assert.equal(fixture.entries.length, 3);
	});
}

test("ordinary missing custom input still fails instead of claiming a host exemption", () => {
	const fixture = harness();
	commitSkillReceipt(fixture.manager, [...fixture.session.agent.state.messages, skill()], fixture.ctx);
	fixture.session.agent.state.messages.push(custom("This note must be persisted."));
	assert.throws(
		() => commitSkillReceipt(fixture.manager, [...fixture.session.agent.state.messages, skill("next", 20)], fixture.ctx),
		(error) => error.code === "CONTEXT_SKILL_COMMIT_FAILED" && error.phase === "prefix check",
	);
	assert.equal(fixture.entries.length, 2);
});

test("commit returns a non-skill list unchanged", () => {
	const result = [user()];
	assert.equal(commitSkillReceipt(null, result), result);
});
