// A process restart is not a new birth.
//
// The nudge threshold is `(window - birth) / 2 + birth`. The birth context is
// measured once, on the scope's first measured request, and only a real rewind,
// compact or handoff may replace it. Killing the process and resuming the same
// session changes no transcript and drops no scope history, so it must restore
// the birth the session was born with instead of re-baselining on the first
// response after the reload. Otherwise every restart ratchets the midpoint up
// and a scope can escape CONTEXT_LIMIT forever by restarting.
//
// The same reload hazard exists for the host boundary: the boundary key is a
// pure function of the transcript, so a boundary the previous process already
// absorbed must not be replayed as a fresh handoff.

import { describe, expect, test } from "bun:test";

import {
	createFlowState,
	createState,
	createUsageLedger,
	deserializeState,
	serializeState,
} from "../src/scope/index.mjs";
import { restoreState } from "../src/station/restore.mjs";
import { SessionStation } from "../src/station/station.mjs";
import { createTestStation } from "./helpers/station-ports.mjs";
import { entryUsage } from "../host-omp/src/host/usage.mjs";
import { probeOf } from "./helpers/probe-view.mjs";

const HANDOFF = {
	role: "custom",
	customType: "herd-relay-handoff",
	timestamp: 1000,
	content: "<handoff-context>summary</handoff-context>",
};

const OTHER_HANDOFF = {
	role: "custom",
	customType: "herd-relay-handoff",
	timestamp: 2000,
	content: "<handoff-context>later summary</handoff-context>",
};

// -- usage ledger ------------------------------------------------------------

/** The ledger the station builds, with the window taken from a mutable cell. */
function ledgerOver(state, cell) {
	return createUsageLedger({
		state,
		contextMessages: () => [],
		persist() {},
		noteError() {},
		usage: { entryUsage: (entry) => entry?.message?.usage ?? null },
		modelKeyOf: () => "model",
		actualModelOf: () => null,
		window: () => cell.value,
	});
}

/** One measured assistant response as the host reports it. */
function measured(ledger, input, output = 100) {
	ledger.onMessage(
		{
			role: "assistant",
			model: "model",
			usage: { input, output, cacheRead: 0, cacheWrite: 0 },
		},
		null,
	);
}

/** A branch tail carrying one measured response, as a reload would find it. */
function branchWith(input, output = 100) {
	return [
		{
			type: "message",
			message: {
				role: "assistant",
				model: "model",
				usage: { input, output, cacheRead: 0, cacheWrite: 0 },
			},
		},
	];
}

function managerWithBranch(branch) {
	return { getBranch: () => branch };
}

describe("the birth baseline survives serialization", () => {
	test("a round trip keeps the birth and the host boundary", () => {
		const state = createState();
		state.contextBaselineTokens = 3000;
		state.hostBoundaryKey = "herd-relay-handoff:1000:42";
		const restored = deserializeState(serializeState(state));
		expect(restored.contextBaselineTokens).toBe(3000);
		expect(restored.hostBoundaryKey).toBe("herd-relay-handoff:1000:42");
	});

	test("a snapshot without the field migrates the birth the directory already kept", () => {
		const state = createState();
		state.brackets.root.dirContextTokens = 39000;
		const snapshot = serializeState(state);
		delete snapshot.contextBaselineTokens;
		delete snapshot.hostBoundaryKey;
		const restored = deserializeState(snapshot);
		expect(restored.contextBaselineTokens).toBe(39000);
		expect(restored.hostBoundaryKey).toBeNull();
	});

	test("an explicit null is a real reset and migration does not resurrect it", () => {
		const state = createState();
		// A rewind clears both, but the fixture keeps the directory value on
		// purpose: the persisted `null` must win, not the older display copy.
		state.contextBaselineTokens = null;
		state.brackets.root.dirContextTokens = 1000;
		const restored = deserializeState(serializeState(state));
		expect(restored.contextBaselineTokens).toBeNull();
	});

	test("a child flow starts with its own birth and boundary", () => {
		const base = createState();
		base.contextBaselineTokens = 5000;
		base.hostBoundaryKey = "herd-relay-handoff:1000:42";
		const flow = createFlowState(base);
		expect(flow.contextBaselineTokens).toBeNull();
		expect(flow.hostBoundaryKey).toBeNull();
		flow.contextBaselineTokens = 7000;
		flow.hostBoundaryKey = "handoff:2000:5";
		expect(base.contextBaselineTokens).toBe(5000);
		expect(base.hostBoundaryKey).toBe("herd-relay-handoff:1000:42");
	});
});

describe("a reload restores the measured birth", () => {
	test("restart past the midpoint arms before the next response", () => {
		const cell = { value: 10000 };
		const state = createState();
		const first = ledgerOver(state, cell);
		measured(first, 1000);
		expect(state.contextBaselineTokens).toBe(1000);
		measured(first, 5800);
		expect(first.contextNudge).toBe(true);

		const restored = deserializeState(serializeState(state));
		const second = ledgerOver(restored, cell);
		second.restoreFromBranch(managerWithBranch(branchWith(5800)));
		expect(second.baselineTokens).toBe(1000);
		expect(second.contextNudge).toBe(true);
	});

	test("restart below the midpoint keeps the birth instead of ratcheting it", () => {
		const cell = { value: 10000 };
		const state = createState();
		const first = ledgerOver(state, cell);
		measured(first, 1000);
		measured(first, 4000);
		expect(first.contextNudge).toBe(false);

		const restored = deserializeState(serializeState(state));
		const second = ledgerOver(restored, cell);
		second.restoreFromBranch(managerWithBranch(branchWith(4000)));
		expect(second.baselineTokens).toBe(1000);
		expect(second.contextNudge).toBe(false);
		// The first response after the reload must not become the new birth.
		measured(second, 4500);
		expect(second.baselineTokens).toBe(1000);
		expect(second.contextNudge).toBe(false);
		// 5500 + 100 output crosses the original midpoint at 5500.
		measured(second, 5500);
		expect(second.baselineTokens).toBe(1000);
		expect(second.contextNudge).toBe(true);
	});

	test("a window that resolves late still arms with the restored birth", () => {
		const cell = { value: null };
		const state = createState();
		state.contextBaselineTokens = 1000;
		const ledger = ledgerOver(deserializeState(serializeState(state)), cell);
		ledger.restoreFromBranch(managerWithBranch(branchWith(5800)));
		expect(ledger.contextNudge).toBe(false);
		// The station observes the live model before it builds the probe.
		cell.value = 10000;
		ledger.refreshContextNudge();
		expect(ledger.baselineTokens).toBe(1000);
		expect(ledger.contextNudge).toBe(true);
	});

	test("a reset clears both copies, and a reload stays unarmed until a new birth", () => {
		const cell = { value: 10000 };
		const state = createState();
		const first = ledgerOver(state, cell);
		measured(first, 1000);
		expect(state.contextBaselineTokens).toBe(1000);
		first.resetWatermark();
		expect(first.baselineTokens).toBeNull();
		expect(state.contextBaselineTokens).toBeNull();

		const restored = deserializeState(serializeState(state));
		const second = ledgerOver(restored, cell);
		second.restoreFromBranch(managerWithBranch(branchWith(5800)));
		expect(second.baselineTokens).toBeNull();
		expect(second.contextNudge).toBe(false);
		measured(second, 5800);
		expect(second.baselineTokens).toBe(5800);
	});
});

// -- station restart ---------------------------------------------------------

/** A host session tree with one leaf, written like the production anchor does. */
function journal() {
	let leafId = "base";
	const byId = new Map([["base", { id: "base", parentId: null }]]);
	const written = [];
	const manager = {
		getLeafId: () => leafId,
		getLeafEntry: () => byId.get(leafId),
		getBranch: () => {
			const out = [];
			let cursor = leafId;
			while (cursor) {
				const entry = byId.get(cursor);
				if (!entry) break;
				out.push(entry);
				cursor = entry.parentId;
			}
			return out.reverse();
		},
        appendMessage: (message) => {
			const id = `m${byId.size}`;
			byId.set(id, {
				id,
				parentId: leafId,
				type: "message",
				message,
			});
			leafId = id;
			return id;
		},
		appendCustomEntry: (type, data) => {
			const id = `e${written.length + 1}`;
			byId.set(id, {
				id,
				parentId: leafId,
				type: "custom",
				customType: type,
				data,
			});
			leafId = id;
			written.push({ type, data });
			return id;
		},
	};
	return { manager, written };
}

const WINDOW = 1_000_000;

	/** The live model the test host reports from `before_agent_start` on. */
	const LIVE_MODEL = { provider: "test", id: "model", contextWindow: WINDOW };

	/** The catalog entry for that model, keyed the way the host keys specs. */
	function catalog() {
		const entry = { contextWindow: WINDOW };
		return {
			byFullId: new Map([["test/model", entry]]),
			byId: new Map([["test/model", entry]]),
		};
	}

	/**
	 * A root station whose ledger and ownership are pinned by the test.
	 *
	 * `pricing` is the catalog the composition root hands a station. With it the
	 * constructor resolves the window from the persisted model key, exactly as a
	 * restart that knows the model does. Without it the window stays unknown until
	 * `observeActualModel` reports the live model, which is the other real reload.
	 */
	function rootStation(manager, { pricing = null } = {}) {
		// The host bag carries the accounting port the composition root supplies:
		// a reload reads branch usage through it, so a fixture without it would
		// silently restore nothing and prove nothing about the resume path.
		const wiring = {
			host: () => ({
				model: { of: () => LIVE_MODEL },
				accounting: { usage: { entryUsage } },
			}),
		};
		const station = createTestStation(
			SessionStation,
			manager,
			{},
			{},
			wiring,
			pricing,
		);
		station.forkLedgerPort = () => station.state.brackets;
		station.forkOwnerId = () => null;
		return station;
	}

function usage(station, input, output = 1000) {
	station.onUsageMessage(
		{
			role: "assistant",
			model: "model",
			usage: { input, output, cacheRead: 0, cacheWrite: 0 },
		},
		{},
	);
}

function probe(station) {
	return probeOf(station.skillReceipt({ agent: { kind: "main" } }).content[0].text);
}

describe("a station restart keeps the birth it was born with", () => {
	test("turn one persists the birth to the journal, and the reload arms", () => {
		const { manager } = journal();
		const first = rootStation(manager);
		// Production observes the live model before it assembles a request.
		first.observeActualModel({});
		usage(first, 40_000);
		manager.appendMessage({
			role: "assistant",
			model: "model",
			usage: { input: 40_000, output: 1000, cacheRead: 0, cacheWrite: 0 },
		});
		// 40k birth, 1M window: the midpoint is 520k.
		const persisted = restoreState(manager);
		expect(persisted.contextBaselineTokens).toBe(40_000);
		expect(persisted.brackets.root.dirContextTokens).toBe(40_000);
		usage(first, 530_000);
		manager.appendMessage({
			role: "assistant",
			model: "model",
			usage: { input: 530_000, output: 1000, cacheRead: 0, cacheWrite: 0 },
		});

		// A reload under the catalog the process already had: the constructor
		// resolves the window from the persisted model key, so the restored
		// occupancy decides before any new request arrives.
		const catalogued = rootStation(manager, { pricing: catalog() });
		expect(catalogued.usage.baselineTokens).toBe(40_000);
		expect(catalogued.contextNudgeArmed()).toBe(true);
		const view = probe(catalogued);
		expect(view.mode).toBe("CONTEXT_LIMIT");
		expect(view.api).toEqual(["scope_return"]);

		// The same reload under a catalog that misses the model: the window is
		// known only when the host reports the live model, and the verdict still
		// follows before the probe is built.
		const uncatalogued = rootStation(manager);
		expect(uncatalogued.contextNudgeArmed()).toBe(false);
		uncatalogued.observeActualModel({});
		expect(uncatalogued.usage.baselineTokens).toBe(40_000);
		expect(uncatalogued.contextNudgeArmed()).toBe(true);
	});

	test("an absorbed handoff is not replayed as a new boundary after a restart", () => {
		const { manager } = journal();
		const messages = [{ role: "user", content: "before" }, HANDOFF];
		const first = rootStation(manager);
		expect(first.noteHostBoundary(messages)).toBe(true);
		expect(typeof first.state.hostBoundaryKey).toBe("string");
		usage(first, 25_000);
		const epochBefore = restoreState(manager).epoch;

		const second = rootStation(manager);
		expect(second.noteHostBoundary(messages)).toBe(false);
		expect(second.state.epoch).toBe(epochBefore);
		expect(second.usage.baselineTokens).toBe(25_000);
		expect(second.state.brackets.root.dirContextTokens).toBe(25_000);
	});

	test("a fresh session still resets on its first handoff", () => {
		const { manager } = journal();
		const station = rootStation(manager);
		expect(station.noteHostBoundary([{ role: "user", content: "hello" }])).toBe(false);
		usage(station, 50_000);
		expect(station.usage.baselineTokens).toBe(50_000);
		expect(station.noteHostBoundary([{ role: "user", content: "hello" }, HANDOFF])).toBe(true);
		expect(station.usage.baselineTokens).toBeNull();
		expect(typeof station.state.hostBoundaryKey).toBe("string");
	});

	test("an upgraded snapshot adopts its old boundary silently, then reports a new one", () => {
		const { manager } = journal();
		const seeded = rootStation(manager);
		usage(seeded, 39_000, 100);
		// Rewrite the newest state entry as a pre-fix snapshot: no boundary key and
		// no own birth field, only the directory copy.
		const snapshot = serializeState(restoreState(manager));
		delete snapshot.hostBoundaryKey;
		delete snapshot.contextBaselineTokens;
		manager.appendCustomEntry("scope.state", {
			version: 2,
			kind: "checkpoint",
			state: snapshot,
		});

		const messages = [{ role: "user", content: "before" }, HANDOFF];
		const upgraded = rootStation(manager);
		expect(upgraded.usage.baselineTokens).toBe(39_000);
		expect(upgraded.noteHostBoundary(messages)).toBe(false);
		expect(upgraded.usage.baselineTokens).toBe(39_000);
		expect(typeof upgraded.state.hostBoundaryKey).toBe("string");
		expect(upgraded.noteHostBoundary([...messages, OTHER_HANDOFF])).toBe(true);
		expect(upgraded.usage.baselineTokens).toBeNull();
	});

	test("a compact clears the known boundary so a later handoff still lands", () => {
		const { manager } = journal();
		const station = rootStation(manager);
		expect(station.noteHostBoundary([HANDOFF])).toBe(true);
		expect(station.markHostBoundaryCurrent([])).toBeNull();
		expect(station.state.hostBoundaryKey).toBeNull();
		usage(station, 5000);
		expect(station.noteHostBoundary([OTHER_HANDOFF])).toBe(true);
		expect(station.usage.baselineTokens).toBeNull();
	});
});
