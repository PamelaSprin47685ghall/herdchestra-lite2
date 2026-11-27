// Fork/join ratchet: the decision logic lives in a pure domain module, and the
// handlers keep only the side effects. This bounds the station-taking surface
// so the next slice starts from a lower count, never a higher one.

import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const STATION_DIR = new URL("../../src/station/", import.meta.url);
const SCOPE_DIR = new URL("../../src/scope/", import.meta.url);

const read = (dir, name) => readFileSync(new URL(name, dir), "utf8");

const domain = read(STATION_DIR, "domain/fork-join.mjs");

// The control surface is split by handler family. The files are discovered by
// name shape, not listed by hand: a sixth `*-controls.mjs` module cannot escape
// the count by simply not being named here.
const CONTROL_FILES = readdirSync(STATION_DIR)
	.filter((name) => name === "fork-reads.mjs" || name.endsWith("-controls.mjs"))
	.sort();
const controls = CONTROL_FILES.map((name) => read(STATION_DIR, name)).join("\n");

function count(text, pattern) {
	return [...text.matchAll(pattern)].length;
}

// The control surface is split by handler family.
const STATION_FUNCTIONS_BASELINE = 24;

describe("fork/join ratchet", () => {
	test("the control surface is discovered, not hand-listed", () => {
		expect(CONTROL_FILES.length).toBeGreaterThanOrEqual(5);
	});

	test("the domain has no Station or host dependency", () => {
		expect(domain).not.toMatch(/from\s+["'][^"']*station\.mjs/);
		expect(domain).not.toMatch(/from\s+["'][^"']*\/host\//);
		expect(domain).not.toContain("this.state");
		expect(domain).not.toContain("Object.create(");
	});

	test("the decisions live in the domain and the controls import them", () => {
		expect(domain).toContain("export function decideJoinAdmission");
		expect(domain).toContain("export function decideForkAdmission");
		expect(domain).toContain("export function decideRegister");
		expect(domain).toContain("export function decideReturn");
		expect(domain).toContain("export function decideReady");
		expect(domain).toContain("decideAbandon");
		expect(controls).toContain("decideJoinAdmission");
		expect(controls).toContain("decideRegister");
		expect(controls).toContain("decideReady");
		expect(controls).toContain("decideReturn");
		expect(controls).toContain("validateForkBatch");
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

// A `scope_request` is a live Promise, not a record: it exists only while the
// requester is parked. Persisting it would serialize a resolver that no reload can
// honour, so the persistence layer must never name the request table.
describe("the request queue stays in memory", () => {
	// The persistence implementation is split, and scanning only the facade would
	// make this ratchet vacuous. Files are selected by the shape they carry, so a
	// further split is covered without touching this test.
	const PERSISTENCE_MARKERS =
		/serializeState|deserializeState|planStateEntry|foldLedgerEntry|applyDelta|normalizeStateEntry|planLedgerEntry|STATE_ENTRY_VERSION/;
	const PERSISTENCE_FILES = readdirSync(SCOPE_DIR)
		.filter((name) => name.endsWith(".mjs") && name !== "state.mjs")
		.filter((name) => PERSISTENCE_MARKERS.test(read(SCOPE_DIR, name)))
		.sort();
	const persistence = PERSISTENCE_FILES.map((name) => read(SCOPE_DIR, name)).join("\n");

	test("the persistence surface is discovered, not hand-listed", () => {
		expect(PERSISTENCE_FILES).toContain("persistence.mjs");
		expect(PERSISTENCE_FILES.length).toBeGreaterThanOrEqual(5);
	});

	test("no serialized state carries a request queue", () => {
		expect(persistence).not.toMatch(/registry\.requests/);
		expect(persistence).not.toMatch(/\bpendingRequests?\b/);
		expect(persistence).not.toMatch(/\bwaitFor\b/);
	});

	test("the state holds no request queue", () => {
		const state = readFileSync(
			new URL("../../src/scope/state.mjs", import.meta.url),
			"utf8",
		);
		expect(state).not.toMatch(/\brequests\s*:/);
		expect(state).not.toMatch(/\bwaitFor\s*:/);
	});
});
