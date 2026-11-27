import { describe, expect, test } from "bun:test";

import { selectForkLedger } from "../../../src/station/domain/fork-ledger.mjs";

function ledger(order = [], totals = {}) {
	return { order: [...order], totals };
}

describe("selectForkLedger", () => {
	test("a child identity always keeps its fork ledger", () => {
		const own = ledger(["f1"]);
		const chosen = selectForkLedger({
			identity: { ledger: own },
			indexed: ledger(["other"]),
			restored: ledger(["restored"]),
		});
		expect(chosen.ledger).toBe(own);
		expect(chosen.source).toBe("identity");
	});

	test("a live index with forks wins over a restored tree", () => {
		const indexed = ledger(["live"]);
		const restored = ledger(["restored"]);
		expect(selectForkLedger({ indexed, restored }).ledger).toBe(indexed);
	});

	test("a restored non-empty tree wins over an empty index", () => {
		const indexed = ledger([]);
		const restored = ledger(["restored"]);
		expect(selectForkLedger({ indexed, restored }).ledger).toBe(restored);
	});

	test("an empty chosen ledger takes the other candidate's samples", () => {
		const empty = ledger([]);
		const sampled = ledger([], { turns: 3, turnMs: 120 });
		const chosen = selectForkLedger({ indexed: empty, restored: sampled });
		expect(chosen.ledger).toBe(sampled);
		expect(chosen.filled).toBe(false);
		const other = selectForkLedger({ indexed: null, restored: empty });
		expect(other.ledger).toBe(empty);
		expect(other.source).toBe("restored");
		expect(other.filled).toBe(false);
	});

	test("a chosen ledger with no samples is filled once", () => {
		const restored = ledger([], { turns: 4, turnMs: 90 });
		const indexed = ledger(["live"], { turns: 0, turnMs: 0 });
		const chosen = selectForkLedger({ indexed, restored });
		expect(chosen.ledger).toBe(indexed);
		expect(chosen.filled).toBe(true);
		expect(indexed.totals).toEqual({ turns: 4, turnMs: 90 });
	});

	test("two sampled ledgers are never summed", () => {
		const restored = ledger([], { turns: 4, turnMs: 90 });
		const indexed = ledger(["live"], { turns: 2, turnMs: 10 });
		const chosen = selectForkLedger({ indexed, restored });
		expect(chosen.filled).toBe(false);
		expect(indexed.totals).toEqual({ turns: 2, turnMs: 10 });
	});

	test("a create fallback mints a ledger when both candidates are absent", () => {
		const minted = ledger([]);
		const chosen = selectForkLedger({ create: () => minted });
		expect(chosen.ledger).toBe(minted);
		expect(chosen.source).toBe("created");
		expect(chosen.adopt).toBe(true);
	});

	test("the live index is used in place, so the caller does not adopt it", () => {
		const indexed = ledger(["live"]);
		const chosen = selectForkLedger({
			indexed,
			restored: ledger(["restored"]),
			create: () => ledger([]),
		});
		expect(chosen.ledger).toBe(indexed);
		expect(chosen.source).toBe("indexed");
		expect(chosen.adopt).toBe(false);
	});

	test("an empty index is not live, so the caller still adopts it", () => {
		const indexed = ledger([]);
		const chosen = selectForkLedger({ indexed, create: () => ledger([]) });
		expect(chosen.ledger).toBe(indexed);
		expect(chosen.source).toBe("indexed");
		expect(chosen.adopt).toBe(true);
	});
});
