// Ratchet: a station must never detach a ticket with a bare `void`.
//
// The behavioral proof is in `tests/station-purity.test.mjs`: a rejecting
// ticket is recorded, and a synchronous throw is recorded. This scan keeps a
// new `void this.tickets.*` call from entering the station after that proof
// exists. It is a ratchet, not the acceptance test.

import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const STATION_DIR = join(import.meta.dir, "..", "..", "src", "station");

function sourceFiles(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sourceFiles(path));
		else if (entry.name.endsWith(".mjs")) out.push(path);
	}
	return out;
}

test("no station detaches a ticket with a bare void", () => {
	const offenders = [];
	for (const file of sourceFiles(STATION_DIR)) {
		const lines = readFileSync(file, "utf8").split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			if (/\bvoid\s+this\.tickets\./.test(lines[index])) {
				offenders.push(`${file}:${index + 1}: ${lines[index].trim()}`);
			}
		}
	}
	expect(offenders).toEqual([]);
});
