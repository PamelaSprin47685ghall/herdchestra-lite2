import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { DOCUMENTS, preloadDocs } from "../src/prompts/index.mjs";

const ROOT = new URL("../resources/prompts/", import.meta.url);

function walk(dir, prefix = "") {
	const names = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			names.push(...walk(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`));
		} else if (entry.name.endsWith(".md")) {
			names.push(`${prefix}${entry.name.slice(0, -3)}`);
		}
	}
	return names;
}

describe("prompt preload", () => {
	test("DOCUMENTS names every shipped prompt document", () => {
		expect([...DOCUMENTS].sort()).toEqual(walk(ROOT).sort());
	});

	test("preloadDocs loads every document", () => {
		expect(preloadDocs()).toBe(DOCUMENTS.length);
	});
});
