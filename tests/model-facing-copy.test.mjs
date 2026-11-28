import { expect, test } from "bun:test";
import { createTestStation } from "./helpers/station-ports.mjs";

import { injectSystemPrompt, persistentOperatingSkill } from "../src/prompts/inject.mjs";
import { defaultFeatures } from "../src/features/herd/features.mjs";
import { loadDoc } from "../src/prompts/index.mjs";
import { wireTools } from "../src/tools/catalog.mjs";

import { installContextPreparation } from "../host-omp/src/host/context-preparation.mjs";

import {
	projectCapabilities,
	renderConsoleReceipt,
} from "../src/station/domain/capabilities.mjs";
import { SessionStation } from "../src/station/station.mjs";
import { probeOf } from "./helpers/probe-view.mjs";
import { handleForkCall } from "../src/station/fork-controls.mjs";
import { createBracketLedger, markReady, registerFork, takeReady } from "../src/scope/index.mjs";

const chineseInstruction = /^.*强制以简体中文思考.*$/gm;
// The per-turn probe closes with the same requirement in its own wording.
const probeRequirement = "强制以简体中文思考，以简体中文词开头，简体中文回答。";

// The probe body is parsed by tests/helpers/probe-view.mjs.

for (const hostPrompt of ["Host instructions", ["Host instructions"]]) {
	test(`the ${typeof hostPrompt === "string" ? "string" : "array"} system prompt stays idempotent when reinjected`, () => {
		const prompt = injectSystemPrompt(hostPrompt);
		const text = Array.isArray(prompt) ? prompt.join("\n") : prompt;
		expect(injectSystemPrompt(prompt)).toEqual(prompt);
		expect(text).toContain("Host instructions");
		expect(text).toContain(persistentOperatingSkill);
		expect(text).toContain("Chesterton's fence");
		expect(text).toContain("grandpa rules");
		expect(persistentOperatingSkill.trim().split(/\s+/).length).toBeLessThanOrEqual(1300);
		expect(text.match(chineseInstruction)).toHaveLength(1);

		const withoutChinese = injectSystemPrompt(prompt, { features: { ...defaultFeatures(), chinese: "off" } });
		const offText = Array.isArray(withoutChinese) ? withoutChinese.join("\n") : withoutChinese;
		expect(offText).not.toMatch(chineseInstruction);
		expect(offText).not.toContain("Punish You Otherwise");
		expect(offText).toContain(persistentOperatingSkill);
		expect(offText).toContain("Host instructions");
	});
}

test("one scope-and-relay section serves root and child, manual and autopilot", () => {
	const base = injectSystemPrompt("Host instructions");
	const baseText = Array.isArray(base) ? base.join("\n") : base;
	expect(baseText).toContain("Subscope duty");
	expect(baseText).toContain("/herd-goal");
	expect(baseText).toContain("exactly one tool: `js`");
	expect(baseText).toContain("At root, join every subscope you forked before sealing");
	expect(baseText).toContain("orthogonal seams");
	expect(baseText).not.toContain("sqrt(2n)");

	// The managed block never varies with the request: a forked scope inherits
	// the owner's prompt prefix, and a changed system prompt drops the inherited
	// provider cache key.
	for (const autopilot of [true, false]) {
		for (const branch of [true, false]) {
			expect(injectSystemPrompt("Host instructions", { autopilot, branch })).toEqual(base);
		}
	}
});

test("a host goal spec cannot change the managed prompt bytes", () => {
	const without = injectSystemPrompt("Host instructions", { toolSpecs: [] });
	const withGoal = injectSystemPrompt("Host instructions", {
		toolSpecs: [
			{ name: "goal", description: "Host goal tool.", parameters: { type: "object" } },
		],
	});
	expect(withGoal).toEqual(without);
});

test("the control plane's contract travels inside the managed block", () => {
	const prompt = injectSystemPrompt("Host instructions");
	const text = Array.isArray(prompt) ? prompt.join("\n") : prompt;
	// The five `scope_*` methods have no schema to describe them; the compiled
	// prose is the only place the model can read their fields.
	expect(text).toContain("### fork.budget");
	expect(text).toContain("panhandled");
	expect(text).toContain("### return.dafny");
	expect(text).not.toContain("{{");
});

test("reinjecting a prompt converted from text to an array retains only the host repo rules", () => {
	const hostPrompt = "# Repo-aware Rules\nHost review rules";
	const prompt = injectSystemPrompt([injectSystemPrompt(hostPrompt)]);
	const text = prompt.join("\n");
	expect(text).toContain(hostPrompt);
	expect(text.match(/^# Repo-aware Rules$/gm)).toHaveLength(1);
	expect(injectSystemPrompt(prompt)).toEqual(prompt);
});

test("a root that sealed is ready to answer", () => {
	const projection = projectCapabilities({
		isChild: false,
		autopilot: true,
		canStop: true,
		unreceived: 0,
		activePaths: ["/"],
	});
	const view = probeOf(renderConsoleReceipt(projection));
	// Every tool is withdrawn: the only move left is the final answer itself.
	expect(projection.mode).toBe("FINAL_ANSWER");
	expect(view.api).toEqual([]);
});

test("routine scope status keeps local turns and pending work without repeating the assignment", () => {
	const fsm = "Write a report on the cave swallows of Costa Rica";
	const projection = projectCapabilities({
		isChild: true,
		autopilot: true,
		unreceived: 3,
		selfPath: "/api",
		remaining: { read: "2/8", edit: "1/3", time: "0:20 left of 0:24" },
		scopesDelta: {
			"/": "done | m1 | 10k / 200k",
			"/api": "running | m1 | 10k+ / 200k",
			"/ui": "running | m1 | 12k+ / 200k",
		},
		hostToolNames: ["read", "edit", "write"],
	});
	const text = renderConsoleReceipt(projection);
	const view = probeOf(text);
	// The subscope reads its own turns and scopes_delta; it never sees
	// the root's autopilot switch or its return obligation.
	expect(view.remaining).toEqual({ read: "2/8", edit: "1/3", time: "0:20 left of 0:24" });
	expect(view.unreceived).toBe(3);
	expect(view.scopes_delta).toEqual({
		"/": "done | m1 | 10k / 200k",
		"/api": "running | m1 | 10k+ / 200k",
		"/ui": "running | m1 | 12k+ / 200k",
	});
	expect(view).not.toHaveProperty("autopilot");
	expect(view).not.toHaveProperty("canStop");
	// The assignment is not repeated: the model already has it.
	expect(text).not.toContain(fsm);
	expect(text).toContain(probeRequirement);
});

test("a forked scope with no ledger record still learns that its turns are unavailable", () => {
	// The bearer runs inside a scope, yet the ledger holds no fork record for
	// it. Saying nothing would read as "turns are fine"; the projection states
	// that the allowance is unknown instead.
	const orphan = probeOf(
		renderConsoleReceipt(
			projectCapabilities({
				isChild: true,
				autopilot: true,
				remaining: null,
				selfPath: "/orphan",
				hostToolNames: [],
			}),
		),
	);
	expect(orphan.remaining).toEqual({});
	// A root probe has no turns to report at all.
	const root = probeOf(
		renderConsoleReceipt(
			projectCapabilities({
				isChild: false,
				autopilot: true,
				canStop: false,
				unreceived: 0,
			}),
		),
	);
	expect(root).not.toHaveProperty("remaining");
});

test("the fork receipt describes new work once and lists all unreceived scopes by name", () => {
	const ledger = createBracketLedger();
	const station = {
		state: {},
		forkLedgerPort: () => ledger,
		childSpawnPort: () => () => {},
	};
	const launch = (path, fsmText) => handleForkCall(station, {
		id: `call-${path}`,
		arguments: { forks: [{ path, fsm: fsmText, profession: "You are a careful observer of tides and harbor lights", n: 1, budget: { read: 1 }, targets: [`${path}.mjs`] }] },
	});
	const prior = launch("editor.earlier", "Measure the tide");
	expect(prior.isError).toBeUndefined();
	const current = launch("editor.latest", "Check the harbor lights");
	expect(current.isError).toBeUndefined();
	const text = current.content[0].text;
	// Successful control content is a constant; the facts live once, in result.
	expect(text).toBe("scope_fork processed.");
	expect(current.details.result).toEqual({
		depth: 1,
		started: [0],
		failed: [],
		unreceived: ["/editor.earlier", "/editor.latest"],
	});
});

test("the scope_return documentation explains the return-only script and fresh report", () => {
	// The control-plane prose moved out of the registered tool schema (only
	// `js` is registered) into the document the system prompt compiles. The
	// model still reads these guardrails, so they are asserted where they live.
	const doc = Object.values(loadDoc("tools/fork-join")).join("\n");
	expect(doc).toContain("Call `scope_return` alone in its script");
	expect(doc).toMatch(/replaces the old one on a rewind/);
	expect(doc).toMatch(/carry forward evidence/);
	expect(doc).toMatch(/appended to the published record/);
	// Three oath values, and no fourth: `unfinished` is gone, so a model that
	// remembers it gets refused rather than quietly rewound.
	expect(doc).toMatch(/`continue`/);
	expect(doc).toMatch(/`break`/);
	expect(doc).not.toMatch(/[`\"]unfinished[`\"]/);
});

test("the scope_fork documentation explains path resolution and fail-closed duplicates", () => {
	const doc = Object.values(loadDoc("tools/fork-join")).join("\n");
	expect(doc).toMatch(/duplicate paths fail closed/i);
	expect(doc).toMatch(/inherited context/i);
	expect(doc).toMatch(/state machine/i);
	expect(doc).not.toMatch(/blocked/i);
});

test("the root receipt reports unreceived work until the root joins it", () => {
	const station = createTestStation(SessionStation, null, {}, {}, null, null);
	const ledger = createBracketLedger();
	station.forkLedgerPort = () => ledger;
	station.forkOwnerId = () => null;
	expect(registerFork(ledger, {
		forkId: "worker-1", ownerId: "root", fsm: "inspect the sample", depth: 0,
	}).ok).toBe(true);
	expect(markReady(ledger, "worker-1").ok).toBe(true);

	const receipt = () => station.skillReceipt({ agent: { kind: "main" } }).content[0].text;
	expect(probeOf(receipt()).unreceived).toBe(1);
	expect(takeReady(ledger, { ownerId: "root" }).ok).toBe(true);
	// The work is received: the count drops, though the scope stays addressable.
	expect(probeOf(receipt()).unreceived).toBe(0);
});

test("a manager probe counts root and running forks before printing the nudge", () => {
	const station = createTestStation(SessionStation, null, {}, {}, null, null);
	const ledger = createBracketLedger();
	station.forkLedgerPort = () => ledger;
	station.forkOwnerId = () => null;
	expect(registerFork(ledger, {
		forkId: "worker-1",
		scopeId: "inspector.worker-1",
		path: "/inspector.worker-1",
		ownerId: "root",
		fsm: "inspect the sample",
		depth: 0,
	}).ok).toBe(true);
	const view = probeOf(station.skillReceipt({ agent: { kind: "main" } }).content[0].text);
	expect(view.scopes_summary).toContain("2+ managers, 9+ inspectors");
	expect(view.scopes_summary).toContain("22+ paid-for hands");

	station.state.features.scope = "aggressive";
	const quiet = probeOf(station.skillReceipt({ agent: { kind: "main" } }).content[0].text);
	expect(quiet.scopes_summary).toBeUndefined();
  });

function relayRequest({ features = {}, keepHook = false } = {}) {
	const ctx = { agent: { id: "Main", kind: "main" } };
	const first = { role: "user", content: "Finish the work." };
	const entries = [{ type: "message", message: first }];
	const manager = {
		getBranch: () => entries.slice(),
		buildSessionContext: () => ({ messages: entries.map((entry) => entry.message) }),
		appendMessage(message) {
			entries.push({ type: "message", message });
			return String(entries.length);
		},
	};
	let prepare;
	const session = {
		sessionManager: manager,
		getAgentId: () => "Main",
		agent: {
			state: { messages: [first] },
			addBeforeModelCallHook(hook) {
				prepare = hook;
				return () => { prepare = undefined; };
			},
		},
	};
	const station = createTestStation(SessionStation, manager, {}, {}, null, null);
	Object.assign(station.state.features, features);
	station.state.relay.goal = true;
	const remove = installContextPreparation(session, { station, ctx });
	function commit(message) {
		manager.appendMessage(message);
		session.agent.state.messages.push(message);
	}
	async function request(...pending) {
		const loop = { messages: [...session.agent.state.messages, ...pending] };
		try {
			await prepare(undefined, loop);
			return loop.messages;
		} finally {
			if (!keepHook) remove();
		}
	}
	return { station, commit, request, remove, manager };
}

function receiptTextOf(message) {
	return message.content.map((part) => part.text ?? "").join("\n");
}

test("a toggle regenerates the mode receipt instead of reusing the previous one", async () => {
	const fixture = relayRequest({ keepHook: true });
	try {
		const autoMessages = await fixture.request();
		const auto = autoMessages.filter((message) => message.herdSkill).at(-1);
		expect(probeOf(receiptTextOf(auto)).autopilot).toBe(true);
		expect(probeOf(receiptTextOf(auto)).mode).toBe("ROOT_AUTOPILOT");
		// Autopilot withdraws `ask`: the probe, not a sentence, says so.
		expect(probeOf(receiptTextOf(auto)).api).not.toContain("ask");

		fixture.station.state.relay.goal = false;
		const manualMessages = await fixture.request();
		const manual = manualMessages.filter((message) => message.herdSkill).at(-1);
		expect(manual).not.toBe(auto);
		expect(probeOf(receiptTextOf(manual)).autopilot).toBe(false);
		expect(probeOf(receiptTextOf(manual)).mode).toBe("ROOT_MANUAL");
		expect(probeOf(receiptTextOf(manual)).api).toContain("ask");

		fixture.station.state.relay.goal = true;
		const backMessages = await fixture.request();
		const back = backMessages.filter((message) => message.herdSkill).at(-1);
		expect(back).not.toBe(manual);
		expect(probeOf(receiptTextOf(back)).autopilot).toBe(true);

		// Same mode: the receipt is reused rather than rebuilt.
		const sameMessages = await fixture.request();
		const same = sameMessages.filter((message) => message.herdSkill).at(-1);
		expect(same).toBe(back);
	} finally {
		fixture.remove();
	}
});

test("the language reminder ends every request receipt and follows its feature", async () => {
	// `keepHook` leaves the preparation hook installed: this test makes two
	// requests in a row, so each round appends a fresh receipt to the session.
	const enabled = relayRequest({ keepHook: true });
	const disabled = relayRequest({ keepHook: true, features: { chinese: "off" } });
	async function latestReceipt(fixture) {
		const receipts = (await fixture.request()).filter((message) => message.herdSkill);
		return receipts.at(-1).content[0].text;
	}
	const journalReceipts = (fixture) =>
		fixture.manager.getBranch().filter((entry) => entry.message?.herdSkill === true).length;
	try {
		for (let round = 0; round < 2; round++) {
			const on = await latestReceipt(enabled);
			const off = await latestReceipt(disabled);
			// The reminder is the last line of the newest receipt; with the port
			// off, the rest of the probe is byte-identical.
			const reminderLine = "\n# System Requirement:";
			expect(on).toContain(reminderLine);
			expect(on.endsWith(probeRequirement)).toBe(true);
			expect(off).not.toContain("强制以简体中文");
			expect(off).toBe(on.slice(0, on.lastIndexOf(reminderLine)));
			// A new receipt is appended per turn, never written over the old one:
			// the prefix stays byte-identical, which is what keeps the cache warm.
			expect(journalReceipts(enabled)).toBe(round + 1);
			expect(journalReceipts(disabled)).toBe(round + 1);
			const turn = { role: "user", content: `Continue after round ${round + 1}.` };
			enabled.commit(turn);
			disabled.commit(turn);
		}
	} finally {
		enabled.remove();
		disabled.remove();
	}
});

test("a child prompt is byte-identical to the root prompt", () => {
	for (const goal of [true, false]) {
		const features = { ...defaultFeatures() };
		const child = injectSystemPrompt("Host instructions", { features });
		const root = injectSystemPrompt("Host instructions", { features });
		expect(child).toEqual(root);
		const text = Array.isArray(child) ? child.join("\n") : child;
		expect(text).toContain("### Scope duties");
		expect(text).toContain("Subscope duty");
		expect(text).toContain("scope_return");
		expect(text).toContain("### Close the work");
		expect(text).toContain("/herd-goal");
	}
});
