// A child inherits the parent's context, so the branch manager hands the
// whole transcript back. The record a parent joins must contain only the
// child's own work: replaying the parent's prefix defeats join admission and
// hands the parent its own conversation back.

import { describe, expect, test } from "bun:test";

import { childRecordStart, childReceiptText } from "../src/station/fork-controls.mjs";
import { renderChildRecord } from "../src/transcript/replay.mjs";

const FORK_ID = "call-1";

function user(text, timestamp) {
	return { role: "user", content: text, timestamp };
}

function assistant(text, timestamp) {
	return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

const receipt = (forkId = FORK_ID, timestamp = 300) => ({
	role: "user",
	content: childReceiptText({
		forkId,
		intent: "read the version",
		budget: { read: 2 },
		targets: ["src/parser.mjs"],
		childDepth: 1,
	}),
	timestamp,
});

describe("childRecordStart", () => {
	test("the receipt is the boundary, so the parent prefix is excluded", () => {
		const messages = [
			user("parent prompt", 100),
			assistant("parent reply", 200),
			receipt(FORK_ID, 300),
			assistant("child did it", 400),
		];
		expect(childRecordStart(messages, { forkId: FORK_ID, startedAt: 250 })).toBe(2);
		const record = renderChildRecord(messages, {
			start: childRecordStart(messages, { forkId: FORK_ID, startedAt: 250 }),
		});
		expect(record).not.toContain("parent prompt");
		expect(record).not.toContain("parent reply");
		expect(record).toContain("child did it");
	});

	test("the bracket start is the fallback when the receipt text was rewritten", () => {
		const messages = [
			user("parent prompt", 100),
			assistant("parent reply", 200),
			{ role: "user", content: "rewritten receipt", timestamp: 300 },
			assistant("child did it", 400),
		];
		expect(childRecordStart(messages, { forkId: FORK_ID, startedAt: 250 })).toBe(2);
	});

	test("an unparseable timestamp cannot prove ownership, so it is skipped", () => {
		const messages = [
			user("parent prompt", 100),
			assistant("parent reply", 200),
			{ role: "user", content: "no timestamp" },
			assistant("child did it", 400),
		];
		expect(childRecordStart(messages, { forkId: FORK_ID, startedAt: 250 })).toBe(3);
	});

	test("with neither marker nor start the whole context is kept", () => {
		const messages = [user("a", 100), assistant("b", 200)];
		expect(childRecordStart(messages, { forkId: FORK_ID })).toBe(0);
		expect(childRecordStart([], { forkId: FORK_ID })).toBe(0);
	});

	test("the receipt opens with the scope marker, not a family relation", () => {
		const text = childReceiptText({
			forkId: FORK_ID,
			intent: "read the version",
			budget: { read: 2 },
			targets: ["src/parser.mjs"],
			childDepth: 1,
		});
		expect(text.startsWith(`You are now in the scope ${FORK_ID},`)).toBe(true);
		expect(text).not.toContain("child of fork");
	});

	test("a receipt written by an earlier build still marks the boundary", () => {
		const messages = [
			user("parent prompt", 100),
			assistant("parent reply", 200),
			{ role: "user", content: `You are the child of fork ${FORK_ID}, depth 1`, timestamp: 300 },
			assistant("child did it", 400),
		];
		expect(childRecordStart(messages, { forkId: FORK_ID, startedAt: 250 })).toBe(2);
	});
});
