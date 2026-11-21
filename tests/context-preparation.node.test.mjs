import assert from "node:assert/strict";
import { test } from "node:test";

import { rememberSession } from "../src/host/capture.mjs";
import { installContextPreparation, splitRequestHistory } from "../src/host/context-preparation.mjs";
import { commitSkillReceipt } from "../src/host/hack-context.mjs";
import { reset, snapshot } from "../src/host/diagnostics.mjs";

function fixture(id = "Main") {
	const first = { role: "user", content: "Keep the request history stable." };
	const entries = [{ type: "message", message: first }];
	const manager = {
		getBranch: () => entries.slice(),
		appendMessage(message) {
			entries.push({ type: "message", message });
			return String(entries.length);
		},
	};
	const hooks = new Set();
	const session = {
		sessionManager: manager,
		getAgentId: () => id,
		agent: {
			state: { messages: [first] },
			addBeforeModelCallHook(hook) {
				hooks.add(hook);
				return () => hooks.delete(hook);
			},
		},
	};
	const ctx = { agent: { id } };
	let receiptReads = 0;
	const station = {
		manager,
		value: "initial",
		prepareRequest(current, previous) {
			return previous?.herdSkill === true ? previous : this.skillReceipt(current);
		},
		skillReceipt(current) {
			receiptReads += 1;
			return {
				role: "developer",
				content: [{ type: "text", text: `${this.value}:${current.agent.id}:${receiptReads}` }],
				timestamp: receiptReads,
				herdSkill: true,
			};
		},
		onContext() {
			throw new Error("Preparation must not run context accounting.");
		},
	};
	const loop = { messages: session.agent.state.messages.slice() };
	async function prepare(signal) {
		for (const hook of hooks) await hook(signal, loop);
	}
	function finishTurn(number) {
		const generated = [
			{ role: "assistant", content: [{ type: "toolCall", id: `read-${number}`, name: "read", arguments: {} }] },
			{ role: "toolResult", toolCallId: `read-${number}`, content: [{ type: "text", text: `result-${number}` }] },
		];
		// The real loop and Agent append the same events to separate arrays.
		loop.messages.push(...generated);
		session.agent.state.messages.push(...generated);
		for (const message of generated) manager.appendMessage(message);
	}
	return { session, station, ctx, manager, entries, hooks, loop, prepare, finishTurn, receiptReads: () => receiptReads };
}

test("consecutive loop requests retain all earlier receipts across context clones", async () => {
	const f = fixture();
	const remove = installContextPreparation(f.session, f);
	let previous = [];
	for (let turn = 1; turn <= 4; turn += 1) {
		f.station.value = `turn-${turn}`;
		await f.prepare();
		const beforeExtension = f.loop.messages;
		const request = structuredClone(beforeExtension);
		assert.deepEqual(request.slice(0, previous.length), previous);
		assert.equal(request.filter((message) => message.herdSkill).length, turn);
		assert.deepEqual(request, f.session.agent.state.messages);
		assert.deepEqual(request, f.entries.map((entry) => entry.message));
		assert.notEqual(f.loop.messages, f.session.agent.state.messages);
		// emitContext can now map every receipt to an unchanged history item.
		assert.deepEqual(request.at(-1), beforeExtension.at(-1));
		previous = request;
		f.finishTurn(turn);
	}
	assert.equal(f.receiptReads(), 4);
	remove();
});

test("committing only from the cloned context reproduces the missing loop history", () => {
	const f = fixture();
	rememberSession(f.session);
	const first = commitSkillReceipt(f.manager, [...structuredClone(f.loop.messages), f.station.skillReceipt(f.ctx)], f.session);
	assert.equal(f.loop.messages.some((message) => message.herdSkill), false);
	f.finishTurn(1);
	const second = commitSkillReceipt(f.manager, [...structuredClone(f.loop.messages), f.station.skillReceipt(f.ctx)], f.session);
	assert.notDeepEqual(second.slice(0, first.length), first);
	assert.equal(second.filter((message) => message.herdSkill).length, 1);
});

test("a repeated preparation reuses one committed receipt and clock", async () => {
	const f = fixture();
	installContextPreparation(f.session, f);
	await f.prepare();
	const receipt = f.loop.messages.at(-1);
	f.station.value = "changed during retry";
	await f.prepare();
	assert.equal(f.loop.messages.at(-1), receipt);
	assert.equal(f.session.agent.state.messages.at(-1), receipt);
	assert.equal(f.receiptReads(), 1);
	assert.equal(f.entries.filter((entry) => entry.message.herdSkill).length, 1);
});

test("reinstall updates the binding while retaining one removable hook", async () => {
	const f = fixture();
	const remove = installContextPreparation(f.session, f);
	const next = { ...f.station, value: "updated binding" };
	const secondRemove = installContextPreparation(f.session, { station: next, ctx: f.ctx });
	assert.equal(f.hooks.size, 1);
	assert.equal(secondRemove, remove);
	await f.prepare();
	assert.match(f.loop.messages.at(-1).content[0].text, /^updated binding:/);
	remove();
	remove();
	assert.equal(f.hooks.size, 0);
	installContextPreparation(f.session, f);
	assert.equal(f.hooks.size, 1);
});

test("an aborted request does not create or commit a receipt", async () => {
	const f = fixture();
	installContextPreparation(f.session, f);
	const controller = new AbortController();
	controller.abort(new Error("cancelled request"));
	await assert.rejects(f.prepare(controller.signal), /cancelled request/);
	assert.equal(f.receiptReads(), 0);
	assert.equal(f.loop.messages.length, 1);
	assert.equal(f.session.agent.state.messages.length, 1);
	assert.equal(f.entries.length, 1);
});

test("later extension projections remain local to their request", async () => {
	const f = fixture();
	installContextPreparation(f.session, f);
	await f.prepare();
	const request = structuredClone(f.loop.messages);
	request[0].content = "A later extension changed its own projection.";
	request.push({ role: "user", content: "A later extension added a request note." });
	assert.equal(f.loop.messages[0].content, "Keep the request history stable.");
	assert.equal(f.session.agent.state.messages[0].content, "Keep the request history stable.");
	assert.equal(f.loop.messages.length, 2);
	assert.equal(f.entries.length, 2);
});

test("independent agents prepare only their own histories", async () => {
	const owner = fixture("Main");
	const flow = fixture("flow-a");
	installContextPreparation(owner.session, owner);
	installContextPreparation(flow.session, flow);
	await flow.prepare();
	assert.equal(owner.loop.messages.length, 1);
	assert.equal(owner.entries.length, 1);
	assert.equal(flow.loop.messages.length, 2);
	await owner.prepare();
	assert.match(owner.loop.messages.at(-1).content[0].text, /:Main:/);
	assert.match(flow.loop.messages.at(-1).content[0].text, /:flow-a:/);
});

test("unsupported host hooks and mismatched bindings fail explicitly", () => {
	const f = fixture();
	assert.throws(
		() => installContextPreparation({ agent: { state: { messages: [] } } }, f),
		{ code: "CONTEXT_PREPARATION_UNAVAILABLE" },
	);
	assert.throws(
		() => installContextPreparation(f.session, { station: f.station, ctx: { agent: { id: "other" } } }),
		{ code: "CONTEXT_PREPARATION_INVALID_BINDING" },
	);
	assert.equal(f.hooks.size, 0);
});

test("a host that cannot remove its hook leaves preparation disabled", async () => {
	const f = fixture();
	f.session.agent.addBeforeModelCallHook = (hook) => { f.hooks.add(hook); };
	assert.throws(() => installContextPreparation(f.session, f), { code: "CONTEXT_PREPARATION_UNAVAILABLE" });
	await f.prepare();
	assert.equal(f.receiptReads(), 0);
	assert.equal(f.entries.length, 1);
});

test("the station can decline preparation without changing context", async () => {
	const f = fixture();
	let observed = false;
	f.station.prepareRequest = () => { observed = true; return null; };
	installContextPreparation(f.session, f);
	const original = f.loop.messages;
	await f.prepare();
	assert.equal(observed, true);
	assert.equal(f.loop.messages, original);
	assert.equal(f.receiptReads(), 0);
	assert.equal(f.entries.length, 1);
});

test("an awaited preparation cannot commit after cancellation or removal", async () => {
	for (const cancelled of [true, false]) {
		const f = fixture();
		const input = { role: "user", content: "Keep this pending direction.", timestamp: 20 };
		f.loop.messages.push(input);
		const original = f.loop.messages;
		const before = structuredClone(original);
		let resolveReceipt;
		f.station.prepareRequest = () => new Promise((resolve) => { resolveReceipt = resolve; });
		const remove = installContextPreparation(f.session, f);
		const controller = new AbortController();
		const pending = f.prepare(controller.signal);
		if (cancelled) controller.abort(new Error("cancelled while preparing"));
		else remove();
		resolveReceipt(f.station.skillReceipt(f.ctx));
		if (cancelled) await assert.rejects(pending, /cancelled while preparing/);
		else await pending;
		assert.equal(f.entries.length, 1);
		assert.equal(f.loop.messages, original);
		assert.deepEqual(f.loop.messages, before);
		assert.equal(f.loop.messages.at(-1), input);
		assert.equal(f.session.agent.state.messages.length, 1);
	}
});

test("an awaited preparation rejects a changed agent binding", async () => {
	const f = fixture();
	let resolveReceipt;
	f.station.prepareRequest = () => new Promise((resolve) => { resolveReceipt = resolve; });
	installContextPreparation(f.session, f);
	const pending = f.prepare();
	installContextPreparation(f.session, { station: { ...f.station }, ctx: f.ctx });
	resolveReceipt(f.station.skillReceipt(f.ctx));
	await assert.rejects(pending, { code: "CONTEXT_PREPARATION_STALE" });
	assert.equal(f.entries.length, 1);
});

test("a restore ticket cannot commit across a station replacement or epoch change", async () => {
	for (const replace of [false, true]) {
		const f = fixture();
		f.station.state = { epoch: 1 };
		const input = { role: "user", content: "Pending direction", timestamp: 21 };
		f.loop.messages.push(input);
		const original = f.loop.messages;
		let resolveReceipt;
		f.station.prepareRequest = () => new Promise((resolve) => { resolveReceipt = resolve; });
		installContextPreparation(f.session, f);
		const pending = f.prepare();
		if (replace) f.station.state = { epoch: 1 };
		else f.station.state.epoch += 1;
		resolveReceipt(f.station.skillReceipt(f.ctx));
		await assert.rejects(pending, { code: "CONTEXT_PREPARATION_STALE" });
		assert.equal(f.entries.length, 1);
		assert.equal(f.session.agent.state.messages.length, 1);
		assert.equal(f.loop.messages, original);
		assert.equal(f.loop.messages.at(-1), input);
	}
});

test("a persistence flush cannot prepare for a retired station epoch", async () => {
	const f = fixture();
	f.station.state = { epoch: 1 };
	let release;
	f.session.settleInFlightMessagePersistence = () => new Promise((resolve) => { release = resolve; });
	installContextPreparation(f.session, f);
	const pending = f.prepare();
	f.station.state.epoch += 1;
	release();
	await assert.rejects(pending, { code: "CONTEXT_PREPARATION_STALE" });
	assert.equal(f.receiptReads(), 0);
	assert.equal(f.entries.length, 1);
});

test("synchronous boundary observation can advance the epoch before a restore ticket", async () => {
	const f = fixture();
	f.station.state = { epoch: 1 };
	f.station.prepareRequest = () => {
		f.station.state.epoch += 1;
		return Promise.resolve(f.station.skillReceipt(f.ctx));
	};
	installContextPreparation(f.session, f);
	await f.prepare();
	assert.equal(f.station.state.epoch, 2);
	assert.equal(f.entries.length, 2);
	assert.equal(f.loop.messages.at(-1).herdSkill, true);
});

test("a pending input replaced during a restore ticket is never overwritten", async () => {
	const f = fixture();
	const input = { role: "user", content: "Old direction", timestamp: 22 };
	f.loop.messages.push(input);
	const original = f.loop.messages;
	let resolveReceipt;
	f.station.prepareRequest = () => new Promise((resolve) => { resolveReceipt = resolve; });
	installContextPreparation(f.session, f);
	const pending = f.prepare();
	const replacement = { ...input, content: "Replacement direction" };
	f.loop.messages[1] = replacement;
	resolveReceipt(f.station.skillReceipt(f.ctx));
	await assert.rejects(pending, { code: "CONTEXT_PREPARATION_STALE" });
	assert.equal(f.loop.messages, original);
	assert.equal(f.loop.messages[1], replacement);
	assert.equal(f.entries.length, 1);
	assert.equal(f.session.agent.state.messages.length, 1);
});

test("initial input stays after the receipt and is committed only by its host event", async () => {
	const f = fixture();
	const input = f.loop.messages[0];
	f.session.agent.state.messages = [];
	f.entries.length = 0;
	installContextPreparation(f.session, f);
	await f.prepare();
	const receipt = f.loop.messages[0];
	assert.equal(receipt.herdSkill, true);
	assert.equal(f.loop.messages[1], input);
	assert.deepEqual(f.session.agent.state.messages, [receipt]);
	assert.deepEqual(f.entries.map((entry) => entry.message), [receipt]);
	await f.prepare();
	assert.equal(f.receiptReads(), 1);
	f.session.agent.state.messages.push(input);
	f.manager.appendMessage(input);
	assert.deepEqual(f.loop.messages, f.session.agent.state.messages);
	assert.deepEqual(f.loop.messages, f.entries.map((entry) => entry.message));
});

test("queued steering retains its order without being appended twice", async () => {
	const f = fixture();
	installContextPreparation(f.session, f);
	await f.prepare();
	f.finishTurn(1);
	const pending = [
		{ role: "user", content: "New direction", timestamp: 10 },
		{ role: "custom", customType: "steer", content: "Context note", timestamp: 11 },
	];
	f.loop.messages.push(...pending);
	await f.prepare();
	const receipt = f.loop.messages.at(-3);
	assert.equal(receipt.herdSkill, true);
	assert.deepEqual(f.loop.messages.slice(-2), pending);
	assert.equal(f.session.agent.state.messages.at(-1), receipt);
	assert.equal(f.entries.at(-1).message, receipt);
	for (const message of pending) {
		f.session.agent.state.messages.push(message);
		if (message.role === "custom") {
			// AgentSession stores custom input outside ordinary message entries.
			f.entries.push({
				type: "custom_message",
				customType: message.customType,
				content: message.content,
				timestamp: new Date(message.timestamp).toISOString(),
			});
		} else f.manager.appendMessage(message);
	}
	assert.deepEqual(f.loop.messages, f.session.agent.state.messages);
	assert.equal(f.loop.messages.filter((message) => message === pending[0]).length, 1);
	await f.prepare();
	assert.equal(f.receiptReads(), 3);
	assert.equal(f.entries.at(-2).type, "custom_message");
	assert.equal(f.entries.at(-1).message.herdSkill, true);
	assert.equal(f.loop.messages.filter((message) => message === pending[1]).length, 1);
	assert.deepEqual(f.loop.messages, f.session.agent.state.messages);
});

test("preparation waits for earlier message persistence before appending its receipt", async () => {
	const f = fixture();
	installContextPreparation(f.session, f);
	await f.prepare();
	f.finishTurn(1);
	const delayed = f.entries.splice(-2);
	let release;
	const ready = new Promise((resolve) => { release = resolve; });
	let flushes = 0;
	f.session.settleInFlightMessagePersistence = async () => {
		flushes += 1;
		await ready;
		f.entries.push(...delayed);
	};
	const pending = f.prepare();
	await Promise.resolve();
	assert.equal(f.receiptReads(), 1);
	assert.equal(f.entries.at(-1).message.herdSkill, true);
	release();
	await pending;
	assert.equal(flushes, 1);
	assert.deepEqual(f.loop.messages, f.entries.map((entry) => entry.message));
	assert.equal(f.entries.at(-2).message.role, "toolResult");
	assert.equal(f.entries.at(-1).message.herdSkill, true);
});

test("the committed tail can identify a loop whose older interior is still unfolded", () => {
	const old = { role: "assistant", content: "old work" };
	const summary = { role: "developer", content: "folded work" };
	const tail = { role: "toolResult", toolCallId: "last", content: "done" };
	const input = { role: "user", content: "continue" };
	assert.deepEqual(splitRequestHistory([old, tail, input], [summary, tail]), {
		prefix: [old, tail],
		pending: [input],
		recovered: [],
	});
	assert.deepEqual(splitRequestHistory([old, structuredClone(tail), input], [summary, tail]).pending, [input]);
});

test("committed history that the live loop lost is still rejected", () => {
	const user = { role: "user", content: "start" };
	const output = { role: "assistant", content: "unfinished" };
	assert.throws(() => splitRequestHistory([user], [output]), { code: "CONTEXT_PREPARATION_HISTORY_MISMATCH" });
	assert.throws(() => splitRequestHistory([{ role: "toolResult", toolCallId: "unknown" }], []), { code: "CONTEXT_PREPARATION_HISTORY_MISMATCH" });
});

test("an uncommitted frame before new input is isolated instead of blocking it", () => {
	const user = { role: "user", content: "start" };
	const call = { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }] };
	const result = { role: "toolResult", toolCallId: "read-1", content: [{ type: "text", text: "denied" }] };
	const next = { role: "user", content: "continue" };
	assert.deepEqual(splitRequestHistory([user, call, result, next], [user]), {
		prefix: [user],
		pending: [next],
		recovered: [call, result],
	});
	const again = splitRequestHistory([user, structuredClone(call), structuredClone(result)], [user]);
	assert.deepEqual(again.pending, []);
	assert.equal(again.recovered.length, 2);
});

test("a tool result must belong to the frame before it", () => {
	const user = { role: "user", content: "start" };
	const call = { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }] };
	const foreign = { role: "toolResult", toolCallId: "read-2", content: "other" };
	assert.throws(() => splitRequestHistory([user, call, foreign], [user]), {
		code: "CONTEXT_PREPARATION_HISTORY_MISMATCH",
	});
	const answer = { role: "assistant", content: "done" };
	assert.throws(() => splitRequestHistory([user, answer, foreign], [user]), {
		code: "CONTEXT_PREPARATION_HISTORY_MISMATCH",
	});
});

test("output that follows an input cannot be recovered", () => {
	const user = { role: "user", content: "start" };
	const next = { role: "user", content: "later" };
	const stray = { role: "assistant", content: "unfinished" };
	assert.throws(() => splitRequestHistory([user, next, stray], [user]), {
		code: "CONTEXT_PREPARATION_HISTORY_MISMATCH",
	});
});

test("a rejected tool turn does not block later requests and is recorded", async () => {
	const f = fixture();
	installContextPreparation(f.session, f);
	await f.prepare();
	const call = { role: "assistant", content: [{ type: "toolCall", id: "read-9", name: "read", arguments: {} }] };
	const denied = { role: "toolResult", toolCallId: "read-9", content: [{ type: "text", text: "denied" }] };
	f.loop.messages.push(call, denied);
	for (let turn = 1; turn <= 3; turn += 1) {
		const input = { role: "user", content: `continue-${turn}`, timestamp: 100 + turn };
		f.loop.messages.push(input);
		reset();
		await f.prepare();
		const records = snapshot().filter((entry) => entry.domain === "context");
		assert.equal(records.length, turn === 1 ? 1 : 0);
		if (turn === 1) {
			assert.equal(records[0].detail.count, 2);
			assert.deepEqual(records[0].detail.toolCallIds, ["read-9"]);
		}
		assert.equal(f.loop.messages.filter((message) => message === input).length, 1);
		assert.equal(f.loop.messages.includes(call), false);
		assert.equal(f.loop.messages.includes(denied), false);
		assert.equal(f.loop.messages.at(-1), input);
		f.finishTurn(turn + 1);
	}
});

test("a live steer in the same loop follows the assistant frame despite host snapshot metadata", async () => {
	const f = fixture();
	installContextPreparation(f.session, f);
	await f.prepare();
	const first = f.loop.messages.slice();
	const answer = {
		role: "assistant", api: "openai-completions", provider: "test", model: "test",
		responseId: "one", timestamp: 100, stopReason: "stop", content: [{ type: "text", text: "First answer" }],
	};
	const saved = { ...answer, completedAt: 105, contextSnapshot: { promptTokens: 200 } };
	f.session.agent.state.messages.push(saved);
	f.manager.appendMessage(saved);
	const input = { role: "custom", customType: "fission.broadcast", content: "next direction" };
	f.loop.messages.push(answer, input);
	await f.prepare();
	assert.deepEqual(f.loop.messages.slice(0, first.length), first);
	assert.equal(f.loop.messages.at(-3), answer);
	assert.equal(f.loop.messages.at(-2).herdSkill, true);
	assert.equal(f.loop.messages.at(-1), input);
});

test("a reused pending input object cannot be mistaken for the committed tail", async () => {
	const f = fixture();
	const input = f.loop.messages[0];
	f.loop.messages.push(input);
	const original = f.loop.messages;
	installContextPreparation(f.session, f);
	await assert.rejects(f.prepare(), { code: "CONTEXT_PREPARATION_HISTORY_MISMATCH" });
	assert.equal(f.loop.messages, original);
	assert.deepEqual(f.loop.messages, [input, input]);
	assert.deepEqual(f.session.agent.state.messages, [input]);
	assert.equal(f.entries.length, 1);
	assert.equal(f.receiptReads(), 0);
});

test("structural tail matches must be unique and known input roles remain pending", () => {
	const tail = { role: "user", content: "same input" };
	assert.throws(
		() => splitRequestHistory([structuredClone(tail), structuredClone(tail)], [tail]),
		{ code: "CONTEXT_PREPARATION_HISTORY_MISMATCH" },
	);
	assert.deepEqual(splitRequestHistory([structuredClone(tail), tail], [tail]).pending, []);
	const pending = [{ role: "fileMention", content: "file" }, { role: "hookMessage", content: "legacy note" }];
	assert.deepEqual(splitRequestHistory(pending, []).pending, pending);
});
