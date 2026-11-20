import { describe, expect, test } from "bun:test";
import { incompleteHandoffs, planHandoffRecovery, recoverIncompleteHandoffs } from "../src/transcript/fission.mjs";

// A journal that follows the host's real discard semantics
// (oh-my-pi packages/coding-agent/src/session/session-manager.ts):
// an entry is removed only when every child is a `service_tier_change`
// metadata entry, and either way a branch_summary marker lands on the entry's
// parent. Appends move the leaf; getBranch walks parents from the leaf.
function journal() {
	const entries = [];
	let leaf = null;
	let next = 0;
	const nextId = () => (++next).toString(16).padStart(8, "0");
	const append = (entry) => {
		entries.push(entry);
		leaf = entry.id;
		return leaf;
	};
	return {
		getSessionFile: () => "/session.jsonl",
		getEntries: () => entries.map((entry) => ({ ...entry })),
		getBranch: () => {
			const branch = [];
			for (let cursor = leaf; cursor !== null;) {
				const entry = entries.find((candidate) => candidate.id === cursor);
				if (!entry) throw new Error(`missing branch entry ${cursor}`);
				branch.unshift(entry);
				cursor = entry.parentId ?? null;
			}
			return branch;
		},
		branch: (target) => {
			if (!entries.some((entry) => entry.id === target)) throw new Error(`missing entry ${target}`);
			leaf = target;
		},
		resetLeaf: () => { leaf = null; },
		appendCustomEntry: (customType, data) => append({ type: "custom", id: nextId(), parentId: leaf, customType, data }),
		appendMessage: (message) => append({ type: "message", id: nextId(), parentId: leaf, message }),
		pushRaw: (entry) => { entries.push(entry); },
		async rewriteEntries() {},
		async discardEntryDurably(target) {
			const entry = entries.find((candidate) => candidate.id === target);
			if (!entry) return;
			const children = entries.filter((candidate) => candidate.parentId === target);
			let leafId = entry.parentId ?? null;
			if (children.every((child) => child.type === "service_tier_change")) {
				for (const child of children) {
					child.parentId = leafId;
					leafId = child.id;
				}
				entries.splice(entries.findIndex((candidate) => candidate.id === target), 1);
			}
			append({
				type: "branch_summary",
				id: nextId(),
				parentId: leafId,
				fromId: leafId ?? "root",
				summary: "",
				details: { kind: "DISCARDED_ENTRY_BRANCH_MARKER", discardedEntryId: target },
			});
		},
	};
}

function halfCopy(sm, handoffId, tail) {
	sm.branch(tail);
	const ids = [sm.appendCustomEntry("fission.handoff.begin", { handoffId, sourceBeginId: "a1" })];
	ids.push(sm.appendMessage({ role: "user", content: "half" }));
	ids.push(sm.appendMessage({ role: "user", content: "rest" }));
	return ids;
}

describe("fission handoff retirement", () => {
	test("retires a chained residue in one append and leaves the active branch clean", async () => {
		const sm = journal();
		const target = sm.appendMessage({ role: "user", content: "target" });
		const residue = halfCopy(sm, 11, target);
		const result = await recoverIncompleteHandoffs(sm, { durableAtomicWrites: true, retire: true });
		expect(result.dropped).toEqual([]);
		expect(result.retired).toHaveLength(1);
		expect(result.retired[0]).toMatchObject({ handoffId: 11, tail: target, entries: 3 });
		expect(result.recovered).toEqual([{ handoffId: 11, sourceBeginId: "a1", tail: target, retryable: true }]);
		expect(incompleteHandoffs(sm.getEntries())).toEqual([]);
		// The abort is the durable reload leaf: its parent is the target tail.
		expect(sm.getBranch().map((entry) => entry.id)).toEqual([target, result.retired[0].abortId]);
		// Nothing was removed; the half copy is merely off the active branch.
		const ids = sm.getEntries().map((entry) => entry.id);
		for (const id of residue) expect(ids).toContain(id);
	});

	test("keeps the default refusal while retirement is not requested", async () => {
		const sm = journal();
		const target = sm.appendMessage({ role: "user", content: "target" });
		halfCopy(sm, 12, target);
		const before = sm.getEntries();
		await expect(recoverIncompleteHandoffs(sm, { durableAtomicWrites: true })).rejects.toThrow("discardAll");
		expect(sm.getEntries()).toEqual(before);
	});

	test("does not retire twice", async () => {
		const sm = journal();
		const target = sm.appendMessage({ role: "user", content: "target" });
		halfCopy(sm, 13, target);
		await recoverIncompleteHandoffs(sm, { durableAtomicWrites: true, retire: true });
		const count = sm.getEntries().length;
		const again = await recoverIncompleteHandoffs(sm, { durableAtomicWrites: true, retire: true });
		expect(again.recovered).toEqual([]);
		expect(again.retired).toEqual([]);
		expect(sm.getEntries()).toHaveLength(count);
	});

	test("a dangling kept reference blocks deletion but not retirement", async () => {
		const sm = journal();
		const target = sm.appendMessage({ role: "user", content: "target" });
		const [, half] = halfCopy(sm, 14, target);
		// A label keeps pointing into the half copy; deleting it would dangle.
		sm.pushRaw({ type: "label", id: "aaaaaaaa", parentId: target, targetId: half, label: "x" });
		const plan = planHandoffRecovery(sm.getEntries());
		expect(plan.recoverable).toBe(false);
		expect(plan.retirable).toBe(true);
		const result = await recoverIncompleteHandoffs(sm, { durableAtomicWrites: true, retire: true });
		expect(result.retired).toHaveLength(1);
		expect(incompleteHandoffs(sm.getEntries())).toEqual([]);
		expect(sm.getBranch().map((entry) => entry.id)).toEqual([target, result.retired[0].abortId]);
	});

	test("a lone begin marker is still removed by the host in retire mode", async () => {
		const sm = journal();
		const target = sm.appendMessage({ role: "user", content: "target" });
		const begin = sm.appendCustomEntry("fission.handoff.begin", { handoffId: 15, sourceBeginId: "a1" });
		const result = await recoverIncompleteHandoffs(sm, { durableAtomicWrites: true, retire: true });
		expect(result.dropped).toEqual([begin]);
		expect(result.retired).toEqual([]);
		expect(sm.getEntries().some((entry) => entry.id === begin)).toBe(false);
		expect(incompleteHandoffs(sm.getEntries())).toEqual([]);
		expect(sm.getEntries().find((entry) => entry.id === target)).toBeDefined();
	});

	test("refuses a residue whose tail is itself inside another residue", async () => {
		const sm = journal();
		const target = sm.appendMessage({ role: "user", content: "target" });
		const outerBegin = sm.appendCustomEntry("fission.handoff.begin", { handoffId: 21, sourceBeginId: "a1" });
		const outerHalf = sm.appendMessage({ role: "user", content: "half" });
		const innerBegin = sm.appendCustomEntry("fission.handoff.begin", { handoffId: 22, sourceBeginId: "b1" });
		sm.appendMessage({ role: "user", content: "inner" });
		const plan = planHandoffRecovery(sm.getEntries());
		expect(plan.handoffs.map((handoff) => handoff.handoffId).sort()).toEqual([21, 22]);
		expect(plan.retirable).toBe(false);
		const before = sm.getEntries();
		await expect(recoverIncompleteHandoffs(sm, { durableAtomicWrites: true, retire: true })).rejects.toThrow("uncommitted residue");
		expect(sm.getEntries()).toEqual(before);
		expect([outerBegin, outerHalf, innerBegin].every((id) => sm.getEntries().some((entry) => entry.id === id))).toBe(true);
	});

	test("one abort closes sibling begins left by a retried copy", async () => {
		const sm = journal();
		const target = sm.appendMessage({ role: "user", content: "target" });
		const first = halfCopy(sm, 23, target);
		const second = halfCopy(sm, 23, target);
		const plan = planHandoffRecovery(sm.getEntries());
		expect(plan.handoffs).toHaveLength(1);
		expect(plan.handoffs[0].beginIds).toEqual([first[0], second[0]]);
		expect(plan.handoffs[0].discardable).toBe(false);
		expect(plan.retirable).toBe(true);
		const result = await recoverIncompleteHandoffs(sm, { durableAtomicWrites: true, retire: true });
		expect(result.retired[0].entries).toBe(6);
		expect(incompleteHandoffs(sm.getEntries())).toEqual([]);
		expect(planHandoffRecovery(sm.getEntries()).handoffs).toEqual([]);
		expect(sm.getBranch().map((entry) => entry.id)).toEqual([target, result.retired[0].abortId]);
	});

	test("reports the abort marker as an inert custom entry", async () => {
		const sm = journal();
		const target = sm.appendMessage({ role: "user", content: "target" });
		halfCopy(sm, 24, target);
		const result = await recoverIncompleteHandoffs(sm, { durableAtomicWrites: true, retire: true });
		const abort = sm.getEntries().find((entry) => entry.id === result.retired[0].abortId);
		expect(abort.type).toBe("custom");
		expect(abort.customType).toBe("fission.handoff.abort");
		expect(abort.data).toMatchObject({ handoffId: 24, retired: 3 });
	});
});
