/**
 * Long-session write volume.
 *
 * The append-only state log exists for one reason: a full snapshot per turn
 * grows the session file by the whole state each time. This test drives the
 * station's real `persist()` for 400 turns with the shapes a real session
 * accumulates (growing `pins` and `charges`, bounded `regrets`, scope churn
 * with collapses, model caches), then compares the bytes written against the
 * bytes a per-turn full snapshot would have written. It also folds the
 * resulting chain back and demands the exact final state.
 *
 * A policy regression (always checkpoint, or a delta for every field) fails
 * the ratio, not a snapshot of an implementation detail.
 */

import { describe, expect, test } from "bun:test";
import { SessionStation } from "../src/station/index.mjs";
import { foldStateChain, serializeState } from "../src/scope/index.mjs";
import { SESSION_STATE_TYPE, restoreState } from "../src/station/restore.mjs";

const TURNS = 400;

function makeManager() {
	const entries = [];
	const visible = new Set();
	let leafId = null;
	let nextId = 1;
	const manager = {
		entries,
		writes: 0,
		appendedBytes: 0,
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
		appendMessage: (message) => {
			const entry = { type: "message", id: `e${nextId++}`, parentId: leafId, message };
			entries.push(entry);
			leafId = entry.id;
			for (const block of message.content ?? []) {
				if (block?.type === "toolCall") visible.add(block.id);
			}
			return entry.id;
		},
		appendCustomEntry: (customType, data) => {
			manager.writes += 1;
			manager.appendedBytes += len(entryBytes(data));
			const entry = { type: "custom", customType, data, id: `e${nextId++}`, parentId: leafId };
			entries.push(entry);
			leafId = entry.id;
			return entry.id;
		},
		buildSessionContext: () => ({
			messages: [
				{
					role: "assistant",
					content: [...visible].map((id) => ({ type: "toolCall", id, name: "scope" })),
				},
			],
		}),
	};
	return manager;
}

// What omp actually stores per entry: the envelope plus the payload.
function entryBytes(data) {
	return JSON.stringify(data);
}

function len(text) {
	return text.length;
}

function makeStation(manager) {
	const pi = { on() {}, registerTool() {}, registerCommand() {} };
	return new SessionStation(manager, pi, {}, null, null);
}

const REPORT = "x".repeat(1400);

describe("long-session write volume", () => {
	test(`${TURNS} turns write a small fraction of the per-turn snapshot baseline`, () => {
		const manager = makeManager();
		const station = makeStation(manager);
		const state = station.state;
		let baselineBytes = 0;
		let scopeCount = 0;
		let collapsed = 0;

		for (let turn = 0; turn < TURNS; turn += 1) {
			state.seq += 1;
			state.pins.push(`pin-${turn}`);

			// Regrets stay bounded in a real session: they are consumed and
			// removed, which exercises the array truncation path.
			state.regrets.push(`call-${turn}`);
			if (state.regrets.length > 8) state.regrets.shift();

			// One charge per tool call, keyed by call id: monotonically growing.
			state.charges[`call-${turn}`] = {
				scopeId: `scope-${scopeCount}`,
				tool: turn % 3 === 0 ? "read" : "bash",
				amount: turn % 4 === 0 ? 2 : 1,
			};

			if (turn % 5 === 0) {
				state.modelCaches[`model-${turn / 5}`] = {
					cachedUntilPos: turn,
					lastUsedAt: 1000 + turn,
					tokensPerChar: 0.25,
				};
			}

			// Scope churn: a new scope every 40 turns, each closing into a
			// collapse record. This is the shape that dominates long sessions.
			if (turn % 40 === 0) {
				scopeCount += 1;
				manager.appendMessage({
					role: "assistant",
					content: [{ type: "toolCall", id: `begin-${scopeCount}`, name: "scope" }],
				});
				if (state.scopes.length > 0) {
					const closed = state.scopes.pop();
					collapsed += 1;
					state.collapses.push({
						beginToolCallId: closed.beginToolCallId,
						endToolCallId: `end-${scopeCount}`,
						report: REPORT,
						parentId: null,
						order: collapsed,
						collapsed: true,
						createdAt: 1000 + turn,
						boundary: turn,
						epoch: turn,
						scopeId: closed.id,
						intent: closed.intent,
						sealed: true,
						interiorTokens: 500,
						interiorChars: 2000,
					});
				}
				state.scopes.push({
					id: `scope-${scopeCount}`,
					boundary: turn,
					epoch: turn,
					intent: `work item ${scopeCount}`,
					stage: "direct-execution",
					beginToolCallId: `begin-${scopeCount}`,
					budget: { read: 5, bash: 5 },
					remaining: { read: 4 - (turn % 4), bash: 5 },
					spent: { read: turn % 4, bash: 0 },
					defers: [],
					residualDefers: [],
				});
			}

			// The baseline: what the old implementation wrote every turn.
			baselineBytes += len(JSON.stringify(serializeState(state)));
			station.persist();
		}

		// An idle turn writes nothing at all.
		const writesBeforeIdle = manager.writes;
		station.persist();
		expect(manager.writes).toBe(writesBeforeIdle);

		const ratio = manager.appendedBytes / baselineBytes;
		// Stay quiet while the policy holds; a failure carries its own numbers.
		if (ratio >= 0.2) {
			console.log(
				`turns=${TURNS} writes=${manager.writes} appended=${manager.appendedBytes}B baseline=${baselineBytes}B ratio=${(ratio * 100).toFixed(1)}% final=${len(JSON.stringify(serializeState(state)))}B`,
			);
		}

		// A checkpoint every 64 writes bounds replay, so the floor is roughly
		// `turns / 64` snapshots. Anything near the baseline means the delta
		// policy stopped working (every entry a checkpoint, or a delta that
		// rewrites the whole state).
		expect(ratio).toBeLessThan(0.2);
		expect(manager.writes).toBeLessThanOrEqual(TURNS);

		// The chain must fold back to exactly the state that was persisted.
		const chain = manager
			.getBranch()
			.filter((entry) => entry.customType === SESSION_STATE_TYPE)
			.map((entry) => entry.data);
		expect(foldStateChain(chain)).toEqual(serializeState(state));

		// And the station must restore it without losing a field.
		const reopened = makeStation(manager);
		expect(serializeState(reopened.state)).toEqual(serializeState(state));
	});
});
