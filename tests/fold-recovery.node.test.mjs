import assert from "node:assert/strict";
import { test } from "node:test";

import { foldBatch } from "../src/station/fold.mjs";

function call(id) {
	return { role: "assistant", content: [{ type: "toolCall", id, name: "scope", arguments: {} }] };
}

function result(id) {
	return { role: "toolResult", toolCallId: id, content: [{ type: "text", text: "ok" }] };
}

function fixture() {
	const base = [
		{ role: "user", content: "Keep the completed work." },
		call("begin"),
		result("begin"),
		{ role: "assistant", content: [{ type: "text", text: "work ".repeat(100) }] },
		call("end"),
		result("end"),
	];
	const entries = [];
	let leaf = null;
	let originalLeaf;
	let failWrite = false;
	let rollback = "normal";
	let writes = 0;
	const manager = {
		getLeafId: () => leaf,
		getBranch() {
			const branch = [];
			let entry = entries.find((item) => item.id === leaf);
			while (entry) {
				branch.unshift(entry);
				entry = entries.find((item) => item.id === entry.parentId);
			}
			return branch;
		},
		appendMessage(message) {
			if (failWrite && ++writes === 2) throw new Error("The second write failed.");
			const entry = { type: "message", id: `e${entries.length}`, parentId: leaf, message };
			entries.push(entry);
			leaf = entry.id;
			return leaf;
		},
		branch(id) {
			if (failWrite && id === originalLeaf && leaf !== originalLeaf) {
				if (rollback === "throw") throw new Error("Restoring the branch failed.");
				if (rollback === "ignore") return;
			}
			leaf = id;
		},
		resetLeaf() { leaf = null; },
	};
	for (const message of base) manager.appendMessage(message);
	originalLeaf = leaf;
	const record = {
		scopeId: "scope-1",
		beginToolCallId: "begin",
		endToolCallId: "end",
		collapsed: false,
		report: "The work is complete.",
		epoch: 0,
		order: 1,
	};
	const state = {
		collapses: [record],
		modelCaches: { "test/model": { cachedUntilPos: base.length } },
		epoch: 0,
	};
	return {
		manager, base, record, state, originalLeaf, entries,
		fail(mode = "normal") { failWrite = true; writes = 0; rollback = mode; },
		recover() { failWrite = false; },
		fold(batch = [record]) {
			return foldBatch({ manager, state, batch, base, currentPersisted: true, epoch: 0 });
		},
	};
}

test("a partial fold restores the complete branch and all unfinished record flags", () => {
	const f = fixture();
	const missing = { ...f.record, beginToolCallId: "missing-begin", endToolCallId: "missing-end" };
	const before = f.manager.getBranch();
	f.fail();
	const result = f.fold([missing, f.record]);
	assert.equal(result.rebased, false);
	assert.equal(result.foldedCount, 0);
	assert.equal(f.manager.getLeafId(), f.originalLeaf);
	assert.deepEqual(f.manager.getBranch(), before);
	assert.equal(f.record.collapsed, false);
	assert.equal(missing.collapsed, false);
	assert.equal(f.state.modelCaches["test/model"].cachedUntilPos, f.base.length);
	assert.ok(f.entries.length > before.length, "A partial write can remain off the active branch.");
});

test("a recovered fold can retry and commit a complete shortened branch", () => {
	const f = fixture();
	f.fail();
	f.fold();
	f.recover();
	const result = f.fold();
	assert.equal(result.rebased, true);
	assert.equal(result.foldedCount, 1);
	assert.equal(f.record.collapsed, true);
	assert.notEqual(f.manager.getLeafId(), f.originalLeaf);
	const messages = f.manager.getBranch().map((entry) => entry.message);
	assert.equal(messages[0], f.base[0]);
	assert.deepEqual(messages.at(-1), f.base.at(-1));
	assert.ok(messages.length < f.base.length);
});

test("a minimal tree manager restores from its branch tail without getLeafId", () => {
	const f = fixture();
	delete f.manager.getLeafId;
	const before = f.manager.getBranch();
	f.fail();
	assert.equal(f.fold().rebased, false);
	assert.deepEqual(f.manager.getBranch(), before);
});

for (const mode of ["throw", "ignore"]) {
	test(`a rollback that ${mode === "throw" ? "throws" : "silently does nothing"} reports a terminal fold error`, () => {
		const f = fixture();
		f.fail(mode);
		assert.throws(() => f.fold(), (error) => {
			assert.equal(error.code, "FOLD_ROLLBACK_FAILED");
			assert.ok(error instanceof AggregateError);
			assert.equal(error.errors.length, 2);
			return true;
		});
		assert.equal(f.record.collapsed, false);
		assert.notEqual(f.manager.getLeafId(), f.originalLeaf);
	});
}
