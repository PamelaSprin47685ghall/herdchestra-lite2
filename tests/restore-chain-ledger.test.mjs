// Restore must replay every ledger increment on the branch, including the ones
// embedded in state entries that are older than the newest checkpoint.
//
// The state chain stops at its newest checkpoint. The ledger does not: each
// write stores only the records that moved, so an increment in an older entry
// is the only copy of that change. Reading only as far back as the state chain
// reaches silently deletes fork history — and every test that wrote its whole
// fork table on each write would never notice.

import { describe, expect, test } from "bun:test";

import { restoreState } from "../src/station/restore.mjs";
import {
	createBracketLedger,
	createState,
	deserializeState,
	foldStateChain,
	isLedgerEntry,
	markLedgerStructDirty,
	markRecordDirty,
	planLedgerEntry,
	planStateEntry,
	registerFork,
	serializeStateShared,
	serializeState,
	splitState,
} from "../src/scope/index.mjs";

// A host session tree with one leaf, written through the production planners.
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

// The anchor's write path, reduced to what the journal shape depends on.
function writer(manager) {
	let lastCore = null;
	let lastBrackets = null;
	let writes = 0;
	return (state) => {
		const ledgerPlan = planLedgerEntry(state, lastBrackets);
		const { core } = splitState(serializeStateShared(state));
		const entry = planStateEntry(lastCore, core, writes);
		if (!entry && !ledgerPlan.entry) return null;
		let payload;
		if (entry && ledgerPlan.entry) {
			// Same envelope as the production anchor: forward the whole increment.
			const { version: _v, kind: _k, ...rest } = ledgerPlan.entry;
			payload = { ...entry, ledger: rest };
		} else {
			payload = entry ?? ledgerPlan.entry;
		}
		manager.appendCustomEntry("scope.state", payload);
		if (entry) {
			lastCore = core;
			writes = entry.kind === "checkpoint" ? 0 : writes + 1;
		}
		if (ledgerPlan.entry) lastBrackets = ledgerPlan.brackets;
		return payload;
	};
}

function addFork(state, forkId, task) {
	const registered = registerFork(state.brackets, {
		forkId,
		ownerId: "root",
		fsm: "one state",
		depth: 0,
		budget: { read: 1 },
		profession: "You are a tester.",
	});
	expect(registered.ok).toBe(true);
	state.brackets.forks[forkId].task = task;
	markRecordDirty(state.brackets, forkId);
}

describe("restore replays the whole ledger journal", () => {
	test("a complete newer baseline stops inspection of older entries", () => {
		const state = createState();
		addFork(state, "current", "present");
		const baseline = {
			type: "custom", customType: "scope.state",
			data: { version: 2, kind: "checkpoint", state: serializeState(state) },
		};
		const branch = new Proxy([{}, {}, baseline], {
			get(target, key, receiver) {
				if (key === "0" || key === "1") throw new Error("older history inspected");
				return Reflect.get(target, key, receiver);
			},
		});
		const restored = restoreState({ getBranch: () => branch });
		expect(Object.keys(restored.brackets.forks)).toEqual(["current"]);
	});

	test("a later legacy checkpoint replaces older incremental state", () => {
		const { manager } = journal();
		const earlier = createState();
		addFork(earlier, "old", "stale");
		earlier.amends = ["old-beat"];
		const ledger = planLedgerEntry(earlier, null).entry;
		manager.appendCustomEntry("scope.state", ledger);
		manager.appendCustomEntry("scope.state", {
			version: 3, kind: "amends", amends: ["old-beat"],
		});
		const later = createState();
		addFork(later, "new", "current");
		later.amends = ["new-beat"];
		manager.appendCustomEntry("scope.state", {
			version: 2, kind: "checkpoint", state: serializeState(later),
		});
		const restored = restoreState(manager);
		expect(Object.keys(restored.brackets.forks)).toEqual(["new"]);
		expect(restored.amends).toBeUndefined();
	});

	test("a later unenveloped legacy snapshot supersedes earlier increments", () => {
		const { manager } = journal();
		const earlier = createState();
		addFork(earlier, "old", "stale");
		manager.appendCustomEntry("scope.state", planLedgerEntry(earlier, null).entry);
		manager.appendCustomEntry("scope.state", {
			version: 3, kind: "amends", amends: ["old-beat"],
		});
		const later = createState();
		addFork(later, "new", "current");
		later.amends = ["new-beat"];
		manager.appendCustomEntry("scope.state", serializeState(later));
		const restored = restoreState(manager);
		expect(Object.keys(restored.brackets.forks)).toEqual(["new"]);
		expect(restored.amends).toBeUndefined();
	});

	test("a string-encoded legacy snapshot also supersedes older increments", () => {
		const { manager } = journal();
		const earlier = createState();
		addFork(earlier, "old", "stale");
		manager.appendCustomEntry("scope.state", planLedgerEntry(earlier, null).entry);
		manager.appendCustomEntry("scope.state", { version: 3, kind: "amends", amends: ["old-beat"] });
		const later = createState();
		addFork(later, "new", "current");
		later.amends = ["new-beat"];
		manager.appendCustomEntry("scope.state", JSON.stringify(serializeState(later)));
		const restored = restoreState(manager);
		expect(Object.keys(restored.brackets.forks)).toEqual(["new"]);
		expect(restored.amends).toBeUndefined();
	});

	test("a v1 snapshot without optional domains cuts off older increments", () => {
		const { manager } = journal();
		const earlier = createState();
		addFork(earlier, "old", "stale");
		manager.appendCustomEntry("scope.state", planLedgerEntry(earlier, null).entry);
		manager.appendCustomEntry("scope.state", { version: 3, kind: "amends", amends: ["old-beat"] });
		manager.appendCustomEntry("scope.state", { version: 1, seq: 23, charges: {} });
		const restored = restoreState(manager);
		expect(restored.seq).toBe(23);
		expect(Object.keys(restored.brackets.forks)).toEqual([]);
		expect(restored.amends).toBeUndefined();
	});

	test("a v3 suffix after a legacy checkpoint applies to that checkpoint", () => {
		const { manager } = journal();
		const earlier = createState();
		addFork(earlier, "old", "stale");
		manager.appendCustomEntry("scope.state", planLedgerEntry(earlier, null).entry);
		const later = createState();
		addFork(later, "new", "base");
		later.amends = ["base-beat"];
		manager.appendCustomEntry("scope.state", {
			version: 2, kind: "checkpoint", state: serializeState(later),
		});
		const first = planLedgerEntry(later, null);
		later.brackets.forks.new.task = "updated";
		markRecordDirty(later.brackets, "new");
		const suffix = planLedgerEntry(later, first.brackets);
		manager.appendCustomEntry("scope.state", suffix.entry);
		manager.appendCustomEntry("scope.state", {
			version: 3, kind: "amends", amendsAppend: ["later-beat"],
		});
		const restored = restoreState(manager);
		expect(Object.keys(restored.brackets.forks)).toEqual(["new"]);
		expect(restored.brackets.forks.new.task).toBe("updated");
		expect(restored.amends).toBeUndefined();
	});

	test("an increment older than the newest checkpoint still restores", () => {
		const { manager, written } = journal();
		const write = writer(manager);
		const state = createState();
		state.brackets = createBracketLedger();

		// First write: a full ledger baseline embedded in the state entry.
		addFork(state, "a", "first");
		state.seq = 1;
		write(state);

		// A later, unrelated write moves one more fork. Its increment is the
		// only place record `b` is ever stored.
		state.seq = 2;
		write(state);
		addFork(state, "b", "second");
		state.seq = 3;
		write(state);

		// Enough quiet writes to force a checkpoint past the fork changes.
		for (let seq = 4; seq <= 75; seq += 1) {
			state.seq = seq;
			write(state);
		}

		// Precondition: the journal really does hide `b` behind a checkpoint.
		const kinds = written.map((item) => item.data.kind ?? "ledger");
		expect(kinds).toContain("checkpoint");
		const lastCheckpoint = written
			.map((item, index) => ({ item, index }))
			.filter(({ item }) => item.data.kind === "checkpoint")
			.at(-1);
		expect(lastCheckpoint).toBeDefined();
		const embeddedAfterCheckpoint = written
			.slice(lastCheckpoint.index)
			.some((item) => item.data.ledger);
		expect(embeddedAfterCheckpoint).toBe(false);

		const restored = restoreState(manager);
		expect(restored.seq).toBe(75);
		expect(Object.keys(restored.brackets.forks).sort()).toEqual(["a", "b"]);
		expect(restored.brackets.forks.b.task).toBe("second");
		expect(restored.brackets.order.sort()).toEqual(["a", "b"]);
	});

	test("a later full baseline clears records an older journal still names", () => {
		const { manager } = journal();
		const write = writer(manager);
		const state = createState();
		state.brackets = createBracketLedger();
		addFork(state, "old", "dropped");
		state.seq = 1;
		write(state);

		// A fresh baseline that no longer knows about `old`, written the way a
		// rebase does: no previous snapshot to subtract from.
		const fresh = createState();
		fresh.brackets = createBracketLedger();
		addFork(fresh, "kept", "live");
		fresh.seq = 2;
		const fullWrite = writer(manager);
		fullWrite(fresh);

		const restored = restoreState(manager);
		expect(Object.keys(restored.brackets.forks)).toEqual(["kept"]);
		expect(restored.brackets.order).toEqual(["kept"]);
	});

	test("a standalone ledger entry keeps its place among embedded ones", () => {
		const { manager, written } = journal();
		const write = writer(manager);
		const state = createState();
		state.brackets = createBracketLedger();
		addFork(state, "a", "a");
		state.seq = 1;
		write(state);

		// A ledger-only write: the state is unchanged, so the entry stands alone.
		addFork(state, "b", "b");
		const lone = write(state);
		expect(isLedgerEntry(lone)).toBe(true);
		expect(written.filter((item) => isLedgerEntry(item.data)).length).toBe(1);

		state.seq = 2;
		write(state);

		expect(written.some((item) => isLedgerEntry(item.data))).toBe(true);
		const restored = restoreState(manager);
		expect(Object.keys(restored.brackets.forks).sort()).toEqual(["a", "b"]);
	});

	test("the fold itself agrees with restore", () => {
		// Both views must describe the same journal: a divergence here means one
		// of them dropped an increment.
		const { manager, written } = journal();
		const write = writer(manager);
		const state = createState();
		state.brackets = createBracketLedger();
		addFork(state, "a", "a");
		state.seq = 1;
		write(state);
		for (let seq = 2; seq <= 70; seq += 1) {
			state.seq = seq;
			write(state);
		}

		const folded = foldStateChain(written.map((item) => item.data));
		const directly = deserializeState(folded);
		const restored = restoreState(manager);
		expect(Object.keys(directly.brackets.forks)).toEqual(
			Object.keys(restored.brackets.forks),
		);
		expect(directly.seq).toBe(restored.seq);
	});
});
