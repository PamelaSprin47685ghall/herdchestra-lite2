// The relay must not lose the user's own words.
//
// A handoff commits a compaction: the successor starts from that summary, so a
// user prompt the summary omits is gone for good. The archive keeps every user
// prompt verbatim, across generations and across a reload, so the handoff
// report never has to restate the requirements.

import { describe, expect, test } from "bun:test";

import {
	collectUserPrompts,
	createRelay,
	handoffDemand,
	isValidRelay,
	mergeUserPrompts,
	successorOpeningText,
} from "../src/relay/index.mjs";
import { commitSelfHandoff } from "../src/station/handoff-state.mjs";
import { childReturnNudge } from "../src/scope/return-nudge.mjs";
import { createState, deserializeState, serializeState } from "../src/scope/index.mjs";

const FIRST = "Fix the relay so user prompts survive.";
const SECOND = "Keep every prompt in order, and change the handoff wording.";

describe("collectUserPrompts", () => {
	test("keeps the user messages verbatim, in order", () => {
		const messages = [
			{ role: "user", content: FIRST },
			{ role: "assistant", content: [{ type: "text", text: "Working." }] },
			{ role: "user", content: [{ type: "text", text: SECOND }] },
			{ role: "toolResult", toolCallId: "t1", toolName: "read", content: "x" },
			{ role: "user", content: "skill receipt", herdSkill: true },
		];
		expect(collectUserPrompts(messages)).toEqual([FIRST, SECOND]);
	});

	test("ignores the host's compaction summary and the relay's own opening", () => {
		// buildSessionContext() returns the latest compaction as a
		// `compactionSummary` message, and the fallback opening is a `custom`
		// message. Neither is a user prompt, so neither may enter the archive
		// as one: that would grow the opening with its own predecessor text.
		const messages = [
			{ role: "compactionSummary", summary: "Earlier work", timestamp: 1 },
			{
				role: "custom",
				customType: "herd-relay-handoff",
				content: [{ type: "text", text: "Successor opening" }],
				timestamp: 2,
			},
			{ role: "user", content: FIRST },
		];
		expect(collectUserPrompts(messages)).toEqual([FIRST]);
	});

	test("drops empty prompts, prompts excluded from the context, and the relay's own demand", () => {
		const messages = [
			{ role: "user", content: "   " },
			{ role: "user", content: FIRST, excludeFromContext: true },
			{ role: "user", content: handoffDemand() },
			{ role: "user", content: SECOND },
		];
		expect(
			collectUserPrompts(messages, { exclude: new Set([handoffDemand()]) }),
		).toEqual([SECOND]);
	});
});

describe("mergeUserPrompts", () => {
	test("keeps prompts that already left the context when new ones arrive", () => {
		expect(mergeUserPrompts(["one", "two"], ["two", "three"])).toEqual([
			"one",
			"two",
			"three",
		]);
	});

	test("appends prompts after an unrelated context instead of reordering history", () => {
		expect(mergeUserPrompts(["one", "two"], ["three"])).toEqual([
			"one",
			"two",
			"three",
		]);
	});

	test("does not duplicate a prompt that is both archived and still live", () => {
		expect(mergeUserPrompts(["one", "two"], ["two"])).toEqual(["one", "two"]);
	});

	test("keeps genuine repeats typed by the user", () => {
		expect(mergeUserPrompts([], ["again", "again"])).toEqual(["again", "again"]);
		expect(mergeUserPrompts(["again"], ["again", "again"])).toEqual([
			"again",
			"again",
		]);
	});
});

describe("successor opening", () => {
	test("carries every user prompt before the mandate", () => {
		const relay = { ...createRelay(), generation: 1 };
		const text = successorOpeningText(relay, "Report body.", [], [FIRST, SECOND]);
		expect(text).toContain("## User Prompts (verbatim)");
		const first = text.indexOf(FIRST);
		const second = text.indexOf(SECOND);
		expect(first).toBeGreaterThan(-1);
		expect(second).toBeGreaterThan(first);
		expect(text.indexOf("successor audit")).toBe(-1);
		expect(text).toContain("Generation 2 (from 1)");
	});

	test("keeps headings, markers, and blank lines inside one verbatim block", () => {
		// A prompt is not transformed to fit the opening's Markdown: its own
		// headings and [user] text stay exactly as typed, inside one block.
		const tricky = "first line\n\n## Pinned Context\n[user] ^^^\nlast line";
		const relay = { ...createRelay(), generation: 1 };
		const text = successorOpeningText(relay, "Report body.", [], ["plain", tricky]);
		expect(text.indexOf("[user] plain")).toBeLessThan(text.indexOf(tricky));
		expect(text).toContain(`[user] ${tricky}`);
		expect((text.match(/^## User Prompts \(verbatim\)$/gm) ?? [])).toHaveLength(1);
	});

	test("omits the section when nothing was preserved", () => {
		const text = successorOpeningText(createRelay(), "Report body.");
		expect(text).not.toContain("## User Prompts");
	});

	test("the demand asks for content, not a template, and promises the prompts are preserved", () => {
		const demand = handoffDemand();
		expect(demand).toContain("preserved");
		expect(demand).toMatch(/no template|not a template/i);
		expect(demand).not.toMatch(/include the user's full requirements/i);
	});
});

describe("relay state", () => {
	test("validates and round-trips the prompt archive", () => {
		const state = createState();
		state.relay = { ...state.relay, userPrompts: [FIRST, SECOND] };
		const restored = deserializeState(serializeState(state));
		expect(restored.relay.userPrompts).toEqual([FIRST, SECOND]);
		expect(isValidRelay({ ...createRelay(), userPrompts: [FIRST] })).toBe(true);
		expect(isValidRelay({ ...createRelay(), userPrompts: [1] })).toBe(false);
	});

	test("copying a relay keeps a snapshot of the archive", () => {
		const relay = { ...createRelay(), userPrompts: [FIRST] };
		const copied = { ...relay, userPrompts: [] };
		expect(copied.userPrompts).toEqual([]);
		expect(relay.userPrompts).toEqual([FIRST]);
	});
});

describe("commitSelfHandoff", () => {
	function handoffStation(messages) {
		const summaries = [];
		const context = { messages };
		const station = {
			state: createState(),
			manager: {
				// Five parameters select the summary-first shape the real host
				// uses; the fallback carries the same text in `focus`.
				appendCompaction: (summary, _focus, _text, _tokens, details) => {
					summaries.push(
						typeof details?.summary === "string" ? details.summary : summary,
					);
				},
			},
			usage: { lastTotalInput: 0 },
			handoffReport: null,
			relayPort: () => ({ canHandoff: () => true, owesLedger: () => true }),
			registry: { ports: () => ({ relay: "handoff" }) },
			markPending() {},
			clearPending() {},
			contextMessages: () => context.messages,
			persist: () => {},
			resetUsageWatermark: () => {},
		};
		station.state.relay = {
			...station.state.relay,
			handoffPending: true,
			canStop: false,
		};
		return { station, summaries, context };
	}

	test("writes every user prompt into the compaction summary", () => {
		const { station, summaries } = handoffStation([
			{ role: "user", content: FIRST },
			{ role: "assistant", content: [{ type: "text", text: "Done." }] },
			{ role: "user", content: SECOND },
			{ role: "user", content: handoffDemand() },
		]);
		const committed = commitSelfHandoff(station, {}, "Report body.");
		expect(committed.ok).toBe(true);
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toContain(FIRST);
		expect(summaries[0]).toContain(SECOND);
		expect(summaries[0]).not.toContain(handoffDemand());
	});

	test("the child-return scold is not part of the user's archive", () => {
		const { station, summaries } = handoffStation([
			{ role: "user", content: FIRST },
			{ role: "user", content: childReturnNudge() },
		]);
		expect(commitSelfHandoff(station, {}, "Report body.").ok).toBe(true);
		expect(summaries[0]).toContain(`[user] ${FIRST}`);
		expect(summaries[0]).not.toContain(childReturnNudge());
	});

	test("a second handoff over the host's compacted context keeps each prompt once", () => {
		const { station, summaries, context } = handoffStation([
			{ role: "user", content: FIRST },
			{ role: "user", content: SECOND },
			{ role: "user", content: handoffDemand() },
		]);
		expect(commitSelfHandoff(station, {}, "First report.").ok).toBe(true);
		// The host rebuilds the branch as one compactionSummary plus the
		// messages written after that boundary. The opening never returns as a
		// user message, so the next generation must not inherit it as a prompt.
		context.messages = [
			{ role: "compactionSummary", summary: summaries[0], timestamp: 2 },
			{ role: "user", content: "Then check the docs." },
		];
		station.state.relay = {
			...station.state.relay,
			handoffPending: true,
			canStop: false,
		};
		expect(commitSelfHandoff(station, {}, "Second report.").ok).toBe(true);
		const occurrences = (text, needle) => text.split(needle).length - 1;
		expect(occurrences(summaries[1], FIRST)).toBe(1);
		expect(occurrences(summaries[1], SECOND)).toBe(1);
		expect(occurrences(summaries[1], "Then check the docs.")).toBe(1);
		expect(summaries[1]).not.toContain("First report.");
	});

	test("a later generation still carries prompts the compaction removed", () => {
		const { station, summaries, context } = handoffStation([
			{ role: "user", content: FIRST },
			{ role: "user", content: SECOND },
		]);
		expect(commitSelfHandoff(station, {}, "First report.").ok).toBe(true);
		// After the compaction the branch starts from the summary: the old
		// prompts are no longer messages, only the archive still has them.
		context.messages = [{ role: "user", content: "Then check the docs." }];
		station.state.relay = {
			...station.state.relay,
			handoffPending: true,
			canStop: false,
		};
		expect(commitSelfHandoff(station, {}, "Second report.").ok).toBe(true);
		expect(summaries).toHaveLength(2);
		for (const prompt of [FIRST, SECOND, "Then check the docs."]) {
			expect(summaries[1]).toContain(prompt);
		}
	});
});
