// Handoff ratchet: the relay decisions live in a pure domain module, and the
// handoff adapter keeps only the side effects. This bounds the inline decision
// surface so the next slice starts from a lower count, never a higher one.

import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const domain = readFileSync(
	new URL("../../src/station/domain/handoff.mjs", import.meta.url),
	"utf8",
);
const controls = readFileSync(
	new URL("../../src/station/handoff-state.mjs", import.meta.url),
	"utf8",
);

const DECISIONS = [
	"decideRelayEvaluation",
	"decideRetirement",
	"decideHandoffArm",
	"decideHandoffAdvance",
	"decideNaturalStop",
	"decideInheritedLedgerViewed",
	"decideHandoffReport",
	"decideSelfHandoff",
];

describe("handoff ratchet", () => {
	test("the domain has no Station or host dependency", () => {
		expect(domain).not.toMatch(/from\s+["'][^"']*station\.mjs/);
		expect(domain).not.toMatch(/from\s+["'][^"']*\/host\//);
		expect(domain).not.toContain("this.");
		expect(domain).not.toContain("Object.create(");
	});

	test("the decisions live in the domain and the controls import them", () => {
		for (const name of DECISIONS) {
			expect(domain).toContain(`export function ${name}`);
			expect(controls).toContain(name);
		}
		expect(controls).not.toContain("applyLedgerEvaluation(");
		expect(controls).not.toContain("applyRetirement(");
		expect(controls).not.toContain("beginGenerationAfterHandoff(");
		expect(controls).not.toContain("ledgerStats(");
	});

	test("no string relay comparison remains in the adapter", () => {
		expect(controls).not.toMatch(/relay\s*===\s*["'](none|ledger|handoff)["']/);
		expect(controls).not.toMatch(/relay\s*!==\s*["'](none|ledger|handoff)["']/);
	});
});
