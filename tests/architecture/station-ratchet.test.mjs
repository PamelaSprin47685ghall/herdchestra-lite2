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
const settle = methodBody("settleReceiptFolds");
const rebase = methodBody("maybeRebase");

describe("context ratchet", () => {
	test("transformContext commits once and delegates the decision", () => {
		expect(transform.length).toBeGreaterThan(0);
		expect(count(transform, /this\.state\.[A-Za-z0-9_$]+\s*=/g)).toBe(1);
		expect(count(transform, /this\.state\.receipts\s*=/g)).toBe(1);
		expect(count(transform, /this\.(settleReceiptFolds|maybeRebase)\(/g)).toBe(0);
		expect(transform).toContain("projectContext(");
	});

	test("the compatibility methods use the pure decisions", () => {
		expect(settle).toContain("settleReceipts(");
		expect(settle).not.toContain("markCollapsed(");
		expect(rebase).toContain("shouldRebase(");
		expect(rebase).not.toContain("sameTail(");
	});

	test("receipt writes do not grow past the post-slice baseline", () => {
		expect(count(source, /this\.state\.receipts\s*=/g)).toBeLessThanOrEqual(4);
	});

	test("the context compatibility methods are not one-line station forwarders", () => {
		const forwarder = /^\{\s*return [A-Za-z0-9_$]+\(this,/;
		expect(forwarder.test(settle.trim())).toBe(false);
		expect(forwarder.test(rebase.trim())).toBe(false);
	});
});
