import { expect, test } from "bun:test";
import { createTestStation } from "./helpers/station-ports.mjs";

import { injectSystemPrompt, persistentOperatingSkill } from "../src/prompts/inject.mjs";
import { inlinedSkills } from "../src/prompts/skills.mjs";
import { wireTools } from "../src/tools/catalog.mjs";
import { handoffDemand, applyLedgerEvaluation, beginGenerationAfterHandoff, createRelay } from "../src/relay/index.mjs";
import { installContextPreparation } from "../host-omp/src/host/context-preparation.mjs";
import { todoTicket } from "../src/tools/todo.mjs";
import { skillReceiptText } from "../src/station/texts.mjs";
import { SessionStation } from "../src/station/station.mjs";
import { handleForkCall } from "../src/station/fork-controls.mjs";
import { createBracketLedger, markReady, registerFork, takeReady } from "../src/scope/index.mjs";

const chineseInstruction = /^.*强制以简体中文思考.*$/gm;
const chineseRequirement = "强制以简体中文思考，尤其要以简体中文词开头。强制简体中文回答用户。";

for (const hostPrompt of ["Host instructions", ["Host instructions"]]) {
	test(`the ${typeof hostPrompt === "string" ? "string" : "array"} system prompt stays idempotent when reinjected`, () => {
		const prompt = injectSystemPrompt(hostPrompt);
		const text = Array.isArray(prompt) ? prompt.join("\n") : prompt;
		expect(injectSystemPrompt(prompt)).toEqual(prompt);
		expect(text).toContain("Host instructions");
		expect(text).toContain(persistentOperatingSkill);
		expect(text).toContain(
			inlinedSkills.find((skill) => skill.name === "constitution").body,
		);
		expect(persistentOperatingSkill.trim().split(/\s+/).length).toBeLessThanOrEqual(1300);
		expect(text.match(chineseInstruction)).toHaveLength(1);

		const withoutChinese = injectSystemPrompt(prompt, { chineseReminder: "off" });
		const offText = Array.isArray(withoutChinese) ? withoutChinese.join("\n") : withoutChinese;
		expect(offText).not.toMatch(chineseInstruction);
		expect(offText.split("\n").filter(Boolean)).toEqual(
			text.split("\n").filter((line) => line && !line.includes("强制以简体中文思考")),
		);
	});
}

test("the operating rules keep the relay section out of manual duty", () => {
	const manual = injectSystemPrompt("Host instructions", { autopilot: false });
	const manualText = Array.isArray(manual) ? manual.join("\n") : manual;
	expect(manualText).toContain("Autopilot is off by default");
	expect(manualText).not.toContain("Any successful `todo` write");
	expect(manualText).not.toContain("A non-empty root ledger forbids a final reply");

	const auto = injectSystemPrompt("Host instructions", { autopilot: true });
	const autoText = Array.isArray(auto) ? auto.join("\n") : auto;
	expect(autoText).toContain("Only the user toggles autopilot");
	expect(autoText).not.toContain("Autopilot is off by default");
	expect(autoText).toContain("Any successful `todo` write");
	expect(autoText).toContain("A non-empty root ledger forbids a final reply");
});

test("reinjecting a prompt converted from text to an array retains only the host repo rules", () => {
	const hostPrompt = "# Repo-aware Rules\nHost review rules";
	const prompt = injectSystemPrompt([injectSystemPrompt(hostPrompt)]);
	const text = prompt.join("\n");
	expect(text).toContain(hostPrompt);
	expect(text.match(/^# Repo-aware Rules$/gm)).toHaveLength(1);
	expect(injectSystemPrompt(prompt)).toEqual(prompt);
});

test("a promoted successor is ready to answer without reevaluating its ledger", () => {
	const predecessor = applyLedgerEvaluation(createRelay(), []).relay;
	const successor = beginGenerationAfterHandoff(predecessor);
	const promoted = applyLedgerEvaluation(successor, []);
	expect(promoted.relay.canStop).toBe(true);
	const text = skillReceiptText({ autopilot: true, relay: promoted.relay });
	expect(text).toMatch(/ready to answer/i);
	expect(text).not.toMatch(/no ledger|evaluat/i);
});

test("routine scope status keeps local budget and pending work without repeating the assignment", () => {
	const intent = "Write a report on the cave swallows of Costa Rica";
	const state = { autopilot: true, startedAt: 0 };
	const branch = {
		intent,
		remaining: { read: 2, edit: 1 },
		budget: { read: 8, edit: 3 },
		clockPausedAt: 4000,
		deadlineAt: 24000,
		timeBudgetMs: 24000,
	};
	const pending = skillReceiptText(state, true, branch, 3);
	const root = skillReceiptText(state);
	for (const text of [pending, root]) {
		// The reminder is part of the persistent system prompt, not the receipt:
		// repeating it here would say the same thing twice on every request.
		expect(text).not.toContain(chineseRequirement);
		expect(text).not.toMatch(/\bUTC\b|since this session began/);
	}
	// It still ships exactly once in the skill text the system prompt carries.
	expect(persistentOperatingSkill.split(chineseRequirement)).toHaveLength(2);
	expect(pending).not.toContain(intent);
	expect(pending).toMatch(/read\s+2(?:\.00)?\/8(?:\.00)?\b/);
	expect(pending).toMatch(/edit\s+1(?:\.00)?\/3(?:\.00)?\b/);
	expect(pending).toMatch(/\btime\s+0:20\/0:24\b/);
	expect(pending).toMatch(/\b3\s+unreceived child results?\b|\bunreceived child results?:\s*3\b/i);
	expect(pending).toContain("scope_join");
	expect(root).not.toContain("scope_join");
});

test("the fork receipt describes new work once and lists all unreceived scopes by name", () => {
	const ledger = createBracketLedger();
	const station = {
		state: {},
		forkLedgerPort: () => ledger,
		childSpawnPort: () => () => {},
	};
	const launch = (scopeId, intent) => handleForkCall(station, {
		id: `call-${scopeId}`,
		arguments: { forks: [{ scopeId, intent, blocked: false, budget: { read: 1 }, time: 30, targets: [`${scopeId}.mjs`] }] },
	});
	const prior = launch("earlier", "Measure the tide");
	expect(prior.isError).toBeUndefined();
	const current = launch("latest", "Check the harbor lights");
	expect(current.isError).toBeUndefined();
	const text = current.content[0].text;
	expect(text).toContain("latest: Check the harbor lights");
	expect(text.match(/Check the harbor lights/g)).toHaveLength(1);
	expect(text).not.toContain("Measure the tide");
	expect(text).toContain("Unreceived work: earlier, latest.");
});

test("the registered scope_return explains the sealed final receipt and the digest rule", () => {
	const tools = new Map();
	wireTools({ registerTool: (tool) => tools.set(tool.name, tool) }, {});
	const returning = tools.get("scope_return");
	expect(returning.parameters.properties).toEqual({});
	expect(returning.description).toMatch(/(?:last|latest|final)[^.]*receipt[^.]*seal/i);
	expect(returning.description).toContain("bare names of the tools");
	expect(returning.description).not.toContain("elder_report");
});

test("the registered scope_fork reads a repeated scopeId as an amendment", () => {
	const tools = new Map();
	wireTools({ registerTool: (tool) => tools.set(tool.name, tool) }, {});
	const item = tools.get("scope_fork").parameters.properties.forks.items;
	expect(item.properties.scopeId.description).toMatch(/amends? that scope/i);
	expect(item.properties.scopeId.description).toContain("only its owner");
	expect(item.properties.intent.description).toMatch(/next turn boundary/i);
	expect(item.required).not.toContain("intent");
});

test("the root receipt reports unreceived work until the root joins it", () => {
	const station = createTestStation(SessionStation, null, {}, {}, null, null);
	const ledger = createBracketLedger();
	station.forkLedgerPort = () => ledger;
	station.forkOwnerId = () => null;
	expect(registerFork(ledger, {
		forkId: "worker-1", ownerId: "root", intent: "inspect the sample", depth: 0,
	}).ok).toBe(true);
	expect(markReady(ledger, "worker-1").ok).toBe(true);

	const receipt = () => station.skillReceipt({ agent: { kind: "main" } }).content[0].text;
	expect(receipt()).toMatch(/\b1 unreceived child result\b|\bunreceived child results?:\s*1\b/i);
	expect(receipt()).toContain("scope_join");
	expect(takeReady(ledger, { ownerId: "root" }).ok).toBe(true);
	expect(receipt()).not.toContain("scope_join");
});

function relayRequest({ registry = null, keepHook = false } = {}) {
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
	const sent = [];
	const station = createTestStation(SessionStation, manager, {}, {
		canPrompt: true,
		prompt: (text) => sent.push({ role: "user", content: text }),
		invokeTool: () => ({
			content: [{ type: "text", text: "Ledger empty." }],
			details: { op: "init", phases: [] },
		}),
	}, registry, null);
	station.state.autopilot = true;
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
	return { station, ctx, sent, commit, request, remove };
}

function receiptTextOf(message) {
	return message.content.map((part) => part.text ?? "").join("\n");
}

test("a toggle regenerates the mode receipt instead of reusing the previous one", async () => {
	const fixture = relayRequest({ keepHook: true });
	try {
		const autoMessages = await fixture.request();
		const auto = autoMessages.filter((message) => message.herdSkill).at(-1);
		expect(receiptTextOf(auto)).toContain("Autopilot on");

		fixture.station.state.autopilot = false;
		const manualMessages = await fixture.request();
		const manual = manualMessages.filter((message) => message.herdSkill).at(-1);
		expect(manual).not.toBe(auto);
		expect(receiptTextOf(manual)).toContain("Autopilot off");
		expect(receiptTextOf(manual)).not.toContain("Autopilot on");

		fixture.station.state.autopilot = true;
		const backMessages = await fixture.request();
		const back = backMessages.filter((message) => message.herdSkill).at(-1);
		expect(back).not.toBe(manual);
		expect(receiptTextOf(back)).toContain("Autopilot on");
		expect(receiptTextOf(back)).not.toContain("Autopilot off");

		// Same mode: the receipt is reused rather than rebuilt.
		const sameMessages = await fixture.request();
		const same = sameMessages.filter((message) => message.herdSkill).at(-1);
		expect(same).toBe(back);
	} finally {
		fixture.remove();
	}
});

test("the language port leaves the receipt untouched on successive model requests", async () => {
	// `keepHook` leaves the preparation hook installed: this test makes two
	// requests in a row. The receipt path reads no language port, so the two
	// fixtures differ only in identity, which is all the determinism check
	// below needs.
	const enabled = relayRequest({ keepHook: true });
	const disabled = relayRequest({ keepHook: true });
	async function latestReceipt(fixture) {
		const receipts = (await fixture.request()).filter((message) => message.herdSkill);
		return receipts.at(-1).content[0].text;
	}
	try {
		for (let round = 0; round < 2; round++) {
			const on = await latestReceipt(enabled);
			const off = await latestReceipt(disabled);
			// The reminder rides in the persistent system prompt, once. The
			// per-request receipt must not repeat it or depend on the port.
			expect(on).not.toContain(chineseRequirement);
			expect(off).toBe(on);
			const turn = { role: "user", content: `Continue after round ${round + 1}.` };
			enabled.commit(turn);
			disabled.commit(turn);
		}
	} finally {
		enabled.remove();
		disabled.remove();
	}
});

function demandCount(messages) {
	return messages.flatMap(({ content }) => Array.isArray(content)
		? content.filter((block) => block.type === "text").map((block) => block.text)
		: [content]).join("\n").split(handoffDemand()).length - 1;
}

for (const promptVisible of [true, false]) {
	test(`natural stop supplies one complete handoff demand when the queued prompt is ${promptVisible ? "visible" : "missing"}`, async () => {
		const { station, ctx, sent, request } = relayRequest();
		station.recordNaturalStop(ctx);
		expect(sent.map((message) => message.content)).toEqual([handoffDemand()]);
		const messages = await request(...(promptVisible ? sent : []));
		expect(messages.filter((message) => message.herdSkill)).toHaveLength(1);
		expect(demandCount(messages)).toBe(1);
	});
}

for (const resultVisible of [true, false]) {
	test(`todo transfer supplies one complete handoff demand when the tool result is ${resultVisible ? "visible" : "missing"}`, async () => {
		const { station, ctx, commit, request } = relayRequest();
		const params = { op: "init", list: [] };
		const result = await todoTicket(station, params, ctx);
		expect(demandCount([result])).toBe(1);
		if (resultVisible) {
			commit({ role: "assistant", content: [{ type: "toolCall", id: "todo-1", name: "todo", arguments: params }] });
			commit({ role: "toolResult", toolCallId: "todo-1", toolName: "todo", ...result });
		}
		const messages = await request();
		expect(messages.filter((message) => message.herdSkill)).toHaveLength(1);
		expect(demandCount(messages)).toBe(1);
	});
}

test("a child prompt carries child duty instead of either mode line", () => {
	for (const autopilot of [true, false]) {
		const child = injectSystemPrompt("Host instructions", { autopilot, branch: true });
		const text = Array.isArray(child) ? child.join("\n") : child;
		expect(text).toContain("### Child duties");
		expect(text).toContain("Fork child duty");
		expect(text).toContain("scope_return");
		expect(text).not.toContain("Autopilot is on");
		expect(text).not.toContain("Autopilot is off by default");
	}

	const manual = injectSystemPrompt("Host instructions", { autopilot: false });
	const auto = injectSystemPrompt("Host instructions", { autopilot: true });
	expect(manual).toContain("Autopilot is off by default");
	expect(auto).toContain("Only the user toggles autopilot");
});
