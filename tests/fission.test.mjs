import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { appendAt, copyHandoff, handoffMessages, incompleteHandoffs, levelPattern, mapId } from "../src/transcript/fission.mjs";

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
});
