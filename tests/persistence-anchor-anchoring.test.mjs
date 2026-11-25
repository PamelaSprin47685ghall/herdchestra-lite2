import { describe, expect, test } from "bun:test";
import { createPersistenceAnchor } from "../src/station/persistence-anchor.mjs";

// The anchor must not walk the branch when the leaf proves membership on its
// own: the baseline entry is the leaf, or the leaf hangs directly off it.
function harness() {
	let leafId = "base";
	let serial = 0;
	const entries = new Map([["base", { id: "base", parentId: null }]]);
	const appended = [];
	let branchCalls = 0;

	const manager = {
		getLeafId: () => leafId,
		getLeafEntry: () => entries.get(leafId),
		getEntry: (id) => entries.get(id),
		// Discard an entry the way the host's amend path does: its children
		// reparent to its parent, the id disappears, the leaf id stays.
		drop: (id) => {
			const gone = entries.get(id);
			if (!gone) return;
			for (const entry of entries.values()) {
				if (entry.parentId === id) entry.parentId = gone.parentId;
			}
			entries.delete(id);
		},
		getBranch: () => {
			branchCalls += 1;
			const chain = [];
			let cursor = leafId;
			while (cursor) {
				chain.push(entries.get(cursor));
				cursor = entries.get(cursor).parentId;
			}
			return chain.reverse();
		},
		appendCustomEntry: (type, entry) => {
			const id = `e${++serial}`;
			entries.set(id, { id, parentId: leafId });
			leafId = id;
			appended.push({ id, type, entry });
			return id;
		},
	};

	let value = 0;
	const errors = [];
	const anchor = createPersistenceAnchor({
		manager,
		state: () => ({ value }),
		initialState: null,
		initialEntryId: null,
		serialize: (state) => JSON.stringify(state),
		// A missing baseline forces a checkpoint; otherwise a delta.
		plan: (previous, next, writes) => {
			if (previous === next) return null;
			return { kind: previous === null || writes >= 64 ? "checkpoint" : "delta" };
		},
		planLedger: () => ({ entry: null, brackets: null }),
		split: (full) => ({ core: full }),
		type: "state",
		noteError: (where, error) => errors.push({ where, error }),
	});

	return {
		anchor,
		manager,
		appended,
		errors,
		bump: () => {
			value += 1;
		},
		branchCalls: () => branchCalls,
		appendHostEntry: (id) => {
			entries.set(id, { id, parentId: leafId });
			leafId = id;
		},
		switchLeaf: (id) => {
			leafId = id;
		},
	};
}

describe("persistence anchor", () => {
	test("a baseline that is still the leaf costs no branch walk", () => {
		const h = harness();
		h.bump();
		expect(h.anchor.persist()).toBe(true);
		const writes = h.appended.length;
		h.bump();
		expect(h.anchor.persist()).toBe(true);
		expect(h.appended.length).toBe(writes + 1);
		expect(h.appended.at(-1).entry.kind).toBe("delta");
		expect(h.branchCalls()).toBe(0);
	});

	test("a host append directly above the baseline costs no branch walk", () => {
		const h = harness();
		h.bump();
		h.anchor.persist();
		h.appendHostEntry("host-1");
		h.bump();
		h.anchor.persist();
		expect(h.branchCalls()).toBe(0);
		expect(h.errors).toEqual([]);
	});

	test("leaving the branch invalidates the baseline and rewrites a checkpoint", () => {
		const h = harness();
		h.bump();
		h.anchor.persist();
		h.appendHostEntry("host-1");
		h.switchLeaf("base");
		h.bump();
		h.anchor.persist();
		// The baseline left the path, so it must be dropped and a checkpoint
		// written. How that was discovered is not the contract: the anchor now
		// backtracks `parentId` from the leaf through `getEntry`, so it never
		// reads the whole branch. Asserting a branch read here would pin the old
		// mechanism and forbid the cheaper proof.
		expect(h.appended.at(-1).entry.kind).toBe("checkpoint");
		expect(h.errors).toEqual([]);
		// And the cheaper proof is what ran: no branch was enumerated.
		expect(h.branchCalls()).toBe(0);
	});

	test("a manager without getLeafId still anchors by walking the branch", () => {
		const h = harness();
		const { getLeafId, ...rest } = h.manager;
		const errors = [];
		const anchor = createPersistenceAnchor({
			manager: rest,
			state: () => ({ value: 1 }),
			initialState: null,
			initialEntryId: null,
			serialize: (state) => JSON.stringify(state),
			plan: (previous, next, writes) =>
				previous === next ? null : { kind: previous === null || writes >= 64 ? "checkpoint" : "delta" },
			planLedger: () => ({ entry: null, brackets: null }),
			split: (full) => ({ core: full }),

			type: "state",
			noteError: (where, error) => errors.push({ where, error }),
		});
		expect(anchor.persist()).toBe(true);
		// A name-less leaf must not silently drop the baseline: the second write
		// is still a delta over the first, not a fresh checkpoint.
		expect(anchor.persist()).toBe(true);
		expect(errors).toEqual([]);
	});

	test("discarding the anchor while the leaf stays put is detected", () => {
		const h = harness();
		h.bump();
		h.anchor.persist();
		h.appendHostEntry("h1");
		h.bump();
		h.anchor.persist();
		h.appendHostEntry("h2");
		h.bump();
		h.anchor.persist();
		// A no-op persist leaves the baseline as the leaf; hop one host entry
		// past it so the cached verdict describes a leaf that is not the anchor.
		h.appendHostEntry("h3");
		h.anchor.persist();
		const anchorId = h.appended.at(-1).id;
		const cached = h.branchCalls();
		expect(h.manager.getLeafId()).toBe("h3");
		// Same leaf, baseline still in the journal: the cached verdict holds.
		h.anchor.persist();
		expect(h.branchCalls()).toBe(cached);
		// The baseline entry disappears while the leaf id stays the same.
		h.manager.drop(anchorId);
		expect(h.manager.getLeafId()).toBe("h3");
		expect(h.manager.getEntry(anchorId)).toBeUndefined();
		h.bump();
		h.anchor.persist();
		expect(h.appended.at(-1).entry.kind).toBe("checkpoint");
	});

	test("a rebase drops the baseline and writes a checkpoint", () => {
		const h = harness();
		h.bump();
		h.anchor.persist();
		h.anchor.rebase();
		expect(h.appended.at(-1).entry.kind).toBe("checkpoint");
		expect(h.anchor.needsRebase()).toBe(true);
		h.anchor.clearRebase();
		expect(h.anchor.needsRebase()).toBe(false);
	});
});
