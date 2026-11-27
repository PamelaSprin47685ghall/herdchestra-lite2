// The root scope must be reachable and interruptible through the same runtime
// table a child uses. The grouped host shape owns the abort verb; dropping it
// made every root interrupt a silent no-op. These tests pin both halves:
// shapeHost forwards session.abort, and a running js beat on "/" is interrupted
// by scope_request({ interrupt: true }).

import { describe, expect, test } from "bun:test";

import { shapeHost } from "../src/station/station.mjs";
import { handleRequestToolCall } from "../src/station/request-controls.mjs";
import { jsTicket } from "../src/tools/js-ticket.mjs";
import { createForkRegistry } from "../src/scope/fork-registry.mjs";
import { createBracketLedger } from "../src/scope/forkjoin.mjs";
import {
	REQUEST_INTERRUPT_REASON,
	clearRuntime,
	pendingRequestCount,
	registerRuntime,
	rejectPendingRequests,
	runtimeOf,
	runtimeTable,
} from "../src/scope/request-queue.mjs";

describe("the grouped host shape owns abort", () => {
	test("shapeHost keeps the session.abort the host supplied", () => {
		const seen = [];
		const host = shapeHost({
			session: { abort: (_ctx, reason) => seen.push(reason) },
		});
		expect(typeof host.session.abort).toBe("function");
		host.session.abort({}, "because");
		expect(seen).toEqual(["because"]);
	});
});

describe("a running root is interruptible", () => {
	test("scope_request({ interrupt: true }) aborts the root beat", async () => {
		const registry = createForkRegistry();
		const ledger = createBracketLedger();
		const controller = new AbortController();
		const aborts = [];
		const station = {
			registry,
			selfScopePath: () => "/",
			host: shapeHost({
				session: {
					abort: (_ctx, reason) => {
						aborts.push(reason);
						controller.abort(reason);
					},
				},
			}),
			beginJsCall: () => ({
				mode: "ROOT_AUTOPILOT",
				tools: [],
				state: {
					mode: "ROOT_AUTOPILOT",
					scope: "/",
					remaining: {},
					unreceived: 0,
					scopes: ["/"],
				},
				signature: "ROOT::",
			}),
			finishJsCall: () => {},
		};

		const ticket = jsTicket(
			station,
			"call-root",
			{ code: "await new Promise(() => {});" },
			{},
			controller.signal,
			{},
		);

		// registerRootBeat runs synchronously before the first await.
		expect(runtimeOf(registry, "/")?.state).toBe("running");
		expect(typeof runtimeOf(registry, "/")?.interrupt).toBe("function");

		const requester = {
			state: { scopes: [], autopilot: false, relay: { generation: 0, fullFlow: false } },
			forkLedgerPort: () => ledger,
			forkIdentityPort: () => ({ forkId: "f-0", path: "/api" }),
			registry,
			requestRuntime: runtimeTable(registry),
		};

		const pending = handleRequestToolCall(
			requester,
			{ id: "req-1", arguments: { target: "/", message: "status?", interrupt: true } },
			null,
		);

		expect(aborts).toEqual([REQUEST_INTERRUPT_REASON]);

		const result = await ticket;
		expect(result.isError).toBe(true);
		expect(result.details.code).toBe("JS_INTERRUPTED");
		expect(result.details.beat).toMatchObject({
			decision: "interrupt",
			reason: "explicit",
		});

		rejectPendingRequests(registry, "/", "test cleanup");
		clearRuntime(registry, "/");
		await pending.catch(() => {});
	});
});

function rootStation(registry, controller) {
	return {
		registry,
		selfScopePath: () => "/",
		host: shapeHost({
			session: {
				abort: (_ctx, reason) => controller.abort(reason),
			},
		}),
		beginJsCall: () => ({
			mode: "ROOT_AUTOPILOT",
			tools: [],
			state: {
				mode: "ROOT_AUTOPILOT",
				scope: "/",
				remaining: {},
				unreceived: 0,
				scopes: ["/"],
			},
			signature: "ROOT::",
		}),
		finishJsCall: () => {},
	};
}

describe("concurrent root beats do not overwrite each other", () => {
	test("the root stays running until the last beat leaves", async () => {
		const registry = createForkRegistry();
		const one = new AbortController();
		const two = new AbortController();
		const first = jsTicket(
			rootStation(registry, one),
			"call-one",
			{ code: "await new Promise(() => {});" },
			{},
			one.signal,
			{},
		);
		const second = jsTicket(
			rootStation(registry, two),
			"call-two",
			{ code: "await new Promise(() => {});" },
			{},
			two.signal,
			{},
		);

		const running = runtimeOf(registry, "/");
		expect(running?.state).toBe("running");
		expect(running?.beats).toBeInstanceOf(Set);
		expect(running.beats.size).toBe(2);

		one.abort(new Error("stop one"));
		const firstResult = await first;
		expect(firstResult.details.code).toBe("JS_INTERRUPTED");
		expect(runtimeOf(registry, "/")?.state).toBe("running");
		expect(runtimeOf(registry, "/")?.beats.size).toBe(1);

		two.abort(new Error("stop two"));
		await second;
		const idle = runtimeOf(registry, "/");
		expect(idle?.state).toBe("idle");
		expect(idle?.beats?.size ?? 0).toBe(0);
		clearRuntime(registry, "/");
	});
});

describe("an interrupted root drains its pending request", () => {
	test("the idle transition wakes the root once", async () => {
		const registry = createForkRegistry();
		const ledger = createBracketLedger();
		let wakes = 0;
		registerRuntime(registry, "/", {
			state: "idle",
			wake: () => {
				wakes += 1;
			},
		});
		const controller = new AbortController();
		const ticket = jsTicket(
			rootStation(registry, controller),
			"call-drain",
			{ code: "await new Promise(() => {});" },
			{},
			controller.signal,
			{},
		);
		expect(runtimeOf(registry, "/")?.state).toBe("running");

		const requester = {
			state: { scopes: [], autopilot: false, relay: { generation: 0, fullFlow: false } },
			forkLedgerPort: () => ledger,
			forkIdentityPort: () => ({ forkId: "f-0", path: "/api" }),
			registry,
			requestRuntime: runtimeTable(registry),
		};
		const pending = handleRequestToolCall(
			requester,
			{ id: "req-drain", arguments: { target: "/", message: "status?", interrupt: true } },
			null,
		);
		expect(wakes).toBe(0);

		const result = await ticket;
		expect(result.details.code).toBe("JS_INTERRUPTED");
		expect(wakes).toBe(1);
		expect(pendingRequestCount(registry, "/")).toBe(1);

		rejectPendingRequests(registry, "/", "test cleanup");
		clearRuntime(registry, "/");
		await pending.catch(() => {});
	});
});
