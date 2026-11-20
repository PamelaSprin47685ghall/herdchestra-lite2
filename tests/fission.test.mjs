import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	appendAt,
	copyHandoff,
	handoffMessages,
	incompleteHandoffs,
	levelPattern,
	mapId,
	planHandoffRecovery,
	recoverIncompleteHandoffs,
} from "../src/transcript/fission.mjs";

// Exercise the consumer against a branch-aware journal, not a call-count mock.
function journal() {
	const entries = [];
	let leaf = null;
	let next = 0;
	const append = (entry) => {
		entries.push(entry);
		leaf = entry.id;
		return leaf;
	};
	return {
		getSessionFile: () => "/session.jsonl",
		appendEntriesAtomically: async (write) => {
			const length = entries.length;
			const saved = leaf;
			try { return write(); } catch (error) { entries.length = length; leaf = saved; throw error; }
		},
		getEntries: () => entries.slice(),
		getBranch: () => {
			const branch = [];
			for (let id = leaf; id !== null;) {
				const entry = entries.find((item) => item.id === id);
				if (!entry) throw new Error("missing branch entry");
				branch.unshift(entry);
				id = entry.parentId;
			}
			return branch;
		},
		branch: (id) => {
			if (!entries.some((entry) => entry.id === id)) throw new Error("missing entry");
			leaf = id;
		},
		// The real host reparents only service_tier_change children, then always
		// writes a branch_summary marker at the discarded entry's parent.
		discardEntryDurably: async (id) => {
			const entry = entries.find((candidate) => candidate.id === id);
			if (!entry) return;
			const children = entries.filter((candidate) => candidate.parentId === id);
			let leafId = entry.parentId;
			if (children.every((child) => child.type === "service_tier_change")) {
				for (const child of children) {
					child.parentId = leafId;
					leafId = child.id;
				}
				const index = entries.findIndex((candidate) => candidate.id === id);
				entries.splice(index, 1);
			}
			append({
				type: "branch_summary",
				id: (++next).toString(16).padStart(8, "0"),
				parentId: leafId,
				fromId: leafId ?? "root",
				summary: "",
				details: { kind: "DISCARDED_ENTRY_BRANCH_MARKER", discardedEntryId: id },
			});
		},
		discardEntriesDurably: async (ids) => {
			const drop = new Set(ids);
			const kept = entries.filter((entry) => !drop.has(entry.id));
			entries.length = 0;
			entries.push(...kept);
			if (leaf !== null && drop.has(leaf)) leaf = kept.at(-1)?.id ?? null;
		},
		resetLeaf: () => { leaf = null; },
		appendCustomEntry: (customType, data) => append({ type: "custom", id: (++next).toString(16).padStart(8, "0"), parentId: leaf, customType, data }),
		appendMessage: (message) => append({ type: "message", id: (++next).toString(16).padStart(8, "0"), parentId: leaf, message }),
		ingestReplicatedEntry: append,
	};
}

describe("fission transcript consumption", () => {
	test("copies a branch into the recipient's actual next context", async () => {
		const sm = journal();
		const target = sm.appendMessage({ role: "user", content: "recipient", timestamp: 1 });
		const source = [
			{ id: "a1", type: "custom", customType: "scope.begin", data: { intent: "source" } },
			{ id: "a2", type: "message", message: { role: "user", content: "broadcast", details: { fissionBroadcast: { broadcastId: "b" } } } },
			{ id: "a3", type: "message", message: { role: "user", content: "You are still inside scope level 2: work. Remaining budget: 3.", timestamp: 2 } },
			{ id: "a4", type: "custom", customType: "scope.end", data: {} },
		];
		const template = readFileSync(new URL("../resources/prompts/receipts/scope.md", import.meta.url), "utf8");
		const result = await copyHandoff(sm, { tail: target, entries: source, handoffId: 1, sourceBeginId: "a1", shift: 1, levelRegex: levelPattern(template), vibeInactive: true, durableAtomicWrites: true });
		const branch = sm.getBranch();
		expect(branch.at(-1).id).toBe(result.tail);
		expect(branch.map((entry) => entry.type)).toEqual(["message", "custom", "custom", "message", "custom", "custom"]);
		const context = [{ role: "user", content: "recipient" }, ...handoffMessages(branch.slice(2, -1))];
		expect(context.map((message) => message.content)).toEqual([
			"recipient", '{"intent":"source"}', "You are still inside scope level 3: work. Remaining budget: 3.", "{}",
		]);
		expect(result.messages.map((message) => message.content)).toEqual(context.slice(1).map((message) => message.content));
		expect(source[2].message.content).toContain("level 2");
	});

	test("keeps the compaction summary and only the retained window", async () => {
		const sm = journal();
		const tail = sm.appendMessage({ role: "user", content: "target" });
		const entries = [
			{ id: "a1", type: "message", message: { role: "user", content: "old" } },
			{ id: "a2", type: "message", message: { role: "user", content: "kept" } },
			{ id: "a3", type: "compaction", firstKeptEntryId: "a2", summary: "earlier context" },
		];
		const result = await copyHandoff(sm, { tail, entries, handoffId: 2, sourceBeginId: "a1", vibeInactive: true, durableAtomicWrites: true });
		expect(result.messages.map((message) => message.content)).toEqual(["earlier context", "kept"]);
		expect(sm.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
	});

	test("rolls back a failed transaction without claiming recovery", async () => {
		const sm = journal();
		const tail = sm.appendMessage({ role: "user", content: "target" });
		sm.ingestReplicatedEntry = () => { throw new Error("write failed"); };
		await expect(copyHandoff(sm, { tail, entries: [{ id: "a1", type: "message", message: { role: "user", content: "x" } }], handoffId: 3, sourceBeginId: "a1", vibeInactive: true, durableAtomicWrites: true })).rejects.toThrow("write failed");
		expect(incompleteHandoffs(sm.getEntries())).toEqual([]);
		expect(sm.getBranch().at(-1).id).toBe(tail);
	});

	test("refuses writes without an explicit inactive vibe and persistent journal", async () => {
		const sm = journal();
		const tail = sm.appendMessage({ role: "user", content: "target" });
		const options = { tail, entries: [], handoffId: 1, sourceBeginId: "a1" };
		await expect(copyHandoff(sm, options)).rejects.toThrow("inactive vibe");
		await expect(copyHandoff(sm, { ...options, vibeInactive: true })).rejects.toThrow("persistent session");
		sm.getSessionFile = () => undefined;
		await expect(copyHandoff(sm, { ...options, vibeInactive: true, durableAtomicWrites: true })).rejects.toThrow("persistent session");
		expect(sm.getBranch().at(-1).id).toBe(tail);
	});

	test("restores the exact leaf and propagates even falsy thrown values", () => {
		const sm = journal();
		const saved = sm.appendCustomEntry("scope.begin", {});
		let caught = false;
		try { appendAt(sm, null, () => { throw null; }); } catch (error) { caught = true; expect(error).toBeNull(); }
		expect(caught).toBe(true);
		expect(sm.getBranch().at(-1).id).toBe(saved);
	});

	test("rejects invalid handoff numbers and salts collisions", () => {
		expect(() => mapId("a", -1, new Set())).toThrow();
		expect(mapId("a", 1, new Set(["af1"]))).toBe("af1f1");
	});

	test("does not copy the source flow's scope.state into the recipient", async () => {
		const sm = journal();
		const tail = sm.appendMessage({ role: "user", content: "target" });
		const source = [
			{ id: "a1", type: "custom", customType: "scope.state", data: { version: 2, kind: "checkpoint", state: { seq: 4, pins: ["**Finding:** source", "**Finding:** source"] } } },
			{ id: "a2", type: "message", message: { role: "user", content: "kept", timestamp: 1 } },
		];
		let adopted = null;
		const result = await copyHandoff(sm, {
			tail,
			entries: source,
			handoffId: 5,
			sourceBeginId: "a1",
			vibeInactive: true,
			durableAtomicWrites: true,
			adoptPins: (pins) => { adopted = pins; },
		});
		expect(result.entries.map((entry) => entry.type)).toEqual(["message"]);
		expect(result.pins).toEqual(["**Finding:** source"]);
		expect(adopted).toEqual(["**Finding:** source"]);
		expect(sm.getBranch().some((entry) => entry.customType === "scope.state")).toBe(false);
	});

	test("refuses a chained residue before any write under the host marker", async () => {
		const sm = journal();
		const target = sm.appendMessage({ role: "user", content: "target" });
		sm.appendCustomEntry("fission.handoff.begin", { handoffId: 6, sourceBeginId: "b1" });
		sm.appendCustomEntry("fission.handoff.end", { handoffId: 6, count: 0 });
		sm.branch(target);
		const begin = sm.appendCustomEntry("fission.handoff.begin", { handoffId: 7, sourceBeginId: "a1" });
		const half = sm.appendMessage({ role: "user", content: "half" });
		const rest = sm.appendMessage({ role: "user", content: "rest" });
		const plan = planHandoffRecovery(sm.getEntries());
		expect(plan.recoverable).toBe(true);
		expect(plan.handoffs.map((handoff) => handoff.handoffId)).toEqual([7]);
		expect(plan.handoffs[0].tail).toBe(target);
		expect(plan.handoffs[0].retryable).toBe(true);
		expect([...plan.dropIds].sort()).toEqual([begin, half, rest].sort());
		const before = sm.getEntries();
		await expect(recoverIncompleteHandoffs(sm, { durableAtomicWrites: true })).rejects.toThrow("discardAll");
		expect(sm.getEntries()).toEqual(before);
		expect(incompleteHandoffs(sm.getEntries())).toHaveLength(1);
		expect(sm.getEntries().some((entry) => entry.customType === "fission.handoff.end")).toBe(true);
	});

	test("recovers a chained residue through the bulk discard interface", async () => {
		const sm = journal();
		const target = sm.appendMessage({ role: "user", content: "target" });
		const begin = sm.appendCustomEntry("fission.handoff.begin", { handoffId: 7, sourceBeginId: "a1" });
		const half = sm.appendMessage({ role: "user", content: "half" });
		const rest = sm.appendMessage({ role: "user", content: "rest" });
		const recovered = await recoverIncompleteHandoffs(sm, {
			durableAtomicWrites: true,
			discardAll: (ids) => sm.discardEntriesDurably(ids),
		});
		expect(recovered.dropped.sort()).toEqual([begin, half, rest].sort());
		expect(recovered.recovered).toEqual([{ handoffId: 7, sourceBeginId: "a1", tail: target, retryable: true }]);
		expect(incompleteHandoffs(sm.getEntries())).toEqual([]);
		const again = await recoverIncompleteHandoffs(sm, { durableAtomicWrites: true });
		expect(again.recovered).toEqual([]);
	});

	test("auto-discards a lone begin marker and accepts the host's branch marker", async () => {
		const sm = journal();
		sm.appendMessage({ role: "user", content: "target" });
		const begin = sm.appendCustomEntry("fission.handoff.begin", { handoffId: 9, sourceBeginId: "a1" });
		const recovered = await recoverIncompleteHandoffs(sm, { durableAtomicWrites: true });
		expect(recovered.dropped).toEqual([begin]);
		expect(incompleteHandoffs(sm.getEntries())).toEqual([]);
		const marker = sm.getEntries().find((entry) => entry.type === "branch_summary");
		expect(marker.details).toEqual({ kind: "DISCARDED_ENTRY_BRANCH_MARKER", discardedEntryId: begin });
	});

	test("refuses recovery that would dangle a kept reference", () => {
		const entries = [
			{ id: "00000001", type: "message", parentId: null, message: { role: "user", content: "target" } },
			{ id: "00000002", type: "custom", customType: "fission.handoff.begin", parentId: "00000001", data: { handoffId: 3 } },
			{ id: "00000003", type: "message", parentId: "00000002", message: { role: "user", content: "half" } },
			{ id: "00000004", type: "label", parentId: "00000001", targetId: "00000003", label: "x" },
		];
		const plan = planHandoffRecovery(entries);
		expect(plan.recoverable).toBe(false);
		expect(plan.dangling).toEqual([{ id: "00000004", field: "targetId", targetId: "00000003" }]);
	});

	test("requires a persistent journal before recovery writes", async () => {
		const sm = journal();
		sm.appendCustomEntry("fission.handoff.begin", { handoffId: 9, sourceBeginId: "a1" });
		await expect(recoverIncompleteHandoffs(sm)).rejects.toThrow("persistent session");
		sm.getSessionFile = () => undefined;
		await expect(recoverIncompleteHandoffs(sm, { durableAtomicWrites: true })).rejects.toThrow("persistent session");
	});
});
