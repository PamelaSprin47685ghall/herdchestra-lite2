/**
 * Folding economics and the new scope contract (end:true + elder_report).
 * Real hooks against a fake host with the same tree semantics as omp.
 */

import { describe, expect, test } from "bun:test";
import { activate } from "../src/main.mjs";
import { stateFor, stationFor } from "../src/station/index.mjs";
import {
	finishedReport,
} from "../src/transcript/index.mjs";
import {
	measureScopeInterior,
	netRemovableTokens,
	shouldFoldPool,
	sliceChars,
} from "../src/station/fold.mjs";
import { createEmptyCatalog, resolveModelPolicy } from "../src/host/pricing.mjs";
import { charsToTokens } from "../src/host/pricing.mjs";
import { createState, findPendingReportElder } from "../src/scope/index.mjs";

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
	test("measureScopeInterior uses the strict open interval", () => {
		const base = [
			assistant([call("bg", "scope", { begin: {} })], 1),
			toolResult("bg", "scope", finishedReport("a"), false),
			assistant([call("rd", "read", { path: "x" })], 2),
			toolResult("rd", "read", "interior body", false),
			assistant([call("ed", "scope", { end: true })], 3),
			toolResult("ed", "scope", "Scope closed.", false),
		];
		const measured = measureScopeInterior(base, "bg", "ed", []);
		expect(measured.interiorChars).toBeGreaterThan(0);
		expect(measured.interiorChars).toBeGreaterThanOrEqual(sliceChars(base.slice(3, 4)));
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
		const scope = (id) => ({ id, baseInputTokens: 5000 });
		state.scopes = [scope("scope-1"), scope("scope-9")];
		const station = { state, lastTotalInput: 6000 };
		const { rebaseBaselines } = stationForRebase();
		rebaseBaselines.call(station, { savedTokens: 1000, maxOrder: 4 });
		expect(state.scopes[0].baseInputTokens).toBe(5000);
		expect(state.scopes[1].baseInputTokens).toBe(4000);
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
