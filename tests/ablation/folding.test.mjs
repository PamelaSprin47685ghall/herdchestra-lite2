// Ablation contract: folding is a port, and the on/off choice is observable.
//
// `buildPorts` is the composition root's factory. A test that constructs
// `foldingOn()` directly proves the implementation, not the wiring. These
// cases go through the factory and then through the station's context
// transform, so removing the factory or bypassing the injected implementation
// fails the test.

import { expect, test } from "bun:test";

import { buildPorts } from "../../src/activation/ports.mjs";
import {
	addReceipt,
	attachReport,
	createReceiptRecord,
} from "../../src/scope/receipts.mjs";
import { FOLDED_MARKER } from "../../src/transcript/collapse.mjs";
import { SessionStation } from "../../src/station/station.mjs";

function receiptList() {
	let list = addReceipt(
		[],
		createReceiptRecord({
			forkToolCallId: "f1",
			closeToolCallId: "j1",
			levelKey: "L0",
			closedOrder: 1,
		}),
	);
	list = addReceipt(
		list,
		createReceiptRecord({
			forkToolCallId: "f2",
			closeToolCallId: "j2",
			levelKey: "L0",
			closedOrder: 2,
		}),
	);
	return attachReport(list, "j1", "elder summary");
}

const FULL_TEXT = "full child record for f1. ".repeat(20);

function messages() {
	return [
		{
			role: "toolResult",
			toolCallId: "j1",
			toolName: "scope_join",
			content: [{ type: "text", text: FULL_TEXT }],
		},
	];
}

test("folding off is a real ablation: no receipt is shortenable", () => {
	const ports = buildPorts({ HERD_FOLDING: "off" });
	expect(ports.ok).toBe(true);
	expect(ports.names.folding).toBe("off");

	const folding = ports.implementations.folding;
	expect(folding.foldable(receiptList())).toEqual([]);

	const source = messages();
	const folded = folding.apply(source, receiptList(), { foldable: [] });
	expect(folded.messages).toBe(source);
	expect(folded.collapsed).toEqual([]);
	expect(JSON.stringify(folded.messages)).not.toContain(FOLDED_MARKER);
});

test("folding on shortens the elder receipt through the same port", () => {
	const ports = buildPorts({ HERD_FOLDING: "on" });
	expect(ports.ok).toBe(true);
	expect(ports.names.folding).toBe("on");

	const receipts = receiptList();
	const folding = ports.implementations.folding;
	const foldable = folding.foldable(receipts);
	expect(foldable.map((entry) => entry.closeToolCallId)).toEqual(["j1"]);

	const folded = folding.apply(messages(), receipts, { foldable });
	expect(folded.collapsed).toEqual(["j1"]);
	expect(folded.messages[0].content[0].text).toContain(FOLDED_MARKER);
	expect(folded.messages[0].content[0].text).not.toContain(FULL_TEXT);
});

test("the station's transformContext asks the injected folding implementation", () => {
	const calls = [];
	const folding = {
		foldable() {
			calls.push("foldable");
			return [];
		},
		apply() {
			calls.push("apply");
			return { messages: [], collapsed: [] };
		},
	};
	const registry = {
		ports: () => ({ folding: "on" }),
		implementations: () => ({ folding }),
	};
	const station = new SessionStation(
		{ getSessionId: () => "s1", getBranch: () => [] },
		{},
		{},
		registry,
		null,
	);
	Object.assign(station.state, { receipts: [] });

	const result = station.transformContext([], {});
	expect(calls).toContain("foldable");
	expect(result.messages).toEqual([]);
});
