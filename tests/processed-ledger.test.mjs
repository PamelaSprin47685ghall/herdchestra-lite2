// The processed ledger is the idempotence cache for repeated host events.
// All three collections must stay bounded; an unbounded Set is a slow leak in
// a session that runs for hours.

import { describe, expect, test } from "bun:test";

import { createProcessedLedger } from "../src/station/processed-ledger.mjs";

describe("processed ledger bounds", () => {
	test("keeps the call cache bounded and drops the oldest id", () => {
		const ledger = createProcessedLedger();
		for (let index = 0; index < 600; index += 1) ledger.markCall(`call-${index}`);

		expect(ledger.hasCall("call-0")).toBe(false);
		expect(ledger.hasCall("call-599")).toBe(true);
	});

	test("refreshes an active id so it survives eviction", () => {
		const ledger = createProcessedLedger();
		for (let index = 0; index < 511; index += 1) ledger.markCall(`call-${index}`);

		// Refresh the oldest entry, then push two more: the refreshed id must
		// outlive the untouched neighbour.
		ledger.markCall("call-0");
		ledger.markCall("call-511");
		ledger.markCall("call-512");

		expect(ledger.hasCall("call-0")).toBe(true);
		expect(ledger.hasCall("call-1")).toBe(false);
	});

	test("keeps the message cache bounded", () => {
		const ledger = createProcessedLedger();
		for (let index = 0; index < 600; index += 1) ledger.markMessage(`message-${index}`);

		expect(ledger.hasMessage("message-0")).toBe(false);
		expect(ledger.hasMessage("message-599")).toBe(true);
	});

	test("refreshes an active message key", () => {
		const ledger = createProcessedLedger();
		for (let index = 0; index < 511; index += 1) ledger.markMessage(`message-${index}`);

		ledger.markMessage("message-0");
		ledger.markMessage("message-511");
		ledger.markMessage("message-512");

		expect(ledger.hasMessage("message-0")).toBe(true);
		expect(ledger.hasMessage("message-1")).toBe(false);
	});
});
