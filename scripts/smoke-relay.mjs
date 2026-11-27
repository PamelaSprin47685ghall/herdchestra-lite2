#!/usr/bin/env bun
/**
 * Relay smoke: drives the registered tools and host lifecycle hooks against the
 * real station and activation wiring in one fresh process.
 *
 * Proves:
 * - The extension registers exactly one tool, `js`; no native `todo` and no
 *   retired scope tool is registered alongside it.
 * - Through `js`, the scope protocol keeps its contracts: `scope_fork` without
 *   a spawner is refused, `scope_join` on an idle root is refused, and the
 *   `scope_return` oath is validated strictly.
 * - `scope_return` enforces the strict oath contract, supports small rewind and
 *   two-consecutive-oath promotion at Root, resets the streak on a small handoff
 *   or new fork, blocks Root big oath while children are unreceived, and preserves
 *   verbatim user prompts & steers across `agent_end` Root rewind + resume.
 *
 *   bun scripts/smoke-relay.mjs
 */

import { activate } from "../host-omp/src/main.mjs";
import { RETURN_OATH_KEY, RETURN_OATH_UNFINISHED, RETURN_OATH_VALUE } from "../src/station/domain/handoff.mjs";

const OATH = { [RETURN_OATH_KEY]: RETURN_OATH_VALUE };
const SMALL = { [RETURN_OATH_KEY]: RETURN_OATH_UNFINISHED };

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
		appendCompaction(summary, _short, firstKeptEntryId, tokensBefore, details) {
			const id = `c${nextId++}`;
			entries.push({ type: "compaction", id, parentId: leafId, summary, firstKeptEntryId, tokensBefore, details });
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
			const compaction = entries[lastCompaction];
			const keepId = compaction.firstKeptEntryId ?? "";
			const retainedStart = keepId
				? entries.findIndex((entry, index) => index < lastCompaction && entry.id === keepId)
				: -1;
			const messages = [{ role: "compactionSummary", summary: compaction.summary }];
			if (retainedStart >= 0) {
				for (let i = retainedStart; i < lastCompaction; i += 1) {
					if (entries[i].type === "message") messages.push(entries[i].message);
				}
			}
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
station.state.features.autopilot = "on";

let callSeq = 0;

async function callJs(code, inputs, targetCtx = ctx) {
	const id = `smoke-${++callSeq}`;
	const tool = host.tools.get("js");
	if (!tool) throw new Error("js is not registered");
	const output = await tool.execute(id, { code, inputs }, undefined, undefined, targetCtx);
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

await check("registers exactly one tool, js, and nothing retired", async () => {
	expect(host.tools.has("js"), "js is not registered");
	for (const name of ["scope_fork", "scope_join", "scope_return", "scope_abandon", "scope_request", "scope_reply", "scope_send", "scope_ask", "scope_context", "pin", "amend", "todo", "scope"]) {
		expect(!host.tools.has(name), `${name} should not be registered as a tool`);
	}
});

await check("scope_fork refuses without a child spawner", async () => {
	const out = await callJs(
		"await api.scope_fork(inputs.spec)",
		{
			spec: {
				forks: [
					{
						path: "inspector.probe",
						fsm: "probe",
						profession: "You are a probe engineer.",
						n: 1,
						budget: { read: 1 },
						targets: ["src/probe.mjs"],
					},
				],
			},
		},
		bareCtx,
	);
	expect(out.isError, "scope_fork should report the missing spawner");
	expect(out.text.includes("CHILD_SPAWNER_UNAVAILABLE"), `got ${out.text.split("\n")[1] ?? out.text}`);
});

await check("scope_join refuses an idle root", async () => {
	const out = await callJs("await api.scope_join()", undefined, bareCtx);
	expect(out.isError, "scope_join should refuse an idle branch");
	expect(out.text.includes("NO_UNRECEIVED_WORK"), `got ${out.text.split("\n")[1] ?? out.text}`);
});

await check("scope_return refuses non-matching oath values strictly", async () => {
	const out = await callJs("await api.scope_return(inputs.args)", {
		args: { dafny: "trying boolean false", [RETURN_OATH_KEY]: false },
	});
	expect(out.isError, "boolean oath must be rejected");
	expect(out.text.includes("INVALID_RETURN_OATH"), `got ${out.text.split("\n")[1] ?? out.text}`);
});

await check("root small handoff rewinds via agent_end ticket preserving verbatim user prompt", async () => {
	const out = await callJs("await api.scope_return(inputs.args)", { args: { dafny: "gen 0 progress", ...SMALL } });
	expect(!out.isError, `small handoff failed: ${out.text}`);
	expect(out.details?.rewind === true && out.details?.stopLoop === true, "expected rewind + stopLoop");
	expect(station.state.relay.generation === 1, `expected gen 1, got ${station.state.relay.generation}`);
	expect(station.state.relay.canStop === false, "small handoff must keep root open");
	for (const handler of host.handlers.get("agent_end") ?? []) {
		handler({ messages: manager.buildSessionContext().messages }, ctx);
	}
	await new Promise((resolve) => setTimeout(resolve, 10));
	const branch = manager.getBranch();
	const compactAt = branch.findLastIndex((entry) => entry.type === "compaction");
	const compaction = branch[compactAt];
	const restored = branch[compactAt - 1];
	expect(
		restored?.type === "message" && restored.message?.attribution === "user",
		"restored user must precede the compaction record",
	);
	expect(restored.message.content?.[0]?.text === "Ship the refactor cleanly.", "restored user text lost");
	expect(compaction.firstKeptEntryId === restored.id, "firstKeptEntryId must point at the first restored user");
	const rebuilt = manager.buildSessionContext().messages;
	expect(rebuilt[0]?.role === "compactionSummary", "compaction summary missing");
	expect(rebuilt[0].summary.includes("gen 0 progress"), "report missing from summary");
	expect(rebuilt[1]?.role === "user" && rebuilt[1].content?.[0]?.text === "Ship the refactor cleanly.", "user prompt lost");
	expect(prompts.length === 1 && prompts[0].options?.synthetic === true, "reborn start prompt did not dispatch");
});

  await check("root seal promotes on the first oath without a rewind", async () => {
  	const sealed = await callJs("await api.scope_return(inputs.args)", { args: { dafny: "verified nothing left", ...OATH } });
  	expect(!sealed.isError, `seal failed: ${sealed.text}`);
  	expect(sealed.details?.promoted === true && sealed.details?.stopLoop === false, "expected promotion without stopLoop");
  	expect(station.state.relay.canStop === true, "expected canStop true");
  	expect(station.state.relay.pendingRewind === null, "a seal must not queue a rewind");

  	const stopAfterSeal = (host.handlers.get("session_stop") ?? []).map((h) => h({}, ctx)).find(Boolean);
  	expect(stopAfterSeal === undefined, "session_stop must allow the final stop after a seal");
  });

let failed = 0;
for (const result of results) {
	const note = result.note ? `  ${result.note}` : "";
	console.log(`${result.status}  ${result.name}${note}`);
	if (result.status === "FAIL") failed += 1;
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
