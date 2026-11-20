import { describe, expect, test } from "bun:test";

import { beginScope, createState } from "../src/scope/index.mjs";
import { handleScopeCall } from "../src/station/controls.mjs";
import { createStationRegistry } from "../src/station/registry.mjs";

const TWO_FLOWS = [
	{ intent: "first", budget: { read: 3, bash: 1 }, permission: "ro" },
	{ intent: "second", budget: { read: 2, bash: 1 }, permission: "rw" },
];

function batchBegin(fission = TWO_FLOWS) {
	return { stage: "architecture-design", elder_report: null, fission };
}

function openParent(state, budget = { read: 10, bash: 4 }) {
	const result = beginScope(state, {
		toolCallId: "call-open",
		intent: "owner",
		stage: "architecture-design",
		budget,
	});
	expect(result.ok).toBe(true);
	return result.scope;
}

function makeScheduler(overrides = {}) {
	const registered = [];
	const cancelled = [];
	const scheduler = {
		registered,
		cancelled,
		registerBatch(request) {
			registered.push(request);
			return { ok: true, batchId: "b1", batch: { id: "b1" }, batchBeginId: "entry-1" };
		},
		cancelBatch(batchId) {
			cancelled.push(batchId);
		},
		retireOwner() {
			return { ok: true };
		},
	};
	Object.assign(scheduler, overrides);
	return scheduler;
}

function makeStation({ state = createState(), scheduler = null, policy = "main", relayOn = false } = {}) {
	const station = {
		state,
		manager: { getSessionId: () => "session-1" },
		registry: { fissionScheduler: () => scheduler },
		policy: () => policy,
		relayOn: () => relayOn,
		pendingFission: null,
	};
	return station;
}

function ownerContext({ abort = true, id = "owner" } = {}) {
	const ctx = { agent: { kind: "main", id } };
	if (abort) {
		ctx.aborted = 0;
		ctx.abort = () => {
			ctx.aborted += 1;
		};
	}
	return ctx;
}

function scopeCall(id, args) {
	return { id, name: "scope", arguments: args };
}

function call(station, id, args, ctx = ownerContext()) {
	return handleScopeCall(station, scopeCall(id, args), { ctx });
}

describe("fission begin control", () => {
	test("registers with the scheduler, reserves once, and installs the stop guard", () => {
		const state = createState();
		const parent = openParent(state);
		const scheduler = makeScheduler();
		const station = makeStation({ state, scheduler });
		const ctx = ownerContext();

		const result = handleScopeCall(station, scopeCall("call-begin", { begin: batchBegin() }), { ctx });

		expect(result.isError).toBeUndefined();
		expect(result.details).toEqual({ batchId: "b1", flows: 2 });
		expect(scheduler.registered).toHaveLength(1);
		const request = scheduler.registered[0];
		expect(request.toolCallId).toBe("call-begin");
		expect(request.sessionManager).toBe(station.manager);
		expect(request.station).toBe(station);
		expect(request.ctx).toBe(ctx);
		expect(request.nested).toBe(false);
		expect(request.mainAgent).toBe(true);
		expect(request.stage).toBe("architecture-design");
		expect(request.totals).toEqual({ read: 5, bash: 2 });
		expect(request.flows.map((item) => item.intent)).toEqual(["first", "second"]);
		// The reservation is the only debit: the scheduler must not charge again.
		expect(parent.remaining).toEqual({ read: 5, bash: 2 });
		expect(station.pendingFission).toMatchObject({
			batchId: "b1",
			toolCallId: "call-begin",
			stage: "architecture-design",
			retired: false,
		});
		expect(station.pendingFission.flows.map((item) => item.intent)).toEqual(["first", "second"]);
		expect(result.content[0].text).toContain("Fission batch b1 registered with 2 flow(s) in architecture-design.");
	});

	test("refuses when the host exposes no abort and touches nothing", () => {
		const state = createState();
		openParent(state);
		const before = structuredClone(state);
		const scheduler = makeScheduler();
		const station = makeStation({ state, scheduler });

		const result = call(station, "call-begin", { begin: batchBegin() }, ownerContext({ abort: false }));

		expect(result.isError).toBe(true);
		expect(result.details.code).toBe("FISSION_UNAVAILABLE");
		expect(scheduler.registered).toHaveLength(0);
		expect(station.pendingFission).toBeNull();
		expect(state).toEqual(before);
	});

	test("refuses when no scheduler port is attached", () => {
		const state = createState();
		openParent(state);
		const before = structuredClone(state);
		const station = makeStation({ state, scheduler: null });

		const result = call(station, "call-begin", { begin: batchBegin() });

		expect(result.details.code).toBe("FISSION_UNAVAILABLE");
		expect(station.pendingFission).toBeNull();
		expect(state).toEqual(before);
	});

	test("rejects a malformed end before the fission branch runs", () => {
		for (const end of ["yes", 1, {}]) {
			const state = createState();
			openParent(state);
			const before = structuredClone(state);
			const scheduler = makeScheduler();
			const station = makeStation({ state, scheduler });

			const result = call(station, "call-begin", { begin: batchBegin(), end });

			expect(result.isError).toBe(true);
			expect(result.details.code).toBe("INVALID_ARGUMENT");
			expect(scheduler.registered).toHaveLength(0);
			expect(state).toEqual(before);
		}
	});

	test("rejects a fission begin that also closes a scope", () => {
		const state = createState();
		openParent(state);
		const scheduler = makeScheduler();
		const station = makeStation({ state, scheduler });

		const result = call(station, "call-begin", { begin: batchBegin(), end: true });

		expect(result.details.code).toBe("INVALID_ARGUMENT");
		expect(result.content[0].text).toContain("A fission begin cannot also close a scope.");
		expect(scheduler.registered).toHaveLength(0);
		expect(station.pendingFission).toBeNull();
	});

	test("refuses a second batch until the first has retired", () => {
		const state = createState();
		openParent(state);
		const before = structuredClone(state);
		const scheduler = makeScheduler();
		const station = makeStation({ state, scheduler });
		const pending = { batchId: "b0", toolCallId: "older", retired: false };
		station.pendingFission = pending;

		const result = call(station, "call-begin", { begin: batchBegin() });

		expect(result.details.code).toBe("FISSION_BATCH_PENDING");
		expect(scheduler.registered).toHaveLength(0);
		expect(station.pendingFission).toBe(pending);
		expect(state).toEqual(before);
	});

	test("surfaces a thrown scheduler refusal instead of flattening it to unavailable", () => {
		const state = createState();
		openParent(state);
		const before = structuredClone(state);
		const scheduler = makeScheduler({
			registerBatch() {
				const error = new Error("the shared journal already holds a live batch");
				error.code = "FISSION_SCHEDULER_BUSY";
				throw error;
			},
		});
		const station = makeStation({ state, scheduler });

		const result = call(station, "call-begin", { begin: batchBegin() });

		expect(result.isError).toBe(true);
		expect(result.details.code).toBe("FISSION_SCHEDULER_BUSY");
		expect(result.content[0].text).toContain("the shared journal already holds a live batch");
		expect(station.pendingFission).toBeNull();
		expect(state).toEqual(before);
	});

	test("keeps a returned scheduler refusal code and leaves the state unchanged", () => {
		const state = createState();
		openParent(state);
		const before = structuredClone(state);
		const scheduler = makeScheduler({
			registerBatch() {
				return { ok: false, code: "FISSION_UNSUPPORTED", reason: "no flow sessions" };
			},
		});
		const station = makeStation({ state, scheduler });

		const result = call(station, "call-begin", { begin: batchBegin() });

		expect(result.details.code).toBe("FISSION_UNSUPPORTED");
		expect(result.content[0].text).toContain("no flow sessions");
		expect(station.pendingFission).toBeNull();
		expect(state).toEqual(before);
	});
});

describe("fission flow scope control", () => {
	test("a flow cannot open or close its own scope", () => {
		const scheduler = makeScheduler();
		const station = makeStation({ state: createState(), scheduler });
		station.fissionFlow = { id: "flow-a" };

		const begin = call(station, "call-flow-begin", {
			begin: { intent: "slice", stage: "architecture-design", budget: { read: 1 } },
		});
		const end = call(station, "call-flow-end", { end: true });

		expect(begin.details.code).toBe("SCOPE_UNAVAILABLE_IN_FISSION");
		expect(end.details.code).toBe("SCOPE_UNAVAILABLE_IN_FISSION");
		expect(scheduler.registered).toHaveLength(0);
	});

	test("a flow may register one nested fission batch", () => {
		const scheduler = makeScheduler();
		const station = makeStation({ state: createState(), scheduler });
		station.fissionFlow = { id: "flow-a" };

		const result = call(
			station,
			"call-nested",
			{ begin: batchBegin([{ intent: "inner", budget: { read: 1 }, permission: "ro" }]) },
			ownerContext({ id: "flow-a" }),
		);

		expect(result.isError).toBeUndefined();
		expect(scheduler.registered).toHaveLength(1);
		expect(scheduler.registered[0].nested).toBe(true);
		expect(station.pendingFission.batchId).toBe("b1");
	});
});

describe("station registry fission bindings", () => {
	test("binds a flow by its identity string and routes the flow station", () => {
		const registry = createStationRegistry(null);
		const manager = { getSessionId: () => "session-1" };
		const station = { manager };

		const entry = registry.bindFlow(
			{ kind: "flow", id: "flow-a" },
			station,
			"ro",
			{ batchId: "b1", index: 0, label: "b1.0", manager },
		);

		expect(entry.id).toBe("flow-a");
		expect(entry.station).toBe(station);
		expect(entry.permission).toBe("ro");
		expect(entry.batchId).toBe("b1");
		expect(entry.index).toBe(0);
		expect(entry.label).toBe("b1.0");
		expect(station.fissionFlow).toBe(entry);
		expect(registry.flowFor("flow-a")).toBe(entry);
		expect(registry.flowFor({ id: "flow-a" })).toBe(entry);
		expect(registry.stationForAgent({ id: "flow-a" })).toBe(station);
		expect(registry.stationFor({ agent: { id: "flow-a" } })).toBe(station);
		expect(registry.stationForStop({ agent: { id: "flow-a" } })).toBe(station);
		expect(registry.flows()).toEqual([entry]);

		registry.unbindFlow({ id: "flow-a" });
		expect(station.fissionFlow).toBeUndefined();
		expect(registry.flowFor("flow-a")).toBeNull();
		expect(registry.flows()).toEqual([]);
	});

	test("accepts a bare id and refuses a missing identity, bad permission, or second bind", () => {
		const registry = createStationRegistry(null);
		const station = {};

		expect(() => registry.bindFlow(null, station, "ro")).toThrow(TypeError);
		expect(() => registry.bindFlow({}, station, "ro")).toThrow(TypeError);
		expect(() => registry.bindFlow("flow-x", station, "write")).toThrow(TypeError);
		registry.bindFlow("flow-x", station, "rw");
		expect(station.fissionFlow.permission).toBe("rw");
		expect(() => registry.bindFlow("flow-x", {}, "ro")).toThrow("already bound");
		expect(() => registry.bindFlow("flow-y", station, "ro")).toThrow("already bound");
		registry.unbindFlow("flow-x");
		expect(registry.flowFor("flow-x")).toBeNull();
	});

	test("shares one scheduler port with other extension instances", () => {
		const first = createStationRegistry(null);
		const second = createStationRegistry(null);
		first.setFissionScheduler(null);
		expect(first.fissionScheduler()).toBeNull();
		expect(second.fissionScheduler()).toBeNull();
		expect(() => first.setFissionScheduler({})).toThrow(TypeError);
		const port = { registerBatch() {} };
		expect(first.setFissionScheduler(port)).toBe(port);
		expect(first.fissionScheduler()).toBe(port);
		// A flow's extension instance builds its own registry but must read the
		// owner's port back from the process.
		expect(second.fissionScheduler()).toBe(port);
		first.setFissionScheduler(null);
		expect(second.fissionScheduler()).toBeNull();
	});

	test("routes a flow bound through another registry instance", () => {
		const owner = createStationRegistry(null);
		const flow = createStationRegistry(null);
		const station = {};
		owner.bindFlow("flow-global", station, "ro");
		expect(flow.flowFor("flow-global")).not.toBeNull();
		expect(flow.stationFor({ agent: { id: "flow-global" } })).toBe(station);
		owner.unbindFlow({ id: "flow-global" });
		expect(flow.flowFor("flow-global")).toBeNull();
	});
});
