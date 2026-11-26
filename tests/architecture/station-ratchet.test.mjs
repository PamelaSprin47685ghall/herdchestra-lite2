// Narrow Phase 4a ratchet: the context slice moves decisions into
// `src/station/domain/context.mjs` and leaves a single commit block in the
// Station. Later slices may lower these bounds; none may raise them.

import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(
	new URL("../../src/station/station.mjs", import.meta.url),
	"utf8",
);

function methodBody(name) {
	const marker = `\n\t${name}(`;
	const start = source.indexOf(marker);
	if (start < 0) return "";
	const open = source.indexOf("{", start + marker.length - 1);
	if (open < 0) return "";
	let depth = 0;
	for (let index = open; index < source.length; index += 1) {
		if (source[index] === "{") depth += 1;
		else if (source[index] === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(open, index + 1);
		}
	}
	return "";
}

function count(text, pattern) {
	return [...text.matchAll(pattern)].length;
}

const transform = methodBody("transformContext");
const rebase = methodBody("maybeRebase");

describe("context ratchet", () => {
	test("transformContext delegates to the pure projection", () => {
		expect(transform.length).toBeGreaterThan(0);
		expect(transform).toContain("projectContext(");
		expect(count(transform, /this\.state\.[A-Za-z0-9_$]+\s*=/g)).toBe(0);
		expect(count(transform, /this\.(settleReceiptFolds|maybeRebase)\(/g)).toBe(0);
	});

	test("the compatibility method uses the pure decision", () => {
		expect(rebase).toContain("shouldRebase(");
		expect(rebase).not.toContain("sameTail(");
	});

	test("no receipt writes remain in the station", () => {
		expect(count(source, /this\.state\.receipts\s*=/g)).toBe(0);
	});

	test("the compatibility method is not a one-line station forwarder", () => {
		const forwarder = /^\{\s*return [A-Za-z0-9_$]+\(this,/;
		expect(forwarder.test(rebase.trim())).toBe(false);
	});
});

// The capability projection is the one source of truth for the js protocol:
// the per-turn REPL probe, the frozen binding the vm receives, and the cache
// signature must all come out of `projectionFor`. A second builder would let
// the printed api and the bound api drift apart, and the model would call a
// name the probe just showed.
describe("capability projection ratchet", () => {
	const projection = methodBody("projectionFor");
	const receipt = methodBody("skillReceipt");
	const precheck = methodBody("beginJsCall");

	test("the probe, the vm binding, and the cache signature share one projection", () => {
		expect(projection).toContain("projectCapabilities(");
		for (const body of [receipt, precheck]) {
			expect(body.length).toBeGreaterThan(0);
			expect(body).toContain("projectionFor(");
		}
		// No second projection: `projectCapabilities` is called once, inside
		// `projectionFor`, and every consumer goes through it.
		expect(count(source, /projectCapabilities\(/g)).toBe(1);
		// The receipt is the only renderer of the REPL probe.
		expect(count(source, /renderConsoleReceipt\(/g)).toBe(1);
		expect(receipt).toContain("renderConsoleReceipt(");
	});
});

// Ticket Station Method, applied to the new tool: the js ticket awaits, the
// station never does. `beginJsCall` produces the frozen projection,
// `finishJsCall` settles the beat, and the request translation only queues and
// hands back a Promise — all four are plain synchronous methods.
describe("the js call seam is synchronous", () => {
	for (const name of [
		"beginJsCall",
		"finishJsCall",
		"handleScopeRequest",
		"handleScopeReply",
		"capabilitySnapshot",
	]) {
		test(`${name} neither awaits nor is declared async`, () => {
			const body = methodBody(name);
			expect(body.length).toBeGreaterThan(0);
			expect(body).not.toMatch(/\basync\b/);
			expect(body).not.toMatch(/\bawait\b/);
		});
	}

	test("no station method is declared async", () => {
		// The class holds the persisted state and must stay atomic under the
		// single-threaded run-to-completion rule; every wait belongs to a ticket.
		expect(count(source, /^\tasync\s+[A-Za-z_$]/gm)).toBe(0);
		expect(count(source, /^\t[A-Za-z_$][\w$]*\([^)]*\)\s*\{\s*$/gm)).toBeGreaterThan(20);
	});
});
