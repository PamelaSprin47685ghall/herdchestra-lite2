/**
 * Folding economics and the new scope contract (end:true + elder_report).
 * Real hooks against a fake host with the same tree semantics as omp.
 */

import { describe, expect, test } from "bun:test";
import { activate } from "../src/main.mjs";
import { stateFor, stationFor } from "../src/station/index.mjs";
import {
	applyCollapses,
	finishedReport,
} from "../src/transcript/index.mjs";
import {
	foldBatch,
	measureScopeInterior,
	netRemovableTokens,
	shouldFoldPool,
	sliceChars,
} from "../src/station/fold.mjs";
import { createEmptyCatalog, resolveModelPolicy } from "../src/host/pricing.mjs";
import { charsToTokens } from "../src/host/pricing.mjs";
import { createState, deserializeState, findPendingReportElder, serializeState, truncateForHostBoundary } from "../src/scope/index.mjs";

// -- Fake host ----------------------------------------------------------------

function makeManager() {
	const entries = [];
	let leafId = null;
	let nextId = 1;
	const id = () => `e${nextId++}`;
	const manager = {
		entries,
		getLeafId: () => leafId,
		getBranch: (fromId) => {
			const path = [];
			let current = fromId
				? entries.find((entry) => entry.id === fromId)
				: entries.find((entry) => entry.id === leafId);
			while (current) {
				path.unshift(current);
				current = current.parentId
					? entries.find((entry) => entry.id === current.parentId)
					: undefined;
			}
			return path;
		},
		branch: (entryId) => {
			if (!entries.some((e) => e.id === entryId)) throw new Error(`missing ${entryId}`);
			leafId = entryId;
		},
		resetLeaf: () => {
			leafId = null;
		},
		appendMessage: (message) => {
			const entry = { type: "message", id: id(), parentId: leafId, message };
			entries.push(entry);
			leafId = entry.id;
			return entry.id;
		},
		appendCustomEntry: (customType, data) => {
			const entry = { type: "custom", customType, data, id: id(), parentId: leafId };
			entries.push(entry);
			leafId = entry.id;
			return entry.id;
		},
		buildSessionContext: () => ({
			messages: manager.getBranch().filter((e) => e.type === "message").map((e) => e.message),
		}),
	};
	return manager;
}

function makeHost() {
	const handlers = new Map();
	const tools = new Map();
	const steers = [];
	const pi = {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		registerTool(definition) {
			tools.set(definition.name, definition);
		},
		sendUserMessage(text, options) {
			steers.push({ text, options });
			return Promise.resolve();
		},
	};
	return { pi, handlers, tools, steers };
}

async function emit(handlers, event, payload, ctx) {
	const results = [];
	for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
	return results.find((result) => result !== undefined);
}

const assistant = (content, timestamp) => ({
	role: "assistant",
	content,
	timestamp: timestamp ?? Date.now(),
});
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const toolResult = (id, name, text, isError = false) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: name,
	content: [{ type: "text", text }],
	isError,
	timestamp: Date.now(),
});

async function start() {
	const manager = makeManager();
	const host = makeHost();
	await activate(host.pi);
	const ctx = { sessionManager: manager, agentMessages: [] };
	manager.appendMessage({ role: "user", content: "do", timestamp: Date.now() });
	return { host, ctx, manager };
}

async function run(host, ctx, message) {
	const manager = ctx.sessionManager;
	await emit(host.handlers, "assistant_message", { type: "assistant_message", message }, ctx);
	manager.appendMessage(message);
	ctx.agentMessages.push(message);
	const out = [];
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		const decision = await emit(
			host.handlers,
			"tool_call",
			{ type: "tool_call", toolCallId: block.id, toolName: block.name, input: block.arguments },
			ctx,
		);
		let text;
		let isError;
		if (decision?.block) {
			text = decision.reason;
			isError = true;
		} else {
			const tool = host.tools.get(block.name);
			const output = tool
				? await tool.execute(block.id, block.arguments, undefined, undefined, ctx)
				: { content: [{ type: "text", text: `${block.name} ok` }] };
			text = output.content[0].text;
			isError = Boolean(output.isError);
		}
		const result = toolResult(block.id, block.name, text, isError);
		manager.appendMessage(result);
		ctx.agentMessages.push(result);
		out.push({ id: block.id, text, isError, blocked: Boolean(decision?.block) });
	}
	return out;
}

const texts = (messages) =>
	messages.map((m) =>
		typeof m.content === "string"
			? m.content
			: (m.content ?? []).map((b) => b.text ?? b.thinking ?? "").join(""),
	);

// -- API gate -----------------------------------------------------------------

describe("scope contract gate", () => {
	test("end:true closes with no report; a following begin needs elder_report", async () => {
		const { host, ctx } = await start();
		await run(host, ctx, assistant([call("b1", "scope", {
			begin: { intent: "first", budget: { read: 1 }, elder_report: null },
		})]));
		const closed = await run(host, ctx, assistant([call("e1", "scope", { end: true })]));
		expect(closed[0].text).toContain("Scope closed.");
		expect(closed[0].text).toContain("No elder sibling scope was collapsed.");

		await run(host, ctx, assistant([call("b2", "scope", {
			begin: { intent: "second", budget: { read: 1 } },
		})]));
		expect(stateFor(ctx).state.scopes).toHaveLength(0);
		// await run above already consumed a tool result with the gate message.
		const pending = findPendingReportElder(stateFor(ctx).state, null, 0, 0);
		expect(pending).not.toBeNull();
		expect(pending.report).toBeNull();
	});

	test("MISSING_ELDER_REPORT does not open a sibling scope", async () => {
		const { host, ctx } = await start();
		await run(host, ctx, assistant([call("b1", "scope", {
			begin: { intent: "first", budget: { read: 1 }, elder_report: null },
		})]));
		await run(host, ctx, assistant([call("e1", "scope", { end: true })]));
		const blocked = await run(host, ctx, assistant([call("b2", "scope", {
			begin: { intent: "second", budget: { read: 1 }, elder_report: null },
		})]));
		expect(blocked[0].text).toContain("MISSING_ELDER_REPORT");
		expect(stateFor(ctx).state.scopes).toHaveLength(0);
	});

	test("blank elder_report is rejected too", async () => {
		const { host, ctx } = await start();
		await run(host, ctx, assistant([call("b1", "scope", {
			begin: { intent: "first", budget: { read: 1 }, elder_report: null },
		})]));
		await run(host, ctx, assistant([call("e1", "scope", { end: true })]));
		const blocked = await run(host, ctx, assistant([call("b2", "scope", {
			begin: { intent: "second", budget: { read: 1 }, elder_report: "   " },
		})]));
		expect(blocked[0].text).toContain("MISSING_ELDER_REPORT");
	});

	test("combined end+begin with missing elder_report keeps the current scope open", async () => {
		const { host, ctx } = await start();
		await run(host, ctx, assistant([call("b1", "scope", {
			begin: { intent: "outer", budget: { read: 1 }, elder_report: null },
		})]));
		const before = stateFor(ctx).state.scopes.length;
		const blocked = await run(host, ctx, assistant([call("t1", "scope", {
			end: true,
			begin: { intent: "next", budget: { read: 1 } },
		})]));
		expect(blocked[0].text).toContain("MISSING_ELDER_REPORT");
		expect(stateFor(ctx).state.scopes).toHaveLength(before);
		const work = await run(host, ctx, assistant([call("r1", "read", { path: "still-open" })]));
		expect(work[0].blocked).toBe(false);
	});

	test("combined end+begin with elder_report archives and opens", async () => {
		const { host, ctx } = await start();
		await run(host, ctx, assistant([call("b1", "scope", {
			begin: { intent: "outer", budget: { read: 1 }, elder_report: null },
		})]));
		const transition = await run(host, ctx, assistant([call("t1", "scope", {
			end: true,
			begin: { intent: "next", budget: { read: 1 }, elder_report: "outer summary" },
		})]));
		expect(transition[0].text).toContain("Scope closed.");
		expect(transition[0].text).toContain("You are now inside this scope.");
		expect(stateFor(ctx).state.scopes.at(-1).intent).toBe("next");
	});

	test("legacy string end is rejected", async () => {
		const { host, ctx } = await start();
		await run(host, ctx, assistant([call("b1", "scope", {
			begin: { intent: "work", budget: { read: 1 }, elder_report: null },
		})]));
		const bad = await run(host, ctx, assistant([call("e1", "scope", {
			end: { return_markdown: "old style" },
		})]));
		expect(bad[0].text).toContain("INVALID_ARGUMENT");
	});

	test("end:false with begin opens normally", async () => {
		const { host, ctx } = await start();
		const opened = await run(host, ctx, assistant([call("b1", "scope", {
			end: false,
			begin: { intent: "work", budget: { read: 1 }, elder_report: null },
		})]));
		expect(opened[0].text).toContain("You are now inside this scope.");
		expect(stateFor(ctx).state.scopes).toHaveLength(1);
	});
});

// -- Shared economics record fixture ------------------------------------------

const RECORD = (overrides = {}) => ({
	collapsed: false,
	report: "summary",
	interiorTokens: 8000,
	pinTokens: 0,
	paidRentCost: 0,
	baseInputTokens: 1000,
	beginToolCallId: "bg",
	endToolCallId: "ed",
	order: 1,
	epoch: 0,
	...overrides,
});

const pricing = (pHit, pMiss, cw) => ({
	pHit,
	pMiss,
	contextWindow: cw,
	knownPricing: true,
});

// -- Economics ----------------------------------------------------------------

describe("folding economics", () => {

	test("net removable tokens subtract the kept receipt and pins", () => {
		const big = RECORD();
		const heavy = RECORD({ interiorTokens: 120, report: "x".repeat(2000) });
		expect(netRemovableTokens(big)).toBeGreaterThan(netRemovableTokens(heavy));
		expect(netRemovableTokens(big)).toBeGreaterThan(0);
		expect(netRemovableTokens({ ...big, collapsed: true })).toBe(0);
		expect(sliceChars([assistant([{ type: "text", text: "abcd" }])])).toBe(4);
	});

	test("high retained tail with cheap reads holds the pool", () => {
		const decision = shouldFoldPool({
			pool: [RECORD({ interiorTokens: 200 })],
			state: { epoch: 0 },
			base: [],
			budget: { read: 1 },
			pricing: pricing(1e-6, 10e-6, null),
			contextTokens: 0,
			usageSnapshot: { lastTotalInput: 90000 },
			tokensPerChar: 0.3,
		});
		// A huge M_after (90000-1000 - B_pool) makes rewrite cost exceed
		// the two-step rent saving, so no fold.
		expect(decision.fold).toBe(false);
		expect(decision.reason).toBe("hold");
	});

	test("paid rent plus a big pool crosses the threshold", () => {
		const decision = shouldFoldPool({
			pool: [RECORD({ interiorTokens: 60000, paidRentCost: 5 })],
			state: { epoch: 0 },
			base: [],
			budget: { read: 100 },
			pricing: pricing(2e-6, 20e-6, null),
			contextTokens: 0,
			usageSnapshot: { lastTotalInput: 62000 },
			tokensPerChar: 0.3,
		});
		expect(decision.fold).toBe(true);
		expect(decision.reason).toBe("economics");
	});

	test("an 82% watermark folds even without cost pressure", () => {
		const decision = shouldFoldPool({
			pool: [RECORD()],
			state: { epoch: 0 },
			base: [],
			budget: { read: 1 },
			pricing: pricing(1e-6, 10e-6, 100000),
			contextTokens: 83000,
			tokensPerChar: 0.3,
		});
		expect(decision.fold).toBe(true);
		expect(decision.reason).toBe("watermark");
	});

	test("a free model holds until the watermark", () => {
		const free = pricing(0, 0, 100000);
		const low = shouldFoldPool({
			pool: [RECORD()],
			state: { epoch: 0 },
			base: [],
			budget: { read: 1 },
			pricing: free,
			contextTokens: 50000,
		});
		expect(low.fold).toBe(false);
		const high = shouldFoldPool({
			pool: [RECORD()],
			state: { epoch: 0 },
			base: [],
			budget: { read: 1 },
			pricing: free,
			contextTokens: 95000,
		});
		expect(high.fold).toBe(true);
		expect(high.reason).toBe("watermark");
	});

	test("real pricing categories derive the expected prices", () => {
		// Build a catalog whose resolveModel() answers the hint model object.
		const catalogFor = (model) => ({
			resolveModel: () => ({
				id: "m",
				label: "m",
				contextWindow: model.contextWindow,
				cost: model.cost,
			}),
		});
		const anthropic = resolveModelPolicy(catalogFor({
			cost: { input: 3, cacheRead: 0.3, cacheWrite: 3.75 },
			contextWindow: 200000,
		}), {}, { model: {} });
		expect(anthropic.pHit).toBeCloseTo(0.3e-6);
		expect(anthropic.pMiss).toBeGreaterThan(anthropic.pHit);

		const noCache = resolveModelPolicy(catalogFor({
			cost: { input: 2 }, contextWindow: 128000,
		}), {}, { model: {} });
		expect(noCache.pHit).toBe(noCache.pMiss);

		const free = resolveModelPolicy(catalogFor({
			cost: { input: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000,
		}), {}, { model: {} });
		expect(free.pHit).toBe(0);
		expect(free.pMiss).toBe(0);
		expect(free.knownPricing).toBe(true);
	});

	test("usage-derived prices feed the rent comparison", () => {
		const derived = resolveModelPolicy(null, {}, {
			usage: {
				cacheRead: 1000,
				input: 500,
				cacheWrite: 200,
				cost: { cacheRead: 0.3, input: 1.5, cacheWrite: 0.75 },
			},
		});
		expect(derived.pHit).toBeCloseTo(0.3 / 1000);
		expect(derived.pMiss).toBeGreaterThan(0);
		expect(derived.label).toBe("usage-derived");
	});
});

// -- Watermark and measured interior -----------------------------------------

describe("watermark response and measurement", () => {
	test("batch folding persists user messages before each opening call, including a shared close/open call", () => {
		const manager = makeManager();
		const first = RECORD({ endToolCallId: "switch", report: "first outcome" });
		const second = RECORD({ beginToolCallId: "switch", endToolCallId: "ed", order: 2, report: "second outcome" });
		const base = [
			{ role: "user", content: "Start", timestamp: 1 },
			assistant([call("bg", "scope", { begin: {} })], 2),
			toolResult("bg", "scope", "Begin"),
			{ role: "user", content: "  Keep this spacing.\n", timestamp: 3 },
			assistant([{ type: "text", text: "discard this work" }], 4),
			{ role: "user", content: [{ type: "text", text: "And this block." }], timestamp: 5 },
			assistant([call("switch", "scope", { end: true, begin: {} })], 6),
			toolResult("switch", "scope", "End and begin"),
			{ role: "user", content: "Second scope request", timestamp: 7 },
			assistant([call("ed", "scope", { end: true })], 8),
			toolResult("ed", "scope", "End"),
			{ role: "user", content: "After both scopes", timestamp: 9 },
		];
		for (const message of base) manager.appendMessage(message);

		const folded = foldBatch({ manager, batch: [first, second], base });

		expect(folded.foldedCount).toBe(2);
		const { messages } = manager.buildSessionContext();
		expect(messages).toEqual([
			base[0], base[3], base[5], base[1],
			{ ...base[2], content: [{ type: "text", text: finishedReport(first.report) }] },
			base[8], base[6],
			{ ...base[7], content: [{ type: "text", text: finishedReport(second.report) }] },
			...base.slice(9),
		]);
		expect(applyCollapses(messages, [first, second])).toEqual(messages);
	});

	test("snapshot restore keeps model densities but a host rewrite clears all prefixes", () => {
		const state = createState();
		state.baseModelSpec = "fixture/large:high";
		state.baseModelKey = "fixture/large";
		state.modelCaches["fixture/large"] = { cachedUntilPos: 20, lastUsedAt: 1_000, tokensPerChar: 0.4 };
		state.modelCaches["fixture/small"] = { cachedUntilPos: 12, lastUsedAt: 2_000, tokensPerChar: 0.2 };
		const restored = deserializeState(serializeState(state));
		expect(restored.baseModelSpec).toBe("fixture/large:high");
		expect(restored.modelCaches).toEqual(state.modelCaches);
		truncateForHostBoundary(restored);
		expect(Object.values(restored.modelCaches).map((entry) => [entry.cachedUntilPos, entry.tokensPerChar])).toEqual([[0, 0.4], [0, 0.2]]);
	});

	test("a warm outer model can veto folding for a cold target until its cache expires", () => {
		const now = 1_000_000;
		const target = "fixture/small";
		const outer = "fixture/large";
		const base = [
			assistant([call("cb", "scope", { begin: {} })], 1),
			toolResult("cb", "scope", "Begin", false),
			assistant([{ type: "text", text: "a".repeat(300) }]),
			assistant([call("ce", "scope", { end: true })], 2),
			toolResult("ce", "scope", "End", false),
			{ role: "user", content: "hot workbench".repeat(1000) },
		];
		const record = RECORD({ beginToolCallId: "cb", endToolCallId: "ce", interiorChars: 300,
			interiorTokens: 90, measuredModelKey: target, report: "done" });
		const state = createState();
		state.modelCaches[outer] = { cachedUntilPos: base.length, lastUsedAt: now, tokensPerChar: 0.3 };
		const options = { pool: [record], state, base, modelKey: target, now,
			pricing: pricing(1e-6, 10e-6, null), outerModels: [{ key: outer, pricing: pricing(5e-6, 50e-6, null) }] };
		expect(shouldFoldPool(options).fold).toBe(false);
		state.modelCaches[outer].lastUsedAt = now - 300_001;
		expect(shouldFoldPool(options).fold).toBe(true);
	});

	test("measureScopeInterior uses the strict open interval", () => {
		const request = "x".repeat(1000);
		const base = [
			assistant([call("bg", "scope", { begin: {} })], 1),
			toolResult("bg", "scope", finishedReport("a"), false),
			assistant([call("rd", "read", { path: "x" })], 2),
			toolResult("rd", "read", "interior body", false),
			{ role: "user", content: request },
			assistant([call("ed", "scope", { end: true })], 3),
			toolResult("ed", "scope", "Scope closed.", false),
		];
		const measured = measureScopeInterior(base, "bg", "ed", []);
		const withoutRequest = measureScopeInterior(base.filter((message) => message.role !== "user"), "bg", "ed", []);
		const record = (interior) => RECORD({ ...interior, interiorTokens: undefined, report: "a" });
		expect(measured.interiorChars - withoutRequest.interiorChars).toBe(request.length);
		expect(netRemovableTokens(record(measured), 1)).toBe(netRemovableTokens(record(withoutRequest), 1));
	});

	test("90% emergency folds on the economics gate", () => {
		const decision = shouldFoldPool({
			pool: [RECORD()],
			state: { epoch: 0 },
			base: [],
			budget: { read: 1 },
			pricing: pricing(1e-6, 10e-6, 100000),
			contextTokens: 91000,
			emergency: true,
			tokensPerChar: 0.3,
		});
		expect(decision.fold).toBe(true);
		expect(decision.reason).toBe("watermark");
	});

	test("rebaseBaselines shifts younger scopes but not the folded ancestor", () => {
		const state = createState();
		const scope = (id, baseModelKey = "fixture/current") => ({ id, baseInputTokens: 5000, baseModelKey });
		state.scopes = [scope("scope-1"), scope("scope-9"), scope("scope-10", null)];
		const station = { state, lastTotalInput: 6000, lastUsageModelKey: "fixture/current" };
		const { rebaseBaselines } = stationForRebase();
		rebaseBaselines.call(station, { savedTokens: 1000, maxOrder: 4 });
		expect(state.scopes[0].baseInputTokens).toBe(5000);
		expect(state.scopes[1].baseInputTokens).toBe(4000);
		expect(state.scopes[2].baseInputTokens).toBe(5000);
		expect(station.lastTotalInput).toBe(5000);
	});

	// Pull the real method off a station so the test exercises production code.
	function stationForRebase() {
		const fakeManager = makeManager();
		return { rebaseBaselines: makeStation(fakeManager).rebaseBaselines };
	}

	function makeStation(manager) {
		const { SessionStation } = requireSessionStation();
		return new SessionStation(manager, {}, {}, null, null);
	}

	function requireSessionStation() {
		// ESM Static import already resolves this; keep a local alias for clarity.
		return { SessionStation: StationClass };
	}
});

import { SessionStation as StationClass } from "../src/station/station.mjs";
