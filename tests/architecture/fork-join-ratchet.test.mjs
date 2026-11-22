// Fork/join ratchet: the decision logic lives in a pure domain module, and the
// handlers keep only the side effects. This bounds the station-taking surface
// so the next slice starts from a lower count, never a higher one.

import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const domain = readFileSync(
	new URL("../../src/station/domain/fork-join.mjs", import.meta.url),
	"utf8",
);
const controls = readFileSync(
	new URL("../../src/station/fork-controls.mjs", import.meta.url),
	"utf8",
);

function count(text, pattern) {
	return [...text.matchAll(pattern)].length;
}

// The handlers still own take/commit/persist; this is the post-slice baseline.
// A new station-taking free function must remove one, not add one.
const STATION_FUNCTIONS_BASELINE = 20;

describe("fork/join ratchet", () => {
	test("the domain has no Station or host dependency", () => {
		expect(domain).not.toMatch(/from\s+["'][^"']*station\.mjs/);
		expect(domain).not.toMatch(/from\s+["'][^"']*\/host\//);
		expect(domain).not.toContain("this.state");
		expect(domain).not.toContain("Object.create(");
	});

	test("the decisions live in the domain and the controls import them", () => {
		expect(domain).toContain("export function decideJoinAdmission");
		expect(domain).toContain("export function decideForkAdmission");
		expect(domain).toContain("export function decidePendingReport");
		expect(domain).toContain("export function decideJoinBinding");
		expect(domain).toContain("export function decideRegister");
		expect(domain).toContain("export function decideReturn");
		expect(domain).toContain("export function decideReady");
		expect(domain).toContain("decideAbandon");
		expect(controls).toContain("decideJoinAdmission");
		expect(controls).toContain("decidePendingReport");
		expect(controls).toContain("decideJoinBinding");
		expect(controls).toContain("decideRegister");
		expect(controls).toContain("decideReady");
		expect(controls).toContain("decideReturn");
		expect(controls).toContain("validateForkBatch");
		expect(controls).not.toContain("function lastUnreportedReceipt");
		expect(controls).not.toContain("function pendingOf");
	});

	test("no station-taking free function was added", () => {
		const stationFunctions = count(
			controls,
			/\n(?:export )?function\s+[A-Za-z0-9_$]+\(\s*station\b/g,
		);
		expect(stationFunctions).toBeLessThanOrEqual(STATION_FUNCTIONS_BASELINE);
		expect(controls).not.toContain("Object.create(station)");
	});
});
