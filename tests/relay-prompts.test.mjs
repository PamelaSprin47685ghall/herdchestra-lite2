// Root prompt preservation and Root rewind compaction contracts.
//
// A Root rewind compacts history and re-injects all genuine user prompts and
// user steers as real user messages, while filtering out agent-attributed,
// synthetic, skill-receipt, and excluded messages.

import { describe, expect, test } from "bun:test";

import {
	collectUserPrompts,
	createRelay,
	isRealUserMessage,
	isValidRelay,
	mergeUserPrompts,
	rebornUserMessages,
} from "../src/relay/index.mjs";
import { commitRootRewind, syncRootUserPrompts } from "../src/station/handoff-state.mjs";
import { childReturnNudge } from "../src/scope/return-nudge.mjs";
import { createState, deserializeState, serializeState } from "../src/scope/index.mjs";

const FIRST = "Fix the relay so user prompts survive.";
const SECOND = "Keep every prompt in order, including user steers.";

describe("collectUserPrompts", () => {
	test("keeps real user prompts and user steers verbatim, in order", () => {
		const messages = [
			{ role: "user", content: FIRST },
			{ role: "assistant", content: [{ type: "text", text: "Working." }] },
			{ role: "user", content: [{ type: "text", text: SECOND }], steering: true, attribution: "user" },
			{ role: "toolResult", toolCallId: "t1", toolName: "read", content: "x" },
			{ role: "user", content: "skill receipt", herdSkill: true },
		];
		expect(collectUserPrompts(messages)).toEqual([FIRST, SECOND]);
	});

	test("drops agent-attributed, synthetic, excluded, compaction, and custom messages", () => {
		const messages = [
			{ role: "compactionSummary", summary: "Earlier work", timestamp: 1 },
			{ role: "custom", customType: "herd-relay-handoff", content: [{ type: "text", text: "Summary" }] },
			{ role: "user", content: "agent steer", attribution: "agent" },
			{ role: "user", content: "synthetic resume", synthetic: true },
			{ role: "user", content: "hidden", excludeFromContext: true },
			{ role: "user", content: "   " },
			{ role: "user", content: FIRST },
		];
		expect(isRealUserMessage(messages[2])).toBe(false);
		expect(isRealUserMessage(messages[3])).toBe(false);
		expect(isRealUserMessage(messages[6])).toBe(true);
		expect(collectUserPrompts(messages)).toEqual([FIRST]);
	});
});

describe("mergeUserPrompts", () => {
	test("keeps archived prompts and appends fresh ones without duplicating overlap", () => {
		expect(mergeUserPrompts(["one", "two"], ["two", "three"])).toEqual(["one", "two", "three"]);
		expect(mergeUserPrompts(["one", "two"], ["three"])).toEqual(["one", "two", "three"]);
		expect(mergeUserPrompts(["one", "two"], ["two"])).toEqual(["one", "two"]);
		expect(mergeUserPrompts([], ["again", "again"])).toEqual(["again", "again"]);
		expect(mergeUserPrompts(["again"], ["again", "again"])).toEqual(["again", "again"]);
	});
});

describe("relay state persistence", () => {
	test("round-trips the relay fields including userPrompts and pendingRewind", () => {
		const state = createState();
		state.relay = {
			generation: 2,
			canStop: false,
			goal: false,
			userPrompts: [FIRST, SECOND],
			pendingRewind: { report: "work so far", generation: 2, id: "call-1" },
		};
		const restored = deserializeState(serializeState(state));
		expect(restored.relay).toEqual(state.relay);
		expect(isValidRelay(state.relay)).toBe(true);
		expect(isValidRelay({ ...createRelay(), userPrompts: [1] })).toBe(false);
		expect(isValidRelay({ ...createRelay(), pendingRewind: { report: 123 } })).toBe(false);
	});
});

describe("commitRootRewind", () => {
	function rewindHarness(initialMessages) {
		const entries = initialMessages.map((message, i) => ({
			type: "message",
			id: `e${i + 1}`,
			message,
		}));
		const setMessagesCalls = [];
		const manager = {
			entries,
			appendCompaction(summary, _short, firstKeptEntryId, tokensBefore, details) {
				const id = `c${entries.length + 1}`;
				entries.push({
					type: "compaction",
					id,
					summary,
					firstKeptEntryId,
					tokensBefore,
					details,
				});
				return id;
			},
			appendMessage(message) {
				const id = `m${entries.length + 1}`;
				entries.push({ type: "message", id, message });
				return id;
			},
			buildSessionContext() {
				const lastCompaction = entries.findLastIndex((entry) => entry.type === "compaction");
				if (lastCompaction < 0) {
					return { messages: entries.filter((e) => e.type === "message").map((e) => e.message) };
				}
				const compaction = entries[lastCompaction];
				const keepId = compaction.firstKeptEntryId ?? "";
				const retainedStart = keepId
					? entries.findIndex((entry, index) => index < lastCompaction && entry.id === keepId)
					: -1;
				// The host model context always shows the summary first, then the
				// retained block [firstKeptEntryId, compaction), then later entries.
				// Its transcript projection shows the retained block before the
				// summary, which is where the restored users precede the record.
				const out = [{ role: "compactionSummary", summary: compaction.summary }];
				if (retainedStart >= 0) {
					for (let i = retainedStart; i < lastCompaction; i += 1) {
						if (entries[i].type === "message") out.push(entries[i].message);
					}
				}
				for (let i = lastCompaction + 1; i < entries.length; i += 1) {
					if (entries[i].type === "message") out.push(entries[i].message);
				}
				return { messages: out };
			},
		};
		const state = createState();
		const station = {
			state,
			manager,
			usage: { lastTotalInput: 500 },
			contextCache: null,
			hostBoundaryScan: null,
			contextMessages: () => manager.buildSessionContext().messages,
			persist: () => {},
			resetUsageWatermark: () => {},
			noteError: () => {},
			host: {
				session: {
					setMessages(_ctx, messages) {
						setMessagesCalls.push(messages);
					},
				},
			},
		};
		return { station, manager, entries, setMessagesCalls };
	}

	test("compacts history and restores verbatim user prompts/steers as real user messages", () => {
		const { station, manager, entries, setMessagesCalls } = rewindHarness([
			{ role: "user", content: FIRST },
			{ role: "assistant", content: [{ type: "text", text: "Working" }] },
			{ role: "user", content: SECOND, steering: true, attribution: "user" },
			{ role: "user", content: "system steer", attribution: "agent" },
			{ role: "user", content: childReturnNudge() },
		]);
		station.state.relay.generation = 1;
		station.state.relay.pendingRewind = {
			report: 'read(path="a.mjs")\n\nverified part 1',
			big: false,
			generation: 1,
			id: "r1",
		};

		const before = entries.length;
		const ok = commitRootRewind(station, {}, { pending: station.state.relay.pendingRewind });
		expect(ok).toBe(true);
		expect(station.state.relay.pendingRewind).toBeNull();
		expect(station.state.relay.userPrompts).toEqual([FIRST, SECOND]);

		const rebuilt = manager.buildSessionContext().messages;
		expect(setMessagesCalls).toHaveLength(1);
		expect(rebuilt[0].role).toBe("compactionSummary");
		// The return report is the only carried-forward evidence: the retired
		// pin list has no counterpart, so the report alone must survive the cut.
		expect(rebuilt[0].summary).toContain('read(path="a.mjs")');
		expect(rebuilt[0].summary).toContain("verified part 1");
		// Verbatim user prompts & steers are restored as real user messages.
		const users = rebuilt.slice(1);
		expect(users.map((m) => m.role)).toEqual(["user", "user"]);
		expect(users.map((m) => m.content[0].text)).toEqual([FIRST, SECOND]);
		expect(users.every((m) => m.attribution === "user")).toBe(true);

		// The restored users land before the compaction entry, and the compaction
		// names the first one so the host retains the block across the cut.
		const appended = entries.slice(before);
		expect(appended.map((entry) => entry.type)).toEqual(["message", "message", "compaction"]);
		expect(appended[0].message.content[0].text).toBe(FIRST);
		expect(appended[1].message.content[0].text).toBe(SECOND);
		expect(appended[2].firstKeptEntryId).toBe(appended[0].id);
	});

	test("a second rewind keeps every prior user prompt once and appends newly arrived prompts", () => {
		const { station, manager, entries } = rewindHarness([
			{ role: "user", content: FIRST },
			{ role: "user", content: SECOND },
		]);
		station.state.relay.generation = 1;
		station.state.relay.pendingRewind = { report: "Gen 1 report", generation: 1, id: "r1" };
		expect(commitRootRewind(station, {}, { pending: station.state.relay.pendingRewind })).toBe(true);

		// A third real user message arrives in generation 1.
		manager.appendMessage({ role: "user", content: "Third requirement." });
		station.state.relay.generation = 2;
		station.state.relay.pendingRewind = { report: "Gen 2 report", generation: 2, id: "r2" };
		const before = entries.length;
		expect(commitRootRewind(station, {}, { pending: station.state.relay.pendingRewind })).toBe(true);
		const appended = entries.slice(before);
		expect(appended.map((entry) => entry.type)).toEqual(["message", "message", "message", "compaction"]);
		expect(appended.slice(0, 3).map((entry) => entry.message.content[0].text)).toEqual([
			FIRST,
			SECOND,
			"Third requirement.",
		]);
		expect(appended[3].firstKeptEntryId).toBe(appended[0].id);

		const rebuilt = manager.buildSessionContext().messages;
		expect(rebuilt[0].summary).toContain("Gen 2 report");
		expect(rebuilt[0].summary).not.toContain("Gen 1 report");
		const userTexts = rebuilt.slice(1).map((m) => m.content[0].text);
		expect(userTexts).toEqual([FIRST, SECOND, "Third requirement."]);
		expect(rebornUserMessages([FIRST]).length).toBe(1);
	});

	test("a rewind with no user prompts appends only the compaction and retains nothing", () => {
		const { station, manager, entries } = rewindHarness([
			{ role: "assistant", content: [{ type: "text", text: "Working" }] },
		]);
		station.state.relay.pendingRewind = { report: "Gen 1 report", generation: 1 };
		const before = entries.length;
		expect(commitRootRewind(station, {}, { pending: station.state.relay.pendingRewind })).toBe(true);

		const appended = entries.slice(before);
		expect(appended.map((entry) => entry.type)).toEqual(["compaction"]);
		expect(appended[0].firstKeptEntryId).toBe("");
		const rebuilt = manager.buildSessionContext().messages;
		expect(rebuilt).toHaveLength(1);
		expect(rebuilt[0].role).toBe("compactionSummary");
	});

	test("syncRootUserPrompts resets canStop when a new real user prompt arrives", () => {
		const { station } = rewindHarness([{ role: "user", content: FIRST }]);
		station.state.relay.userPrompts = [FIRST];
		station.state.relay.canStop = true;

		// No new user message -> unchanged.
		expect(syncRootUserPrompts(station, [{ role: "user", content: FIRST }])).toBe(false);
		expect(station.state.relay.canStop).toBe(true);

		// New real user message -> resets promotion.
		expect(syncRootUserPrompts(station, [{ role: "user", content: FIRST }, { role: "user", content: SECOND }])).toBe(true);
		expect(station.state.relay.userPrompts).toEqual([FIRST, SECOND]);
		expect(station.state.relay.canStop).toBe(false);
	});
});
