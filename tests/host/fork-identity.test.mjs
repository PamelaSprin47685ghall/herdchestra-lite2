import { describe, expect, test } from "bun:test";

import {
	buildChildIdentity,
	resolveForkLedger,
} from "../../src/station/domain/identity.mjs";

describe("resolveForkLedger", () => {
	const identityLedger = { id: "identity", order: [] };
	const liveIndex = { id: "index", order: ["f1"] };
	const restored = { id: "restored", order: [] };

	test("an identity ledger wins over every index", () => {
		expect(
			resolveForkLedger({
				identity: { ledger: identityLedger },
				indexed: liveIndex,
				restored,
			}),
		).toBe(identityLedger);
	});

	test("a live index wins over a restored tree", () => {
		expect(resolveForkLedger({ indexed: liveIndex, restored })).toBe(liveIndex);
	});

	test("an empty index falls back to the restored tree", () => {
		const empty = { id: "empty", order: [] };
		expect(resolveForkLedger({ indexed: empty, restored })).toBe(restored);
	});

	test("without a restored tree the empty index is the answer", () => {
		const empty = { id: "empty", order: [] };
		expect(resolveForkLedger({ indexed: empty })).toBe(empty);
	});

	test("a missing everything is null", () => {
		expect(resolveForkLedger({})).toBeNull();
	});
});

describe("buildChildIdentity", () => {
	test("carries fork facts and host dependencies", () => {
		const ledger = { order: ["f1"] };
		const persistRoot = () => true;
		const display = { current: null };
		const holder = { current: display };
		const spec = {
			forkId: "f1",
			parentOwnerId: "root",
			ownScopeId: "scope-1",
			knuth_nfa_inspired_fsm: "read the parser",
			budget: { read: 2 },
			time: 90,
			targets: ["src/parser.mjs"],
			childDepth: 1,
		};
		const identity = buildChildIdentity(spec, {
			agentId: "fork-agent",
			ledger,
			persistRoot,
			display,
			displayHolder: holder,
		});
		expect(identity).toMatchObject({
			forkId: "f1",
			parentOwnerId: "root",
			ownScopeId: "scope-1",
			knuth_nfa_inspired_fsm: "read the parser",
			budget: { read: 2 },
			time: 90,
			targets: ["src/parser.mjs"],
			childDepth: 1,
			agentId: "fork-agent",
			display,
			displayHolder: holder,
			ledger,
			persistRoot,
		});
	});

	test("does not mutate the spec or dependency objects", () => {
		const spec = { forkId: "f2", budget: { read: 1 }, targets: ["a"] };
		const ledger = { order: [] };
		const beforeSpec = JSON.stringify(spec);
		const beforeLedger = JSON.stringify(ledger);
		const identity = buildChildIdentity(spec, { ledger });
		expect(JSON.stringify(spec)).toBe(beforeSpec);
		expect(JSON.stringify(ledger)).toBe(beforeLedger);
		expect(identity.budget).not.toBe(spec.budget);
	});

	test("turns absent values into nulls without inventing facts", () => {
		expect(buildChildIdentity()).toEqual({
			forkId: null,
			parentOwnerId: null,
			ownScopeId: null,
			knuth_nfa_inspired_fsm: null,
			budget: null,
			time: null,
			targets: null,
			childDepth: null,
			agentId: null,
			display: null,
			displayHolder: null,
			ledger: null,
			persistRoot: null,
		});
	});
});
