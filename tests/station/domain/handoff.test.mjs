// Pure decision contracts for `scope_return` oath, small/big handoff,
// generation report formatting, and reborn prompts.

import { describe, expect, test } from "bun:test";

import { createRelay } from "../../../src/relay/index.mjs";
import {
	RETURN_OATH_KEY,
	RETURN_OATH_VALUE,
	decideScopeReturn,
	formatGenerationReport,
	formatRebornPrompt,
	parseReturnOath,
	rebornStartPrompt,
	resetRootPromotion,
} from "../../../src/station/domain/handoff.mjs";

const OATH = { [RETURN_OATH_KEY]: RETURN_OATH_VALUE };

describe("parseReturnOath", () => {
	test("omitted or undefined oath is a small handoff", () => {
		expect(parseReturnOath({})).toEqual({ ok: true, big: false });
		expect(parseReturnOath({ [RETURN_OATH_KEY]: undefined })).toEqual({ ok: true, big: false });
	});

	test("exact singleton oath value is a big handoff", () => {
		expect(parseReturnOath(OATH)).toEqual({ ok: true, big: true });
	});

	test("any non-matching value is strictly refused (never coerced)", () => {
		for (const bad of [false, true, null, "", " ", "a_master_would_change_nothing", 1, {}]) {
			expect(parseReturnOath({ [RETURN_OATH_KEY]: bad })).toEqual({
				ok: false,
				code: "INVALID_RETURN_OATH",
			});
		}
	});
});

describe("decideScopeReturn", () => {
	const childRecord = Object.freeze({ forkId: "f1", status: "running", ownerId: "root", woken: false });

	test("refuses invalid oath, blank dafny, and mixed tool batches before touching state", () => {
		expect(
			decideScopeReturn({ isRoot: true, args: { dafny: "ok", [RETURN_OATH_KEY]: false } }),
		).toEqual({ ok: false, code: "INVALID_RETURN_OATH" });
		expect(
			decideScopeReturn({ isRoot: true, args: { dafny: "   " } }),
		).toEqual({ ok: false, code: "MISSING_DAFNY" });
		expect(
			decideScopeReturn({ isRoot: true, mixedToolCalls: true, args: { dafny: "ok" } }),
		).toEqual({ ok: false, code: "MIXED_RETURN_TOOL_CALLS" });
		expect(
			decideScopeReturn({ isRoot: false, identityForkId: "f1", record: childRecord, mixedToolCalls: true, args: { dafny: "ok", ...OATH } }),
		).toEqual({ ok: false, code: "MIXED_RETURN_TOOL_CALLS" });
	});

	test("child small handoff (oath omitted) rewinds and stops the loop", () => {
		const decision = decideScopeReturn({
			isRoot: false,
			identityForkId: "f1",
			record: childRecord,
			args: { dafny: "discovered cache mismatch; next try patching" },
		});
		expect(decision).toEqual({
			ok: true,
			kind: "rewind",
			scope: "child",
			big: false,
			dafny: "discovered cache mismatch; next try patching",
			stopLoop: true,
		});
	});

	test("child big handoff (oath present) delivers to receiver", () => {
		const decision = decideScopeReturn({
			isRoot: false,
			identityForkId: "f1",
			record: childRecord,
			receiverId: "root",
			orphans: ["c2"],
			args: { dafny: "verified fix", ...OATH },
		});
		expect(decision).toEqual({
			ok: true,
			kind: "deliver",
			scope: "child",
			big: true,
			dafny: "verified fix",
			receiverId: "root",
			orphans: ["c2"],
			stopLoop: true,
		});
	});

	test("root small handoff rewinds, increments generation, and resets bigStreak", () => {
		const before = Object.freeze({ ...createRelay(), generation: 2, bigStreak: 1, canStop: false });
		const decision = decideScopeReturn({
			isRoot: true,
			relay: before,
			canRewindRoot: true,
			unreceived: 2, // allowed for small handoff
			args: { dafny: "still need to inspect tests" },
			callId: "c-small",
		});
		expect(decision.ok).toBe(true);
		expect(decision.kind).toBe("rewind");
		expect(decision.scope).toBe("root");
		expect(decision.big).toBe(false);
		expect(decision.stopLoop).toBe(true);
		expect(decision.relay.generation).toBe(3);
		expect(decision.relay.bigStreak).toBe(0);
		expect(decision.relay.canStop).toBe(false);
		expect(decision.relay.pendingRewind).toEqual({
			report: "",
			big: false,
			generation: 3,
			id: "c-small",
		});
		expect(before.generation).toBe(2);
	});

	test("root big handoff refuses while unreceived children remain", () => {
		const decision = decideScopeReturn({
			isRoot: true,
			relay: createRelay(),
			canRewindRoot: true,
			unreceived: 2,
			args: { dafny: "done", ...OATH },
		});
		expect(decision).toEqual({
			ok: false,
			code: "UNRECEIVED_CHILDREN",
			unreceived: 2,
		});
	});

	test("root first big handoff rewinds for review; second consecutive promotes without rewind", () => {
		const first = decideScopeReturn({
			isRoot: true,
			relay: createRelay(),
			canRewindRoot: true,
			args: { dafny: "everything verified", ...OATH },
			callId: "c-big-1",
		});
		expect(first.ok).toBe(true);
		expect(first.kind).toBe("rewind");
		expect(first.big).toBe(true);
		expect(first.stopLoop).toBe(true);
		expect(first.relay.generation).toBe(1);
		expect(first.relay.bigStreak).toBe(1);
		expect(first.relay.canStop).toBe(false);

		const second = decideScopeReturn({
			isRoot: true,
			relay: { ...first.relay, pendingRewind: null },
			canRewindRoot: true,
			args: { dafny: "independent review confirms nothing left", ...OATH },
			callId: "c-big-2",
		});
		expect(second.ok).toBe(true);
		expect(second.kind).toBe("promote");
		expect(second.stopLoop).toBe(false);
		expect(second.relay.generation).toBe(1);
		expect(second.relay.bigStreak).toBe(2);
		expect(second.relay.canStop).toBe(true);
		expect(second.relay.pendingRewind).toBeNull();
	});

	test("root small handoff between two oaths resets streak so another two oaths are required", () => {
		const firstBig = decideScopeReturn({
			isRoot: true,
			relay: createRelay(),
			canRewindRoot: true,
			args: { dafny: "first big", ...OATH },
		});
		const small = decideScopeReturn({
			isRoot: true,
			relay: { ...firstBig.relay, pendingRewind: null },
			canRewindRoot: true,
			args: { dafny: "found edge case during review" },
		});
		expect(small.relay.bigStreak).toBe(0);

		const nextBig = decideScopeReturn({
			isRoot: true,
			relay: { ...small.relay, pendingRewind: null },
			canRewindRoot: true,
			args: { dafny: "edge case fixed", ...OATH },
		});
		expect(nextBig.kind).toBe("rewind");
		expect(nextBig.relay.bigStreak).toBe(1);
		expect(nextBig.relay.canStop).toBe(false);
	});

	test("root rewind refuses when host cannot rewind", () => {
		const decision = decideScopeReturn({
			isRoot: true,
			relay: createRelay(),
			canRewindRoot: false,
			args: { dafny: "report" },
		});
		expect(decision).toEqual({ ok: false, code: "ROOT_REWIND_UNAVAILABLE" });
	});
});

describe("formatting helpers", () => {
	test("formatGenerationReport includes assistant text, tool calls with args, skips amended beats, and appends dafny", () => {
		const messages = [
			{ role: "user", content: "old user" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "checked parser" },
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.mjs" } },
				],
			},
			{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "file body" }] },
		];
		const out = formatGenerationReport(messages, 0, "deduction: parser is clean");
		expect(out).toBe('checked parser\nread(path="a.mjs")\n\ndeduction: parser is clean');
	});

	test("formatRebornPrompt renders birth, pins, report, and review vs continue guidance", () => {
		const cont = formatRebornPrompt({
			birth: "You are now in the scope /api,",
			pins: ["**Finding:** cache key stable"],
			report: "read(path=\"a.mjs\")\n\nstill patching",
			big: false,
		});
		expect(cont.startsWith("You are now in the scope /api,")).toBe(true);
		expect(cont).not.toContain("Pinned Context");
		expect(cont).toContain("Latest Return Report");
		expect(cont).toContain('read(path="a.mjs")');

		const review = formatRebornPrompt({
			report: "all verified",
			pins: [],
			big: true,
		});
		expect(review).not.toContain("Pinned Context");
		expect(review).toContain("all verified");
		expect(review).toMatch(/review/i);
		expect(rebornStartPrompt().length).toBeGreaterThan(0);
	});

	test("resetRootPromotion clears bigStreak and canStop without mutating input", () => {
		const before = Object.freeze({ ...createRelay(), bigStreak: 2, canStop: true });
		const reset = resetRootPromotion(before);
		expect(reset.changed).toBe(true);
		expect(reset.relay.bigStreak).toBe(0);
		expect(reset.relay.canStop).toBe(false);
		expect(before.canStop).toBe(true);
	});
});
