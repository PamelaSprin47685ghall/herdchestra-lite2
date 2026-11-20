import assert from "node:assert/strict";
import { test } from "node:test";

import { createState } from "../src/scope/index.mjs";
import { createUsageLedger } from "../src/scope/usage-ledger.mjs";
import { handleScopeCall } from "../src/station/controls.mjs";
import { foldBatch, netRemovableTokens, sliceChars } from "../src/station/fold.mjs";
import { applyCollapses } from "../src/transcript/index.mjs";

const HIGH = "test/high";
const LOW = "test/low";
const HEADER = { systemPrompt: "Fixed instructions", tools: [] };

function text(role, value) {
	return { role, content: [{ type: "text", text: value }] };
}

function ledgerFor(state, messages) {
	return createUsageLedger({
		state,
		contextMessages: () => messages,
		persist: () => {},
		foldBatch: () => ({ rebased: false }),
		noteError: (_domain, error) => { throw error; },
		sliceChars,
		netRemovableTokens,
		modelKeyOf: (message) => message?.provider && message?.model ? `${message.provider}/${message.model}` : null,
		actualModelOf: () => null,
	});
}

function usage(input, model = "high") {
	return { role: "assistant", provider: "test", model, content: [], usage: { input, output: 0 } };
}

function observedState() {
	const state = createState();
	state.modelCaches[HIGH] = { tokensPerChar: 0.7, fixedOverheadTokens: 100 };
	state.modelCaches[LOW] = { tokensPerChar: 0.2, fixedOverheadTokens: 100 };
	return state;
}

test("unknown target includes the complete observed system and tool header", () => {
	const state = createState();
	const messages = [text("user", "x".repeat(100))];
	const ledger = ledgerFor(state, messages);
	const header = {
		systemPrompt: "规则".repeat(200),
		tools: [{ name: "read", description: "Read a document", parameters: { type: "object", properties: { path: { type: "string" } } } }],
	};
	ledger.noteSentContext({ key: HIGH, messages, header });
	const headerBytes = Buffer.byteLength(JSON.stringify(header), "utf8");
	assert.equal(ledger.currentContextTokens(messages, "new/model"), headerBytes + 30);
});

test("unknown header and unknown target remain explicitly unmeasured", () => {
	const messages = [text("user", "work")];
	const ledger = ledgerFor(createState(), messages);
	assert.equal(ledger.projectContextTokens(messages, "new/model"), Infinity);
});

test("changed header does not use a stale measured fixed overhead", () => {
	const state = observedState();
	const messages = [text("user", "x".repeat(100))];
	const ledger = ledgerFor(state, messages);
	const header = { systemPrompt: "expanded".repeat(200), tools: [] };
	ledger.noteSentContext({ key: HIGH, messages, header });
	assert.equal(ledger.projectContextTokens(messages, HIGH), Buffer.byteLength(JSON.stringify(header), "utf8") + 70);
});

test("stable header and message prefix permit an incremental density sample", () => {
	const state = createState();
	const messages = [text("user", "a".repeat(1000))];
	const ledger = ledgerFor(state, messages);
	ledger.noteSentContext({ key: HIGH, messages, header: HEADER });
	ledger.onMessage(usage(5000), null);
	messages.push(text("toolResult", "b".repeat(1000)));
	ledger.noteSentContext({ key: HIGH, messages, header: HEADER });
	ledger.onMessage(usage(5300), null);
	assert.equal(state.modelCaches[HIGH].tokensPerChar, 0.3);
});

for (const change of ["header", "prefix", "missing header"]) {
	test(`density ignores an unaligned ${change} even when the request grows`, () => {
		const state = observedState();
		state.modelCaches[HIGH].tokensPerChar = 0.4;
		const messages = [text("user", "a".repeat(1000))];
		const ledger = ledgerFor(state, messages);
		ledger.noteSentContext({ key: HIGH, messages, header: HEADER });
		ledger.onMessage(usage(5000), null);
		if (change === "prefix") messages[0] = text("user", "replacement".repeat(200));
		else messages.push(text("toolResult", "b".repeat(1000)));
		const header = change === "header"
			? { systemPrompt: "Changed system instructions", tools: [] }
			: change === "missing header" ? undefined : HEADER;
		ledger.noteSentContext({ key: HIGH, messages, header });
		ledger.onMessage(usage(6200), null);
		assert.equal(state.modelCaches[HIGH].tokensPerChar, 0.4);
	});
}

test("rebase uses the ledger model's density and preserves foreign end units", () => {
	const state = observedState();
	state.collapses.push({
		order: 3,
		collapsed: false,
		baseModelKey: HIGH,
		baseInputTokens: 4000,
		measuredModelKey: LOW,
		endInputTokens: 1500,
	});
	const messages = [text("user", "before")];
	const ledger = ledgerFor(state, messages);
	ledger.lastUsageModelKey = HIGH;
	ledger.lastTotalInput = 5000;
	ledger.noteSentContext({ key: HIGH, messages, header: HEADER });
	ledger.lastSample = { key: HIGH };
	ledger.rebase({ savedTokens: 200, savedChars: 1000, maxOrder: 1, rebased: true });
	assert.equal(ledger.lastTotalInput, 4300);
	assert.equal(state.collapses[0].baseInputTokens, 3300);
	assert.equal(state.collapses[0].endInputTokens, 1500);
	assert.equal(ledger.lastSample, null);
	assert.equal(ledger.sentContext, null);
});

function managerFor(messages) {
	const entries = [];
	let leaf = null;
	const manager = {
		getSessionId: () => "fold-window",
		getBranch() {
			const branch = [];
			let entry = entries.find((item) => item.id === leaf);
			while (entry) {
				branch.unshift(entry);
				entry = entries.find((item) => item.id === entry.parentId);
			}
			return branch;
		},
		appendMessage(message) {
			const entry = { type: "message", id: `e${entries.length}`, parentId: leaf, message };
			entries.push(entry);
			leaf = entry.id;
			return leaf;
		},
		branch(id) { leaf = id; },
		resetLeaf() { leaf = null; },
	};
	for (const message of messages) manager.appendMessage(message);
	return manager;
}

function callMessage(id) {
	return { role: "assistant", content: [{ type: "toolCall", id, name: "scope", arguments: {} }] };
}

function scopeMessages(prefix, size) {
	return [
		callMessage(`${prefix}-begin`),
		{ ...text("toolResult", "begin"), toolCallId: `${prefix}-begin` },
		text("assistant", "x".repeat(size)),
		callMessage(`${prefix}-end`),
		{ ...text("toolResult", "end"), toolCallId: `${prefix}-end` },
	];
}

function foldFixture(targetKey) {
	const state = observedState();
	state.baseModelKey = HIGH;
	state.baseModelSpec = HIGH;
	const base = [...scopeMessages("old", 6000), ...scopeMessages("hot", 5000)];
	const current = callMessage("next-begin");
	current.usage = { input: 100 + sliceChars(base) * 0.7, output: 0 };
	base.push(current);
	const record = (prefix, order, size) => ({
		scopeId: `scope-${order}`,
		intent: prefix,
		beginToolCallId: `${prefix}-begin`,
		endToolCallId: `${prefix}-end`,
		report: "done",
		parentId: null,
		order,
		boundary: state.relay?.generation ?? 0,
		epoch: state.epoch,
		collapsed: false,
		sealed: false,
		interiorChars: size,
		interiorTokens: size * 0.7,
		measuredModelKey: HIGH,
		pinChars: 0,
		userChars: 0,
		paidRentCost: 1e9,
	});
	state.collapses.push(record("old", 1, 6000), record("hot", 2, 5000));
	const after = applyCollapses(base, [{ ...state.collapses[0], collapsed: true }], state.epoch);
	const expected = 100 + sliceChars(after) * state.modelCaches[targetKey].tokensPerChar;
	const window = expected / 0.96;
	const catalogEntry = (key, contextWindow) => ({ id: key, fullId: key, contextWindow, cost: { input: 1, cacheRead: 0.1, cacheWrite: 1 } });
	const pricingCatalog = {
		byFullId: new Map([
			[HIGH, catalogEntry(HIGH, targetKey === HIGH ? window : 100000)],
			[LOW, catalogEntry(LOW, targetKey === LOW ? window : 100000)],
		]),
		byId: new Map(), modelRoles: new Map(), modelAliases: new Map(), defaultModelKey: null,
		resolveModel: () => null,
	};
	const manager = managerFor(base);
	const ledger = ledgerFor(state, base);
	ledger.lastUsageModelKey = HIGH;
	ledger.lastTotalInput = current.usage.input;
	const folds = [];
	const registrations = [];
	const scheduler = {
		registerBatch(options) { registrations.push(options); return { ok: true, batchId: "batch-1", batch: { id: "batch-1" } }; },
		retireOwner: () => ({ ok: true }),
	};
	const station = {
		state, manager, pricingCatalog, usage: ledger,
		registry: { fissionScheduler: () => scheduler },
		policy: () => "main", relayOn: () => false,
		findBeginEntry: () => ({ id: "begin" }), pendingFission: null,
		currentContextTokens: ledger.currentContextTokens,
		tokensPerCharFor: ledger.tokensPerCharFor,
		usagePricingHint: () => undefined,
		rebaseBaselines: ledger.rebase,
		foldBatch(args) {
			const result = foldBatch({ ...args, manager, state, tokensPerChar: 0.7 });
			folds.push(result);
			return result;
		},
		persist: () => {},
	};
	return { station, base, current, expected, after, folds, registrations };
}

function openBatch(fixture, targetKey) {
	const flows = targetKey === HIGH ? [{ intent: "same", budget: { read: 1 }, permission: "ro" }] : [
		{ intent: "same", budget: { read: 1 }, permission: "ro" },
		{ intent: "small tokenizer", budget: { read: 1 }, permission: "ro", model: LOW },
	];
	return handleScopeCall(fixture.station, {
		id: "next-begin", name: "scope", arguments: {
			begin: { stage: "architecture-design", elder_report: null, time: 60, fission: flows },
		},
	}, {
		base: fixture.base, currentMessage: fixture.current, currentPersisted: true,
		ctx: { agent: { id: "owner", kind: "main" }, abort: () => {} },
	});
}

for (const targetKey of [HIGH, LOW]) {
	test(`real fold checks the retained request in ${targetKey} units without another subtraction`, () => {
		const fixture = foldFixture(targetKey);
		const result = openBatch(fixture, targetKey);
		assert.equal(fixture.folds.length, 1);
		assert.equal(fixture.folds[0].rebased, true);
		assert.equal(result.isError, true);
		assert.equal(result.details.code, "CONTEXT_EXCEEDED");
		assert.equal(result.details.model, targetKey);
		assert.equal(result.details.projectedTokens, Math.round(fixture.expected));
		assert.equal(fixture.registrations.length, 0);
		const retained = fixture.station.manager.getBranch().map((entry) => entry.message);
		assert.deepEqual(retained, fixture.after);
	});
}

test("opening an unknown target without header evidence is refused before registration", () => {
	const fixture = foldFixture(LOW);
	delete fixture.station.state.modelCaches[LOW];
	const result = openBatch(fixture, LOW);
	assert.equal(result.isError, true);
	assert.equal(result.details.code, "CONTEXT_ESTIMATE_UNAVAILABLE");
	assert.equal(result.details.model, LOW);
	assert.equal(fixture.registrations.length, 0);
});
