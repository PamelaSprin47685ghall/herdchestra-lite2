// Phase 1 contracts: the station's sync surface must not dispatch a ticket
// from a query, and every detached ticket must consume its own rejection.
//
// These are behavioral contracts, not source scans. `policy()` is called by
// several readers; one of them must not be the place that grants `todo`.
// `syncTodo()` is the only place that grants it, and the grant is a
// fire-and-forget ticket: a rejection or a synchronous throw must reach the
// diagnostics ring instead of becoming an unhandled promise rejection.

import { beforeEach, expect, test } from "bun:test";

import {
	reset as resetDiagnostics,
	snapshot as diagnosticsSnapshot,
} from "../src/host/diagnostics.mjs";
import { READ_WRITE_SUBAGENT } from "../src/host/policy.mjs";
import { activate } from "../src/main.mjs";
import { SessionStation } from "../src/station/station.mjs";

function rwContext() {
	const branch = [
		{
			type: "session_init",
			agent: "worker",
			readOnly: false,
			tools: ["read", "write"],
		},
	];
	return {
		sessionManager: {
			getSessionId: () => "s1",
			getBranch: () => branch,
		},
	};
}

function stationWith(tickets, pi = { getActiveTools: () => ["read"] }) {
	return new SessionStation(
		{ getSessionId: () => "s1", getBranch: () => [] },
		pi,
		tickets,
		{ ports: () => ({}) },
		null,
	);
}

function compositionHost() {
	const handlers = new Map();
	return {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		registerTool() {},
		registerCommand() {},
		sendUserMessage() {
			return Promise.resolve();
		},
	};
}

beforeEach(() => resetDiagnostics());

test("policy() is a query and never calls syncTodo", () => {
	const station = stationWith({ activateTools: () => Promise.resolve() });
	station.syncTodo = () => {
		throw new Error("policy dispatched the todo grant");
	};
	expect(() => station.policy(rwContext())).not.toThrow();
});

test("policy() is a query and never dispatches the todo grant", () => {
	let calls = 0;
	const station = stationWith({
		activateTools: () => {
			calls += 1;
			return Promise.resolve();
		},
	});

	station.policy(rwContext());
	expect(calls).toBe(0);

	station.ensureTools(rwContext());
	expect(calls).toBe(1);
});

test("ensureTools grants todo once per active tool set", () => {
	let calls = 0;
	const station = stationWith({
		activateTools: () => {
			calls += 1;
			return Promise.resolve();
		},
	});

	station.ensureTools(rwContext());
	station.ensureTools(rwContext());
	expect(calls).toBe(1);
});

test("a rejecting activateTools ticket is recorded, not left unhandled", async () => {
	const station = stationWith({
		activateTools: () => Promise.reject(new Error("activation moved")),
	});

	station.syncTodo(READ_WRITE_SUBAGENT);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(diagnosticsSnapshot().some((entry) => entry.domain === "tickets")).toBe(true);
});

test("a synchronous throw from the ticket capability is recorded, not thrown", () => {
	const station = stationWith({
		activateTools: () => {
			throw new Error("capability is not installed");
		},
	});

	expect(() => station.syncTodo(READ_WRITE_SUBAGENT)).not.toThrow();
	expect(diagnosticsSnapshot().some((entry) => entry.domain === "tickets")).toBe(true);
});

test("the production entry injects the off port implementations", async () => {
	const wired = await activate(compositionHost(), {
		HERD_FOLDING: "off",
		HERD_CLOCK: "off",
	});
	expect(wired.registry.ports().folding).toBe("off");
	expect(wired.registry.ports().clock).toBe("off");
	const { folding, clock } = wired.registry.implementations();
	expect(folding.name).toBe("off");
	expect(clock.name).toBe("off");
});

test("the production entry injects the on port implementations by default", async () => {
	const wired = await activate(compositionHost(), {});
	expect(wired.registry.ports().folding).toBe("on");
	expect(wired.registry.ports().clock).toBe("on");
	const { folding, clock } = wired.registry.implementations();
	expect(folding.name).toBe("on");
	expect(clock.name).toBe("on");
});
