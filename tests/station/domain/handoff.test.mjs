// Pure decision contracts for `scope_return` oath, small/big handoff,
// generation report formatting, and reborn prompts.

import { describe, expect, test } from "bun:test";

import { createRelay } from "../../../src/relay/index.mjs";
import {
	RETURN_OATH_KEY,
	RETURN_OATH_UNFINISHED,
	RETURN_OATH_VALUE,
	decideScopeReturn,
	formatGenerationReport,
	formatRebornPrompt,
	parseReturnOath,
	rebornStartPrompt,
	resetRootPromotion,
} from "../../../src/station/domain/handoff.mjs";

const OATH = { [RETURN_OATH_KEY]: RETURN_OATH_VALUE };
const UNFINISHED = { [RETURN_OATH_KEY]: RETURN_OATH_UNFINISHED };

describe("parseReturnOath", () => {
	test("unfinished is the small handoff; an omitted oath is refused", () => {
		expect(parseReturnOath(UNFINISHED)).toEqual({ ok: true, big: false });
		expect(parseReturnOath({})).toEqual({ ok: false, code: "INVALID_RETURN_OATH" });
		expect(parseReturnOath({ [RETURN_OATH_KEY]: undefined })).toEqual({
			ok: false,
			code: "INVALID_RETURN_OATH",
		});
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
			decideScopeReturn({ isRoot: true, args: { dafny: "   ", ...UNFINISHED } }),
		).toEqual({ ok: false, code: "MISSING_DAFNY" });
		expect(
			decideScopeReturn({ isRoot: true, mixedToolCalls: true, args: { dafny: "ok", ...UNFINISHED } }),
		).toEqual({ ok: false, code: "MIXED_RETURN_TOOL_CALLS" });
		expect(
			decideScopeReturn({ isRoot: false, identityForkId: "f1", record: childRecord, mixedToolCalls: true, args: { dafny: "ok", ...OATH } }),
		).toEqual({ ok: false, code: "MIXED_RETURN_TOOL_CALLS" });
	});

	test("child small handoff (unfinished oath) rewinds and stops the loop", () => {
		const decision = decideScopeReturn({
			isRoot: false,
			identityForkId: "f1",
			record: childRecord,
			args: { dafny: "discovered cache mismatch; next try patching", ...UNFINISHED },
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

	test("child big handoff (seal oath) delivers to receiver", () => {
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
			abandoned: false,
			dafny: "verified fix",
			receiverId: "root",
			orphans: ["c2"],
			stopLoop: true,
		});
	});

	test("root unfinished handoff rewinds and increments generation", () => {
		const before = Object.freeze({ ...createRelay(), generation: 2, canStop: false });
		const decision = decideScopeReturn({
			isRoot: true,
			relay: before,
			canRewindRoot: true,
			unreceived: 2, // allowed for small handoff
			args: { dafny: "still need to inspect tests", ...UNFINISHED },
			callId: "c-small",
		});
		expect(decision.ok).toBe(true);
		expect(decision.kind).toBe("rewind");
		expect(decision.scope).toBe("root");
		expect(decision.big).toBe(false);
		expect(decision.stopLoop).toBe(true);
		expect(decision.relay.generation).toBe(3);
		expect(decision.relay.canStop).toBe(false);
		expect(decision.relay.pendingRewind).toEqual({
			report: "",
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

	test("root seal promotes on the first oath without a rewind", () => {
		const decision = decideScopeReturn({
			isRoot: true,
			relay: createRelay(),
			canRewindRoot: true,
			args: { dafny: "everything verified", ...OATH },
			callId: "c-big-1",
		});
		expect(decision.ok).toBe(true);
		expect(decision.kind).toBe("promote");
		expect(decision.big).toBe(true);
		expect(decision.stopLoop).toBe(false);
		expect(decision.relay.generation).toBe(0);
		expect(decision.relay.canStop).toBe(true);
		expect(decision.relay.pendingRewind).toBeNull();
	});

	test("root rewind refuses when host cannot rewind", () => {
		const decision = decideScopeReturn({
			isRoot: true,
			relay: createRelay(),
			canRewindRoot: false,
			args: { dafny: "report", ...UNFINISHED },
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

	test("formatRebornPrompt renders birth, report, and continue guidance", () => {
		const cont = formatRebornPrompt({
			birth: "You are now in the scope /api,",
			pins: ["**Finding:** cache key stable"],
			report: "read(path=\"a.mjs\")\n\nstill patching",
		});
		expect(cont.startsWith("You are now in the scope /api,")).toBe(true);
		expect(cont).not.toContain("Pinned Context");
		expect(cont).toContain("Latest Return Report");
		expect(cont).toContain('read(path="a.mjs")');
		expect(cont).toMatch(/Continue the work/);
		expect(cont).not.toMatch(/independent review/i);
		expect(rebornStartPrompt().length).toBeGreaterThan(0);
	});

	test("resetRootPromotion clears canStop without mutating input", () => {
		const before = Object.freeze({ ...createRelay(), canStop: true });
		const reset = resetRootPromotion(before);
		expect(reset.changed).toBe(true);
		expect(reset.relay.canStop).toBe(false);
		expect(before.canStop).toBe(true);
	});
});
