import { describe, expect, test } from "bun:test";
import {
	CHECKPOINT_EVERY,
	applyDelta,
	createState,
	deserializeState,
	diffState,
	foldStateChain,
	planStateEntry,
	serializeState,
} from "../src/scope/index.mjs";
import { SESSION_STATE_TYPE, restoreState } from "../src/station/restore.mjs";
import { reset as resetDiagnostics, snapshot as diagnosticsSnapshot } from "../src/host/diagnostics.mjs";

// Deterministic PRNG so a failing round-trip reproduces exactly.
function mulberry32(seed) {
	let value = seed >>> 0;
	return () => {
		value = (value + 0x6d2b79f5) >>> 0;
		let t = value;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function makeManager(entries = []) {
	const branch = entries.map((entry, index) => ({
		type: "custom",
		customType: SESSION_STATE_TYPE,
		parentId: index === 0 ? null : `entry-${index - 1}`,
		id: `entry-${index}`,
		data: entry,
	}));
	return {
		getBranch: () => branch.slice(),
		buildSessionContext: () => ({ messages: [] }),
	};
}

function randomState(random) {
	const state = createState();
	state.seq = Math.floor(random() * 1000);
	state.epoch = Math.floor(random() * 5);
	state.herdMode = random() > 0.5;
	state.pins = Array.from({ length: Math.floor(random() * 4) }, (_, index) => `pin-${index}`);
	state.regrets = Array.from({ length: Math.floor(random() * 3) }, (_, index) => `call-${index}`);
	state.collapses = Array.from({ length: Math.floor(random() * 3) }, (_, index) => ({
		beginToolCallId: `begin-${index}`,
		endToolCallId: `end-${index}`,
		report: `report-${index}`,
		createdAt: 1000 + index,
		collapsed: index % 2 === 0,
	}));
	return serializeState(state);
}

describe("state deltas", () => {
	test("200 random transitions round-trip exactly", () => {
		const random = mulberry32(20261119);
		let prev = randomState(random);
		for (let step = 0; step < 200; step += 1) {
			const next = randomState(random);
			const ops = diffState(prev, next);
			expect(applyDelta(prev, ops)).toEqual(next);
			prev = next;
		}
	});

	test("applyDelta leaves the base untouched", () => {
		const random = mulberry32(7);
		const base = randomState(random);
		const snapshot = JSON.stringify(base);
		const next = { ...base, seq: 999, herdMode: !base.herdMode };
		applyDelta(base, diffState(base, next));
		expect(JSON.stringify(base)).toBe(snapshot);
	});

	test("an identical state produces no operations", () => {
		const random = mulberry32(11);
		const state = randomState(random);
		expect(diffState(state, state)).toEqual([]);
		expect(planStateEntry(state, state, 0)).toBeNull();
	});

	test("removed keys become del operations", () => {
		const ops = diffState({ a: 1, b: 2 }, { a: 1 });
		expect(ops).toEqual([{ op: "del", path: ["b"] }]);
	});

	test("a longer array appends, a shorter one truncates", () => {
		const grown = diffState({ list: [1] }, { list: [1, 2] });
		expect(grown).toEqual([{ op: "set", path: ["list", 1], value: 2 }]);
		const shrunk = diffState({ list: [1, 2, 3] }, { list: [1] });
		expect(shrunk).toEqual([{ op: "trunc", path: ["list"], length: 1 }]);
	});
});

describe("checkpoint policy", () => {
	const base = serializeState(createState());

	test("the first entry is a checkpoint", () => {
		const entry = planStateEntry(null, base, 0);
		expect(entry.kind).toBe("checkpoint");
		expect(entry.state).toEqual(base);
	});

	test("a small change becomes a delta", () => {
		const entry = planStateEntry(base, { ...base, seq: 4 }, 0);
		expect(entry.kind).toBe("delta");
		expect(entry.ops.length).toBeLessThanOrEqual(32);
	});

	test("a rewrite at the cadence boundary becomes a checkpoint", () => {
		const entry = planStateEntry(base, { ...base, seq: 4 }, CHECKPOINT_EVERY - 1);
		expect(entry.kind).toBe("checkpoint");
	});

	test("too many operations become a checkpoint", () => {
		const next = {
			...base,
			pins: Array.from({ length: 40 }, (_, index) => `pin-${index}`),
		};
		expect(planStateEntry(base, next, 0).kind).toBe("checkpoint");
	});

	test("a delta is much smaller than the snapshot it replaces", () => {
		const next = { ...base, seq: base.seq + 1 };
		const delta = planStateEntry(base, next, 0);
		expect(JSON.stringify(delta).length).toBeLessThan(
			JSON.stringify(base).length / 2,
		);
	});
});

describe("chain replay", () => {
	test("a checkpoint plus deltas rebuilds the final state", () => {
		const start = serializeState(createState());
		const middle = { ...start, seq: 2, pins: ["one"] };
		const end = { ...middle, seq: 3, herdMode: true };
		const chain = [
			{ version: 2, kind: "checkpoint", state: start },
			{ version: 2, kind: "delta", ops: diffState(start, middle) },
			{ version: 2, kind: "delta", ops: diffState(middle, end) },
		];
		expect(foldStateChain(chain)).toEqual(end);
	});

	test("a delta with no anchor reports null", () => {
		const start = serializeState(createState());
		const ops = diffState(start, { ...start, seq: 1 });
		expect(foldStateChain([{ version: 2, kind: "delta", ops }])).toBeNull();
	});

	test("a legacy snapshot is its own anchor", () => {
		const legacy = serializeState(createState());
		expect(foldStateChain([legacy])).toEqual(legacy);
	});
});

describe("restore from the session tree", () => {
	test("replays a delta chain written by the station", () => {
		const start = serializeState(createState());
		const middle = { ...start, seq: 5 };
		const end = { ...middle, pins: ["shipped"] };
		const manager = makeManager([
			{ version: 2, kind: "checkpoint", state: start },
			{ version: 2, kind: "delta", ops: diffState(start, middle) },
			{ version: 2, kind: "delta", ops: diffState(middle, end) },
		]);
		const restored = restoreState(manager);
		expect(restored.seq).toBe(5);
		expect(restored.pins).toEqual(["shipped"]);
	});

	test("still reads a legacy full snapshot", () => {
		const state = createState();
		state.seq = 42;
		state.pins = ["legacy"];
		const manager = makeManager([serializeState(state)]);
		const restored = restoreState(manager);
		expect(restored.seq).toBe(42);
		expect(restored.pins).toEqual(["legacy"]);
	});

	test("an unanchored chain falls back to an empty state and records why", () => {
		resetDiagnostics();
		const start = serializeState(createState());
		const ops = diffState(start, { ...start, seq: 1 });
		const manager = makeManager([{ version: 2, kind: "delta", ops }]);
		const restored = restoreState(manager);
		expect(restored.seq).toBe(0);
		const entries = diagnosticsSnapshot();
		expect(entries.at(-1).domain).toBe("restore");
		expect(entries.at(-1).message).toContain("no checkpoint");
	});

	test("an anchor beyond the replay window is still found", () => {
		const start = serializeState(createState());
		let state = start;
		const entries = [{ version: 2, kind: "checkpoint", state: start }];
		for (let step = 0; step < 100; step += 1) {
			const next = { ...state, seq: step + 1 };
			entries.push({ version: 2, kind: "delta", ops: diffState(state, next) });
			state = next;
		}
		const restored = restoreState(makeManager(entries));
		expect(restored.seq).toBe(100);
	});

	test("an empty branch yields a fresh state", () => {
		expect(restoreState(makeManager([])).seq).toBe(0);
	});

	test("deserializeState still accepts the replayed payload", () => {
		const state = createState();
		state.seq = 9;
		const payload = foldStateChain([serializeState(state)]);
		expect(deserializeState(payload).seq).toBe(9);
	});
});
