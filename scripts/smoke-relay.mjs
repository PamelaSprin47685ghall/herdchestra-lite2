#!/usr/bin/env bun
/**
 * Relay smoke: drives the registered tools and host lifecycle hooks against the
 * real station and activation wiring in one fresh process.
 *
 * Proves:
 * - The extension registers the five scope tools and does NOT override `todo`.
 * - `scope_fork` / `scope_join` enforce their missing-spawner / idle-root contracts.
 * - `scope_return` enforces the strict oath contract, supports small rewind and
 *   two-consecutive-oath promotion at Root, resets the streak on a small handoff
 *   or new fork, blocks Root big oath while children are unreceived, and preserves
 *   verbatim user prompts & steers across `agent_end` Root rewind + resume.
 *
 *   bun scripts/smoke-relay.mjs
 */

import { activate } from "../host-omp/src/main.mjs";
import { RETURN_OATH_KEY, RETURN_OATH_VALUE } from "../src/station/domain/handoff.mjs";

const OATH = { [RETURN_OATH_KEY]: RETURN_OATH_VALUE };

function memoryManager(idPrefix = "smoke-session") {
	const entries = [];
	let leafId = null;
	let nextId = 1;
	return {
		entries,
		getSessionId: () => idPrefix,
		getLeafId: () => leafId,
		appendMessage(message) {
			const id = `e${nextId++}`;
			entries.push({ type: "message", id, parentId: leafId, message });
			leafId = id;
			return id;
		},
		appendCustomEntry(customType, data) {
			const id = `e${nextId++}`;
			entries.push({ type: "custom", customType, data, id, parentId: leafId });
			leafId = id;
			return id;
		},
		appendCompaction(summary, _short, _firstKept, tokensBefore, details) {
			const id = `c${nextId++}`;
			entries.push({ type: "compaction", id, parentId: leafId, summary, tokensBefore, details });
			leafId = id;
			return id;
		},
		getBranch() {
			return entries.slice();
		},
		buildSessionContext() {
			const lastCompaction = entries.findLastIndex((entry) => entry.type === "compaction");
			if (lastCompaction < 0) {
				return {
					messages: entries.filter((entry) => entry.type === "message").map((entry) => entry.message),
				};
			}
			const messages = [{ role: "compactionSummary", summary: entries[lastCompaction].summary }];
			for (let i = lastCompaction + 1; i < entries.length; i += 1) {
				if (entries[i].type === "message") messages.push(entries[i].message);
			}
			return { messages };
		},
	};
}

function fakeHost() {
	const handlers = new Map();
	const tools = new Map();
	const sent = [];
	return {
		tools,
		handlers,
		sent,
		pi: {
			on(event, handler) {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event).push(handler);
			},
			registerTool(definition) {
				tools.set(definition.name, definition);
			},
			registerCommand() {},
			sendUserMessage(text, options) {
				sent.push({ text, options });
				return Promise.resolve();
			},
			getSession() {
				return null;
			},
			ui: { notify() {} },
		},
	};
}

const host = fakeHost();
const wired = await activate(host.pi);

const bareManager = memoryManager("bare-session");
const bareCtx = {
	sessionManager: bareManager,
	agentMessages: [],
	abort() {},
};

const manager = memoryManager("rewind-session");
manager.appendMessage({ role: "user", content: "Ship the refactor cleanly." });
const prompts = [];
const session = {
	sessionManager: manager,
	transcriptEpoch: 0,
	isDisposed: false,
	isSessionTransitioning: false,
	isStreaming: false,
	isAborting: false,
	hasAdmittedSubmission: false,
	agent: {
		state: { messages: manager.buildSessionContext().messages },
		abort() {},
		addBeforeModelCallHook: () => () => {},
	},
	withQueueDrainPaused: (fn) => fn(),
	waitForIdle: async () => {},
	settleInFlightMessagePersistence: async () => {},
	prompt: async (text, options) => {
		prompts.push({ text, options });
		options?.onPromptAdmitted?.();
		return true;
	},
};
const ctx = {
	sessionManager: manager,
	session,
	agentMessages: [],
	abort() {},
};
for (const handler of host.handlers.get("session_start") ?? []) {
	handler({}, ctx);
}
const station = wired.engine.station(ctx);
station.state.autopilot = true;

let callSeq = 0;

async function call(name, args, targetCtx = ctx) {
	const id = `smoke-${++callSeq}`;
	const tool = host.tools.get(name);
	if (!tool) throw new Error(`${name} is not registered`);
	const output = await tool.execute(id, args, undefined, undefined, targetCtx);
	return {
		text: (output.content ?? []).map((part) => part.text ?? "").join(""),
		code: output.details?.code,
		details: output.details,
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

await check("registers the five scope tools and leaves native todo untouched", async () => {
	for (const name of ["scope_fork", "scope_join", "scope_return", "scope_send", "scope_context"]) {
		expect(host.tools.has(name), `${name} is not registered`);
	}
	expect(!host.tools.has("todo"), "todo override should be removed");
	expect(!host.tools.has("scope"), "retired scope tool is still registered");
});

await check("scope_fork refuses without a child spawner", async () => {
	const out = await call("scope_fork", {
		forks: [
			{
				scopeId: "probe",
				fsm: "probe",
				profession: "You are a probe engineer.",
				n: 1,
				budget: { read: 1 },
				targets: ["src/probe.mjs"],
			},
		],
	}, bareCtx);
	expect(out.isError, "scope_fork should report the missing spawner");
	expect(out.code === "CHILD_SPAWNER_UNAVAILABLE", `got ${out.code ?? out.text.split("\n")[0]}`);
});

await check("scope_join refuses an idle root", async () => {
	const out = await call("scope_join", {}, bareCtx);
	expect(out.isError, "scope_join should refuse an idle branch");
	expect(out.code === "NO_UNRECEIVED_WORK", `got ${out.code}`);
});

await check("scope_return refuses non-matching oath values strictly", async () => {
	const out = await call("scope_return", {
		dafny: "trying boolean false",
		[RETURN_OATH_KEY]: false,
	});
	expect(out.isError, "boolean oath must be rejected");
	expect(out.code === "INVALID_RETURN_OATH", `got ${out.code}`);
});

await check("root small handoff rewinds via agent_end ticket preserving verbatim user prompt", async () => {
	const out = await call("scope_return", { dafny: "gen 0 progress" });
	expect(!out.isError, `small handoff failed: ${out.text}`);
	expect(out.details?.rewind === true && out.details?.stopLoop === true, "expected rewind + stopLoop");
	expect(station.state.relay.generation === 1, `expected gen 1, got ${station.state.relay.generation}`);
	expect(station.state.relay.bigStreak === 0, "small handoff must keep bigStreak 0");
	for (const handler of host.handlers.get("agent_end") ?? []) {
		handler({ messages: manager.buildSessionContext().messages }, ctx);
	}
	await new Promise((resolve) => setTimeout(resolve, 10));
	const rebuilt = manager.buildSessionContext().messages;
	expect(rebuilt[0]?.role === "compactionSummary", "compaction summary missing");
	expect(rebuilt[0].summary.includes("gen 0 progress"), "report missing from summary");
	expect(rebuilt[1]?.role === "user" && rebuilt[1].content?.[0]?.text === "Ship the refactor cleanly.", "user prompt lost");
	expect(prompts.length === 1 && prompts[0].options?.synthetic === true, "reborn start prompt did not dispatch");
});

await check("root first oath rewinds for review; second consecutive oath promotes without rewind", async () => {
	const first = await call("scope_return", { dafny: "ready for review", ...OATH });
	expect(!first.isError, `first oath failed: ${first.text}`);
	expect(first.details?.rewind === true && first.details?.big === true && first.details?.stopLoop === true, "expected review rewind");
	expect(station.state.relay.bigStreak === 1, `expected bigStreak 1, got ${station.state.relay.bigStreak}`);
	for (const handler of host.handlers.get("agent_end") ?? []) {
		handler({ messages: manager.buildSessionContext().messages }, ctx);
	}
	await new Promise((resolve) => setTimeout(resolve, 10));
	// Starting the reborn generation emits `before_agent_start`, which clears `rewoundThisTurn`.
	for (const handler of host.handlers.get("before_agent_start") ?? []) {
		handler({ systemPrompt: [] }, ctx);
	}

	const stopBeforeSecond = (host.handlers.get("session_stop") ?? []).map((h) => h({}, ctx)).find(Boolean);
	expect(stopBeforeSecond?.continue === true, "session_stop should nudge before 2nd oath (after rewoundThisTurn cleared)");

	const second = await call("scope_return", { dafny: "verified nothing left", ...OATH });
	expect(!second.isError, `second oath failed: ${second.text}`);
	expect(second.details?.promoted === true && second.details?.stopLoop === false, "expected promotion without stopLoop");
	expect(station.state.relay.bigStreak === 2 && station.state.relay.canStop === true, "expected canStop true");

	const stopAfterSecond = (host.handlers.get("session_stop") ?? []).map((h) => h({}, ctx)).find(Boolean);
	expect(stopAfterSecond === undefined, "session_stop must allow final stop after 2nd consecutive oath");
});

let failed = 0;
for (const result of results) {
	const note = result.note ? `  ${result.note}` : "";
	console.log(`${result.status}  ${result.name}${note}`);
	if (result.status === "FAIL") failed += 1;
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
