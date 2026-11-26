import { describe, expect, test } from "bun:test";

import { sameManager } from "../../host-omp/src/host/identity-adapters.mjs";

function station(manager) {
	return { manager };
}

describe("manager identity", () => {
	test("same manager object", () => {
		const manager = {};
		expect(sameManager(station(manager), { sessionManager: manager })).toBe(true);
	});

	test("same session id across proxies", () => {
		const manager = { getSessionId: () => "s1" };
		const proxy = { getSessionId: () => "s1" };
		expect(sameManager(station(manager), { sessionManager: proxy })).toBe(true);
	});

	test("different manager", () => {
		expect(sameManager(station({}), { sessionManager: {} })).toBe(false);
	});
});
