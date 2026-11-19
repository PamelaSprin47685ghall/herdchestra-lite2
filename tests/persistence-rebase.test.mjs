/**
 * A fold physically rewrites the session branch from an earlier entry, so
 * every state entry appended after that point leaves `getBranch()`. The next
 * write must therefore be a checkpoint: a delta would replay onto a chain
 * without an anchor, and a restart would silently come back empty.
 *
 * This test drives the real station through foldBatch with the same tree
 * semantics as omp, then restores a second station from the same manager.
 */

import { describe, expect, test } from "bun:test";
import { SessionStation } from "../src/station/index.mjs";
import { foldStateChain, isStateCheckpoint, serializeState } from "../src/scope/index.mjs";
import { SESSION_STATE_TYPE } from "../src/station/restore.mjs";

function makeManager() {
	const entries = [];
	let leafId = null;
	let nextId = 1;
	const id = () => `e${nextId++}`;
	const manager = {
		entries,
		getLeafId: () => leafId,
		getEntry: (entryId) => entries.find((entry) => entry.id === entryId),
		getBranch: () => {
			const path = [];
			let current = entries.find((entry) => entry.id === leafId);
			while (current) {
				path.unshift(current);
				current = current.parentId
					? entries.find((entry) => entry.id === current.parentId)
					: undefined;
			}
			return path;
		},
		branch: (entryId) => {
			if (!entries.some((entry) => entry.id === entryId)) {
				throw new Error(`missing ${entryId}`);
			}
			leafId = entryId;
		},
		resetLeaf: () => {
			leafId = null;
		},
		appendMessage: (message) => {
			const entry = { type: "message", id: id(), parentId: leafId, message };
			entries.push(entry);
			leafId = entry.id;
			return entry.id;
		},
		appendCustomEntry: (customType, data) => {
			const entry = { type: "custom", customType, data, id: id(), parentId: leafId };
			entries.push(entry);
			leafId = entry.id;
			return entry.id;
		},
		buildSessionContext: () => ({
			messages: manager.getBranch()
				.filter((entry) => entry.type === "message")
				.map((entry) => entry.message),
		}),
	};
	return manager;
}

function makeStation(manager) {
	const pi = { on() {}, registerTool() {}, registerCommand() {} };
	return new SessionStation(manager, pi, {}, null, null);
}

function stateEntries(manager) {
	return manager
		.getBranch()
		.filter((entry) => entry.type === "custom" && entry.customType === SESSION_STATE_TYPE)
		.map((entry) => entry.data);
}

const REPORT = "elder report: the interior work is done";

function buildSession(manager) {
	const begin = {
		role: "assistant",
		content: [{ type: "toolCall", id: "begin-1", name: "scope", arguments: {} }],
	};
	const end = {
		role: "assistant",
		content: [{ type: "toolCall", id: "end-1", name: "scope", arguments: {} }],
	};
	manager.appendMessage({ role: "user", content: "start" });
	manager.appendMessage(begin);
	manager.appendMessage({ role: "toolResult", toolCallId: "begin-1", content: "ok" });
	manager.appendMessage({ role: "user", content: "interior work" });
	manager.appendMessage(end);
	manager.appendMessage({ role: "toolResult", toolCallId: "end-1", content: "done" });
	manager.appendMessage({ role: "user", content: "after" });
	return manager.buildSessionContext().messages;
}

function makeRecord() {
	return {
		beginToolCallId: "begin-1",
		endToolCallId: "end-1",
		report: REPORT,
		parentId: null,
		order: 0,
		collapsed: false,
		createdAt: 1000,
		boundary: 0,
		epoch: 0,
	};
}

describe("persistence across a branch-rewriting fold", () => {
	test("the write after a rebase is a checkpoint the reopened session can replay", () => {
		const manager = makeManager();
		const base = buildSession(manager);
		const station = makeStation(manager);
		const record = makeRecord();

		station.state.seq = 1;
		station.state.herdMode = true;
		station.state.pins.push("keep-me");
		station.state.charges["call-1"] = { scopeId: "scope-x", tool: "read", amount: 1 };
		station.state.collapses.push(record);

		// checkpoint, then a delta: the ordinary chain a session builds.
		station.persist();
		station.state.seq = 2;
		station.persist();
		expect(stateEntries(manager).length).toBe(2);

		const folded = station.foldBatch({
			batch: [record],
			base,
			currentMessage: base.at(-1),
			currentPersisted: true,
			epoch: 0,
		});
		expect(folded.rebased).toBe(true);

		// The fold moved the leaf back before the old state entries, so the
		// chain now lives on a new path. It must still anchor.
		const chain = stateEntries(manager);
		expect(chain.length).toBeGreaterThan(0);
		expect(isStateCheckpoint(chain[0])).toBe(true);
		expect(foldStateChain(chain)).toEqual(serializeState(station.state));

		const reopened = makeStation(manager);
		expect(reopened.state.pins).toEqual(["keep-me"]);
		expect(reopened.state.herdMode).toBe(true);
		expect(reopened.state.charges["call-1"]).toEqual({
			scopeId: "scope-x",
			tool: "read",
			amount: 1,
		});
		expect(reopened.state.collapses.length).toBe(1);
		expect(reopened.state.collapses[0].collapsed).toBe(true);
		expect(serializeState(reopened.state)).toEqual(serializeState(station.state));
	});

	/**
	 * A fold is not the only caller that may rewrite the branch: an export,
	 * a history tool, or a future fold path can move the leaf too. The station
	 * must therefore re-check its own anchor instead of trusting the writer.
	 * Here the rewrite is done straight on the manager, with no fold and no
	 * `rebased` flag, and the second write must still be a checkpoint.
	 */
	test("an unannounced branch rewrite forces the next write to be a checkpoint", () => {
		const manager = makeManager();
		manager.appendMessage({ role: "user", content: "start" });
		const station = makeStation(manager);

		station.state.seq = 1;
		station.state.pins.push("a");
		station.persist();
		const checkpointId = manager.entries.find(
			(entry) => entry.type === "custom" && entry.customType === SESSION_STATE_TYPE,
		).id;

		station.state.seq = 2;
		station.state.pins.push("b");
		station.persist();
		expect(isStateCheckpoint(stateEntries(manager).at(-1))).toBe(false);

		// The leaf moves back onto the checkpoint, dropping the delta. Nobody
		// tells the station.
		manager.branch(checkpointId);
		station.state.seq = 3;
		station.persist();

		const chain = stateEntries(manager);
		expect(isStateCheckpoint(chain.at(-1))).toBe(true);
		expect(foldStateChain(chain)).toEqual(serializeState(station.state));

		const reopened = makeStation(manager);
		expect(reopened.state.seq).toBe(3);
		expect(reopened.state.pins).toEqual(["a", "b"]);
		expect(serializeState(reopened.state)).toEqual(serializeState(station.state));
	});
});
