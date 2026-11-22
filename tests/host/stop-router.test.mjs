import { describe, expect, test } from "bun:test";

import { sameManager, selectStopStation } from "../../host-omp/src/host/identity-adapters.mjs";

function station(manager, handoffPending = false) {
	return { manager, state: { relay: { handoffPending } } };
}

describe("stop routing", () => {
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

	test("current station already owns the handoff", () => {
		const current = station({}, true);
		const selected = selectStopStation({
			station: current,
			pendingStation: station({}),
			ctx: {},
		});
		expect(selected).toEqual({ station: current, clearPending: false });
	});

	test("pending station on the same manager wins when armed", () => {
		const manager = {};
		const current = station(manager);
		const pending = station(manager, true);
		const selected = selectStopStation({
			station: current,
			pendingStation: pending,
			ctx: { sessionManager: manager },
		});
		expect(selected).toEqual({ station: pending, clearPending: false });
	});

	test("pending station on another manager is cleared", () => {
		const current = station({});
		const pending = station({}, true);
		const selected = selectStopStation({
			station: current,
			pendingStation: pending,
			ctx: { sessionManager: {} },
		});
		expect(selected).toEqual({ station: current, clearPending: true });
	});

	test("no pending station returns the current one", () => {
		const current = station({});
		expect(
			selectStopStation({ station: current, pendingStation: null, ctx: {} }),
		).toEqual({ station: current, clearPending: false });
	});
});
