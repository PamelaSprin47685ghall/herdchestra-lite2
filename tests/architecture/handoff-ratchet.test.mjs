// Handoff ratchet: the unified scope_return / rewind decisions live in a pure
// domain module, and the handoff adapter keeps only the synchronous side effects.

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
	"parseReturnOath",
	"decideScopeReturn",
	"formatGenerationReport",
	"formatRebornPrompt",
	"rebornStartPrompt",
	"resetRootPromotion",
];

describe("handoff ratchet", () => {
	test("the domain has no Station or host dependency", () => {
		expect(domain).not.toMatch(/from\s+["'][^"']*station\.mjs/);
		expect(domain).not.toMatch(/from\s+["'][^"']*\/host\//);
		expect(domain).not.toContain("this.");
		expect(domain).not.toContain("Object.create(");
	});

	test("the decisions live in the domain and the adapter imports them", () => {
		for (const name of DECISIONS) {
			expect(domain).toContain(`export function ${name}`);
		}
		expect(controls).toContain("formatRebornPrompt");
		expect(controls).toContain("rebornStartPrompt");
		expect(controls).toContain("resetRootPromotion");
	});

	test("the return decision has no woken-forward branch", () => {
		// A woken scope is answered through `scope_request`/`scope_reply`; the
		// old "forward dafny to the parent" path would now mean a second reply
		// for the same turn, so it must stay deleted.
		expect(domain).not.toMatch(/kind:\s*"forward"/);
		expect(domain).not.toMatch(/\bwoken\b/);
	});

	test("the machine channel for ending the loop is details.stopLoop", () => {
		// The js tool is the only tool the model can call, so the host cannot
		// key the stop on a tool name; the returned decision object is the
		// contract.
		expect(domain).toMatch(/stopLoop:\s*true/);
	});
});
