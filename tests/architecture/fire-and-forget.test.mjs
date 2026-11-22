// Ratchets for the station's ticket boundary.
//
// The behavioral proof is in `tests/station-purity.test.mjs`: a rejecting
// ticket is recorded, a synchronous throw is recorded, and a refused model
// switch lands in the station's failure record. These scans keep a new
// `void this.tickets.*` call, a bare `this.tickets.*(...)` statement, or a
// ticket that writes `station.lastError` from entering after that proof
// exists. They are ratchets, not the acceptance tests.

import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "src");
const HOST_ROOT = join(import.meta.dir, "..", "..", "host-omp", "src");
const STATION_DIR = join(ROOT, "station");
// Tickets span both packages after the split: pure tickets in core, host
// tickets in the host package.
const TICKET_DIRS = [join(ROOT, "tools"), join(HOST_ROOT, "activation")];
const WIRING_DIRS = [join(HOST_ROOT, "activation"), join(HOST_ROOT, "host")];

function sourceFiles(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sourceFiles(path));
		else if (entry.name.endsWith(".mjs")) out.push(path);
	}
	return out;
}

/**
 * True when the line opens a call whose result is discarded.
 *
 * A line that begins with `this.tickets.<name>(` is a statement start, unless
 * the previous code line ends in an operator that keeps the call in a larger
 * expression, such as the `=>` of a fire-and-forget body.
 */
function bareTicketStatement(lines, index) {
	if (!/^\s*this\.tickets\.[A-Za-z_$][\w$]*\s*\(/.test(lines[index])) return false;
	for (let before = index - 1; before >= 0; before -= 1) {
		const previous = lines[before].trim();
		if (!previous || previous.startsWith("//") || previous.startsWith("*")) continue;
		return !/(=>|[=,([]|\|\||&&|\?|:)$/.test(previous);
	}
	return true;
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

test("no station runs a ticket call as a discarded statement", () => {
	const offenders = [];
	for (const file of sourceFiles(STATION_DIR)) {
		const lines = readFileSync(file, "utf8").split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			if (bareTicketStatement(lines, index)) {
				offenders.push(`${file}:${index + 1}: ${lines[index].trim()}`);
			}
		}
	}
	expect(offenders).toEqual([]);
});

/**
 * True when the line starts a ticket call whose promise is discarded.
 *
 * A call that opens a line may still continue an enclosing expression, such as
 * the `=>` of a ticket body or a `detach(() => ...)` wrapper; a call that ends
 * in `.catch(` carries its own catch-all.
 */
function discardedWiringTicket(lines, index) {
	if (!/^\s*[A-Za-z_$][\w$.]*Ticket\s*\(/.test(lines[index])) return false;
	if (/\.catch\s*\(/.test(lines[index])) return false;
	for (let before = index - 1; before >= 0; before -= 1) {
		const previous = lines[before].trim();
		if (!previous || previous.startsWith("//") || previous.startsWith("*")) continue;
		return !/(=>|[=,([]|\|\||&&|\?|:)$/.test(previous);
	}
	return true;
}

test("no wiring drops a ticket promise or a voided call", () => {
	const offenders = [];
	for (const dir of WIRING_DIRS) {
		for (const file of sourceFiles(dir)) {
			const lines = readFileSync(file, "utf8").split("\n");
			for (let index = 0; index < lines.length; index += 1) {
				const line = lines[index];
				if (/\bvoid\s+[A-Za-z_$][\w$.]*\s*\(/.test(line)) {
					offenders.push(`${file}:${index + 1}: ${line.trim()}`);
					continue;
				}
				if (discardedWiringTicket(lines, index)) {
					offenders.push(`${file}:${index + 1}: ${line.trim()}`);
				}
			}
		}
	}
	expect(offenders).toEqual([]);
});

test("no ticket writes the station failure field directly", () => {
	const offenders = [];
	for (const dir of TICKET_DIRS) {
		for (const file of sourceFiles(dir)) {
			const lines = readFileSync(file, "utf8").split("\n");
			for (let index = 0; index < lines.length; index += 1) {
				if (/\.lastError\s*=/.test(lines[index])) {
					offenders.push(`${file}:${index + 1}: ${lines[index].trim()}`);
				}
			}
		}
	}
	expect(offenders).toEqual([]);
});
