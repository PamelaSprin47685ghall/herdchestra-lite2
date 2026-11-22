// The Station class must not import host modules directly: host capabilities
// arrive through the registry's host() bag. The registry is the composition
// bridge; every other station file is host-free.

import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const HOST_IMPORT = /from\s+["'](?:\.\.\/host\/|\.\.\/\.\.\/host\/)/;

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (entry.name.endsWith(".mjs")) out.push(full);
	}
	return out;
}

function hostImports(file) {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => HOST_IMPORT.test(line));
}

test("SessionStation is host-free", () => {
	const source = readFileSync("src/station/station.mjs", "utf8");
	expect(hostImports("src/station/station.mjs")).toEqual([]);
	expect(source).toContain("toolCallLedger");
	expect(source).not.toMatch(/this\.processed\s*=/);
	expect(source).not.toMatch(/this\.dispatch\s*=/);
	expect(source).not.toMatch(/this\.toolGate\s*=/);
});

test("every other station file is host-free", () => {
	const counts = new Map();
	for (const file of walk("src/station")) {
		const count = hostImports(file).length;
		if (count > 0) counts.set(file, count);
	}
	// The registry owns the injection point and is not counted here.
	counts.delete("src/station/registry.mjs");
	expect([...counts.entries()].sort()).toEqual([]);
});
