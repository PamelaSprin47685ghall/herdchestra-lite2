#!/usr/bin/env bun
/**
 * Relay smoke: drives the tools that `activate()` registers, against the real
 * station, in one fresh process.
 *
 * The unit suite proves the relay's own transitions. This script proves what a
 * session actually reads: the `RELAY STATE` text a tool returns, and the gate
 * the `scope` tool applies. It fails when
 *
 *   - the build is stale: the status text carries no `Flow:` line, or
 *   - simple mode gates `direct-execution`, or
 *   - the full flow does not gate it, or
 *   - an empty ledger stops reading as a relay handoff, or
 *   - the successor's first empty ledger does not end the flow.
 *
 *   bun scripts/smoke-relay.mjs
 *
 * Exit code 0 means every check held; 1 means the build or the switch drifted.
 * A session that prints no `Flow:` line runs a stale installed copy: run
 * `bun run sync:plugin` and restart before trusting that session.
 */

import { activate } from "../src/main.mjs";
import { stateFor } from "../src/station/index.mjs";
import { beginGenerationAfterHandoff } from "../src/relay/ledger.mjs";
import { beginScope } from "../src/scope/index.mjs";

function memoryManager() {
	const entries = [];
	let nextId = 1;
	return {
		entries,
		appendMessage(message) {
			entries.push({ type: "message", id: `e${nextId++}`, message });
		},
		appendCustomEntry(customType, data) {
			entries.push({ type: "custom", customType, data, id: `e${nextId++}` });
		},
		getBranch() {
			return entries.slice();
		},
		buildSessionContext() {
			return {
				messages: entries.filter((entry) => entry.type === "message").map((entry) => entry.message),
			};
		},
	};
}

function fakeHost() {
	const handlers = new Map();
	const tools = new Map();
	return {
		tools,
		pi: {
			on(event, handler) {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event).push(handler);
			},
			registerTool(definition) {
				tools.set(definition.name, definition);
			},
			registerCommand() {},
			getSession() {
				return null;
			},
			ui: { notify() {} },
		},
	};
}

/** The native todo implementation, kept to the fields the station reads. */
function nativeTodo() {
	let phases = [];
	return {
		execute(params = {}) {
			const op = params.op ?? (Array.isArray(params.list) ? "init" : "view");
			if (op === "init") {
				phases = (params.list ?? []).map((phase) => ({
					phase: phase.phase,
					items: [...(phase.items ?? [])],
				}));
			}
			return {
				content: [{ type: "text", text: "native todo" }],
				details: { op, phases: structuredClone(phases) },
			};
		},
	};
}

const host = fakeHost();
await activate(host.pi);

const manager = memoryManager();
const native = nativeTodo();
const ctx = {
	sessionManager: manager,
	agentMessages: [],
	invokeTool: (params) => native.execute(params),
	// A fission begin refuses to start without a host abort path.
	abort() {},
};
const station = stateFor(ctx);

/**
 * The smallest scheduler port that lets a `scope({ begin })` call succeed.
 *
 * This fake host spawns no flows, so the port opens the batch scope itself and
 * reports a registered batch. `retireOwner` keeps the owner alive instead of
 * aborting it, because the smoke drives the tools directly and never runs a
 * turn to abort. `handleFissionBegin` sets `station.pendingFission` after
 * `registerBatch` returns, and `call()` below clears that descriptor, since a
 * batch that never starts must not refuse the next begin.
 */
const scheduler = {
	registerBatch(request) {
		const opened = beginScope(request.station.state, {
			toolCallId: request.toolCallId,
			intent: "smoke batch",
			stage: request.stage,
			budget: { ...request.totals },
			time: request.begin?.time,
		});
		if (!opened.ok) {
			return { ok: false, code: opened.code, reason: opened.reason };
		}
		return {
			ok: true,
			batchId: "smoke-batch",
			batch: { id: "smoke-batch" },
			batchBeginId: "smoke-begin",
		};
	},
	cancelBatch() {},
	retireOwner() {
		return { ok: true, abort: false };
	},
};
station.registry?.setFissionScheduler?.(scheduler);

let callSeq = 0;

async function call(name, args) {
	const id = `smoke-${++callSeq}`;
	const tool = host.tools.get(name);
	if (!tool) throw new Error(`${name} is not registered`);
	const output = await tool.execute(id, args, undefined, undefined, ctx);
	// A batch registered here never spawns a flow, so its pending descriptor is
	// spent as soon as the call returns.
	if (name === "scope" && args?.begin) station.pendingFission = null;
	return {
		text: (output.content ?? []).map((part) => part.text ?? "").join(""),
		code: output.details?.code,
		isError: output.isError === true,
	};
}

const results = [];
async function check(name, run) {
	try {
		await run();
		results.push({ name, status: "PASS" });
	} catch (error) {
		results.push({ name, status: "FAIL", note: error?.message ?? String(error) });
	}
}

function expect(condition, message) {
	if (!condition) throw new Error(message);
}

function expectLine(text, line, name) {
	expect(text.includes(line), `${name}: missing ${JSON.stringify(line)} in:\n${text}`);
}

const S5 = {
	begin: {
		stage: "direct-execution",
		elder_report: null,
		time: 60,
		fission: [{ intent: "smoke", budget: { read: 1 }, permission: "rw" }],
	},
};

await check("status names the flow before any ledger", async () => {
	const view = await call("todo", { op: "view" });
	expectLine(view.text, "Flow: simple", "view");
	expectLine(view.text, "Can stop now: no", "view");
	expect(!view.isError, "view reported an error");
});

await check("simple mode opens direct-execution without a ledger", async () => {
	const opened = await call("scope", S5);
	expect(!/^(STAGE_FLAGS_UNMET|RW_BEFORE_LEDGER)/.test(opened.text), `refused: ${opened.text.split("\n")[0]}`);
	const closed = await call("scope", { end: true });
	expect(!closed.isError, `close refused: ${closed.text.split("\n")[0]}`);
});

await check("a non-empty ledger turns the full flow on", async () => {
	const wrote = await call("todo", { op: "init", list: [{ phase: "work", items: ["A"] }] });
	expectLine(wrote.text, "Flow: full flow", "init");
	expect(station.state.relay.fullFlow, "relay.fullFlow did not turn on");
});

await check("the full flow gates direct-execution", async () => {
	const refused = await call("scope", S5);
	expect(refused.code === "STAGE_FLAGS_UNMET", `expected STAGE_FLAGS_UNMET, got ${refused.code ?? refused.text.split("\n")[0]}`);
});

await check("an empty ledger arms a relay handoff", async () => {
	const emptied = await call("todo", { op: "init", list: [] });
	expectLine(emptied.text, "Handoff pending: yes", "empty ledger");
	expectLine(emptied.text, "Flow: full flow", "empty ledger");
	expectLine(emptied.text, "Can stop now: no", "empty ledger");
});

await check("the successor's first empty ledger ends the flow", async () => {
	station.state.relay = beginGenerationAfterHandoff(station.state.relay, { at: 2 });
	const promoted = await call("todo", { op: "init", list: [] });
	expectLine(promoted.text, "Can stop now: yes", "promotion");
	expectLine(promoted.text, "Flow: simple", "promotion");
	expect(!station.state.relay.fullFlow, "the promoted relay kept the full flow on");
});

await check("the promoted session opens direct-execution again", async () => {
	const opened = await call("scope", S5);
	expect(!/^(STAGE_FLAGS_UNMET|RW_BEFORE_LEDGER)/.test(opened.text), `refused: ${opened.text.split("\n")[0]}`);
	const closed = await call("scope", { end: true });
	expect(!closed.isError, `close refused: ${closed.text.split("\n")[0]}`);
});

await check("a write after promotion turns the full flow on again", async () => {
	const wrote = await call("todo", { op: "init", list: [{ phase: "next", items: ["B"] }] });
	expectLine(wrote.text, "Flow: full flow", "reopen");
	expectLine(wrote.text, "Promotion invalidated: yes", "reopen");
	const refused = await call("scope", S5);
	expect(refused.code === "STAGE_FLAGS_UNMET", `expected STAGE_FLAGS_UNMET, got ${refused.code ?? refused.text.split("\n")[0]}`);
});

let failed = 0;
for (const result of results) {
	const note = result.note ? `  ${result.note}` : "";
	console.log(`${result.status}  ${result.name}${note}`);
	if (result.status === "FAIL") failed += 1;
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
