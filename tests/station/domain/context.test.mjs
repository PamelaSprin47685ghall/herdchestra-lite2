// The context projection is a pure decision: it takes plain data and returns a
// patch. These tests pin the projection, the ablation, and the no-mutation rule.

import { describe, expect, test } from "bun:test";

import { foldingOff, foldingOn } from "../../../src/features/folding/index.mjs";
import { addReceipt, attachReport, createReceiptRecord } from "../../../src/scope/receipts.mjs";
import { FOLDED_MARKER } from "../../../src/transcript/collapse.mjs";
import { beatKey } from "../../../src/transcript/messages.mjs";
import {
	projectContext,
	settleReceipts,
	shouldRebase,
} from "../../../src/station/domain/context.mjs";

function receipt(forkId, closeId, closedOrder, levelKey = "L0", report = null) {
	return createReceiptRecord({
		forkToolCallId: forkId,
		closeToolCallId: closeId,
		levelKey,
		closedOrder,
		report,
	});
}

function receiptList() {
	let list = addReceipt([], receipt("f1", "j1", 1));
	list = addReceipt(list, receipt("f2", "j2", 2));
	return attachReport(list, "j1", "found the parser path");
}

function fixture() {
	const left = {
		role: "assistant",
		content: [{ type: "toolCall", id: "f1", name: "scope_fork", arguments: { forks: [] } }],
	};
	const leftResult = {
		role: "toolResult",
		toolCallId: "f1",
		toolName: "scope_fork",
		content: [{ type: "text", text: "child f1 started" }],
	};
	const right = {
		role: "assistant",
		content: [{ type: "toolCall", id: "j1", name: "scope_join", arguments: { elder_report: null } }],
	};
	const rightResult = {
		role: "toolResult",
		toolCallId: "j1",
		toolName: "scope_join",
		content: [{ type: "text", text: "full child record for f1. ".repeat(20) }],
	};
	const youngest = {
		...rightResult,
		toolCallId: "j2",
		toolName: "scope_join",
	};
	return { left, leftResult, right, rightResult, youngest };
}

describe("projectContext", () => {
	test("never mutates the snapshot or the original messages", () => {
		const receipts = receiptList();
		const { left, leftResult, right, rightResult, youngest } = fixture();
		const original = [left, leftResult, right, rightResult, youngest];
		const snapshot = { receipts, amends: [] };
		const view = { original, ports: { vibeCompat: "on" } };
		Object.freeze(snapshot);
		Object.freeze(receipts);
		for (const entry of receipts) Object.freeze(entry);
		Object.freeze(original);
		for (const message of original) Object.freeze(message);
		const before = JSON.stringify({ receipts, original });

		const result = projectContext(snapshot, view, { folding: foldingOn() });

		expect(JSON.stringify({ receipts, original })).toBe(before);
		expect(result.messages).not.toBe(original);
	});

	test("off is a real ablation: no receipt is shortenable and nothing changes", () => {
		const receipts = receiptList();
		const { rightResult, youngest } = fixture();
		const result = projectContext(
			{ receipts, amends: [] },
			{ original: [rightResult, youngest] },
			{ folding: foldingOff() },
		);

		expect(result.collapsed).toEqual([]);
		expect(result.nextState.receipts).toBe(receipts);
		expect(result.messages[0]).toBe(rightResult);
		expect(result.messages[0].content[0].text).not.toContain(FOLDED_MARKER);
	});

	test("on shortens the elder receipt and marks it in the next state", () => {
		const receipts = receiptList();
		const { left, leftResult, right, rightResult, youngest } = fixture();
		const result = projectContext(
			{ receipts, amends: [] },
			{ original: [left, leftResult, right, rightResult, youngest] },
			{ folding: foldingOn() },
		);

		expect(result.collapsed).toEqual(["j1"]);
		expect(result.messages).toHaveLength(5);
		expect(result.messages[0]).toBe(left);
		expect(result.messages[1]).toBe(leftResult);
		expect(result.messages[3].content[0].text).toContain(FOLDED_MARKER);
		expect(result.messages[3].content[0].text).not.toContain("full child record");
		const elder = result.nextState.receipts.find((entry) => entry.closeToolCallId === "j1");
		expect(elder.collapsed).toBe(true);
		expect(receipts.find((entry) => entry.closeToolCallId === "j1").collapsed).toBe(false);
	});

	test("drops every message of an amended beat", () => {
		const call = {
			role: "assistant",
			content: [{ type: "toolCall", id: "a1", name: "read", arguments: {} }],
			timestamp: 1,
		};
		const resultMessage = {
			role: "toolResult",
			toolCallId: "a1",
			content: [{ type: "text", text: "read result" }],
		};
		const keep = { role: "user", content: "keep", timestamp: 2 };
		const result = projectContext(
			{ receipts: [], amends: [beatKey(call)] },
			{ original: [call, resultMessage, keep] },
			{ folding: foldingOff() },
		);
		expect(result.messages).toEqual([keep]);
	});

	test("rebases only when the host tree tail still matches the outbound tail", () => {
		const tail = { role: "user", content: "same tail", timestamp: 3 };
		const other = { role: "user", content: "other tail", timestamp: 4 };

		expect(
			projectContext(
				{ receipts: [], amends: [] },
				{ original: [tail], tree: [tail], needsRebase: true },
				{ folding: foldingOff() },
			).rebase,
		).toBe(true);
		expect(
			projectContext(
				{ receipts: [], amends: [] },
				{ original: [tail], tree: [other], needsRebase: true },
				{ folding: foldingOff() },
			).rebase,
		).toBe(false);
		expect(
			projectContext(
				{ receipts: [], amends: [] },
				{ original: [tail], tree: [tail], needsRebase: false },
				{ folding: foldingOff() },
			).rebase,
		).toBe(false);
	});

	test("usage carries the rewritten messages and the highest branch frontier", () => {
		const user = { role: "user", content: "hello", timestamp: 1 };
		const vibe = {
			role: "custom",
			customType: "vibe-mode-context",
			content: "drive two worker CLIs",
			timestamp: 2,
		};
		const result = projectContext(
			{ receipts: [], amends: [] },
			{ original: [user, vibe], ports: { vibeCompat: "on" }, modelKey: "m1", header: { h: 1 } },
			{ folding: foldingOff() },
		);

		expect(result.usage).toEqual({
			key: "m1",
			messages: result.messages,
			header: { h: 1 },
			frontier: 2,
		});
		expect(result.messages[1].content).toContain(
			"direct as many parallel slice/swarm workers",
		);
		expect(
			projectContext(
				{ receipts: [], amends: [] },
				{ original: [user], modelKey: null },
				{ folding: foldingOff() },
			).usage,
		).toBeNull();
	});

	test("vibeCompat off leaves the custom message untouched", () => {
		const vibe = {
			role: "custom",
			customType: "vibe-mode-context",
			content: "drive two worker CLIs",
			timestamp: 2,
		};
		const result = projectContext(
			{ receipts: [], amends: [] },
			{ original: [vibe], ports: { vibeCompat: "off" } },
			{ folding: foldingOff() },
		);
		expect(result.messages[0]).toBe(vibe);
	});

	test("empty input is a clean no-op", () => {
		const result = projectContext({}, {}, {});
		expect(result.messages).toEqual([]);
		expect(result.nextState.receipts).toEqual([]);
		expect(result.collapsed).toEqual([]);
		expect(result.rebase).toBe(false);
		expect(result.usage).toBeNull();
	});
});

describe("pure helpers", () => {
	test("settleReceipts marks only the named receipts", () => {
		const receipts = receiptList();
		const next = settleReceipts(receipts, ["j1"]);
		expect(next.find((entry) => entry.closeToolCallId === "j1").collapsed).toBe(true);
		expect(next.find((entry) => entry.closeToolCallId === "j2").collapsed).toBe(false);
		expect(receipts.find((entry) => entry.closeToolCallId === "j1").collapsed).toBe(false);
	});

	test("shouldRebase refuses a missing tree or a different tail", () => {
		const tail = { role: "user", content: "tail", timestamp: 1 };
		const other = { role: "user", content: "other", timestamp: 2 };
		expect(shouldRebase({ needsRebase: true, tree: [tail], outbound: [tail] })).toBe(true);
		expect(shouldRebase({ needsRebase: true, tree: [other], outbound: [tail] })).toBe(false);
		expect(shouldRebase({ needsRebase: false, tree: [tail], outbound: [tail] })).toBe(false);
		expect(shouldRebase({ needsRebase: true, tree: null, outbound: [tail] })).toBe(false);
	});
});
