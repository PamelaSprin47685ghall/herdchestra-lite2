// The one working-level control tool: a note, an amend, or both.
//
// The contract is the shape: `pin` and `amend` are optional objects, the
// runtime refuses a call that names neither, and the amend half lands first so
// its refund is in the ledger before the note is saved.

import { describe, expect, test } from "bun:test";

import { wireTools } from "../src/activation/tools.mjs";
import { createToolCallLedger } from "../src/station/domain/tool-call-ledger.mjs";
import { executeContext } from "../src/station/execute.mjs";
import { scopeContextParameters } from "../src/tools/descriptions.mjs";
import { textResult } from "../src/tools/results.mjs";
import { scopeContextTicket } from "../src/tools/tickets.mjs";

function registeredTools() {
	const tools = new Map();
	wireTools({ registerTool: (tool) => tools.set(tool.name, tool) }, {});
	return tools;
}

function fakeStation(results = {}) {
	const order = [];
	const seen = [];
	const station = {
		toolCallLedger: createToolCallLedger(),
		state: {},
		executeAmend(id, params) {
			order.push("amend");
			seen.push(["amend", id, params]);
			return results.amend ?? textResult("amended");
		},
		executePin(id, params) {
			order.push("pin");
			seen.push(["pin", id, params]);
			return results.pin ?? textResult("pinned");
		},
		order,
		seen,
	};
	return station;
}

describe("scope_context registration", () => {
	test("one tool replaces the retired pin and amend names", () => {
		const tools = registeredTools();
		expect(tools.has("scope_context")).toBe(true);
		expect(tools.has("pin")).toBe(false);
		expect(tools.has("amend")).toBe(false);
	});

	test("both halves are optional, and the call must name one", () => {
		expect(scopeContextParameters.required).toBeUndefined();
		expect(scopeContextParameters.anyOf).toEqual([
			{ required: ["pin"] },
			{ required: ["amend"] },
		]);
		expect(scopeContextParameters.properties.pin.description).toContain("durable note");
		expect(scopeContextParameters.properties.amend.description).toContain("completed beat");
	});

	test("each half keeps its old argument schema", () => {
		const { pin, amend } = scopeContextParameters.properties;
		expect(pin.anyOf).toHaveLength(5);
		expect(pin.properties.finding.pattern).toBe("\\S");
		expect(amend.required).toEqual(["reflection"]);
		expect(amend.properties.reflection.minLength).toBe(1);
	});
});

describe("scope_context execution", () => {
	test("both halves run, amend first, under derived cache keys", () => {
		const station = fakeStation();
		const out = executeContext(station, "call-1", {
			amend: { reflection: "drop the search" },
			pin: { conclusion: "ship it" },
		});

		expect(station.order).toEqual(["amend", "pin"]);
		expect(station.seen).toEqual([
			["amend", "call-1#amend", { reflection: "drop the search" }],
			["pin", "call-1#pin", { conclusion: "ship it" }],
		]);
		expect(out.isError).toBeUndefined();
		expect(out.details.scopeContext).toBe(true);
		expect(out.content[0].text).toContain("amended");
		expect(out.content[0].text).toContain("pinned");
	});

	test("a retry of the same call returns the cached composite", () => {
		const station = fakeStation();
		const params = { pin: { finding: "kept" } };
		const first = executeContext(station, "call-1", params);
		const second = executeContext(station, "call-1", params);

		expect(second).toEqual(first);
		expect(station.order).toEqual(["pin"]);
	});

	test("an amend the direct path already answered is not repeated", () => {
		const station = fakeStation();
		const direct = textResult("amended by the scan path");
		station.toolCallLedger.setHandled("call-1", direct);

		const out = executeContext(station, "call-1", {
			amend: { reflection: "already done" },
			pin: { finding: "kept" },
		});

		expect(station.order).toEqual(["pin"]);
		expect(out.content[0].text).toContain("amended by the scan path");
	});

	test("a failed half still lets the other land and marks the result", () => {
		const station = fakeStation({
			amend: textResult("refused"),
		});
		station.executeAmend = () => ({
			isError: true,
			content: [{ type: "text", text: "AMEND_UNAVAILABLE: off" }],
			details: { code: "AMEND_UNAVAILABLE" },
		});

		const out = executeContext(station, "call-1", {
			amend: { reflection: "retired" },
			pin: { finding: "kept" },
		});

		expect(station.order).toEqual(["pin"]);
		expect(out.isError).toBe(true);
		expect(out.details.code).toBe("scope_context-partial");
		expect(out.content[0].text).toContain("AMEND_UNAVAILABLE");
		expect(out.content[0].text).toContain("pinned");
	});

	test("a call that names neither half is refused before any station work", async () => {
		const station = fakeStation();
		const out = await scopeContextTicket(station, "call-1", {});

		expect(out.isError).toBe(true);
		expect(out.details.code).toBe("scope_context-empty");
		expect(station.order).toEqual([]);
	});

	test("a JSON-string payload is parsed before the halves are chosen", async () => {
		const station = fakeStation();
		station.executeContext = (id, params) => executeContext(station, id, params);

		const out = await scopeContextTicket(
			station,
			"call-1",
			JSON.stringify({ pin: { finding: "kept" } }),
		);

		expect(out.isError).toBeUndefined();
		expect(station.order).toEqual(["pin"]);
	});
});
