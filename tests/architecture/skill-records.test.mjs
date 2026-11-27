// Skill records ratchet: a design record points at files that exist.
//
// The records under `.agent/skills/` are read by humans and by the next lead, and
// nothing used to read them by machine. A stale pointer — a deleted facade, a
// renamed module, "the ledger snapshot is version 2" — survived for weeks because
// no check looked. This one looks: the frontmatter must name its own directory,
// and every concrete repo path a record quotes must be on disk.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SKILLS = join(ROOT, ".agent", "skills");

// Only paths a real file occupies. A glob, a placeholder, or a prose reference is
// not a claim this test can verify, and pretending otherwise would only teach the
// next writer to delete the backticks.
const PREFIXES = ["src/", "host-omp/", "host-omp-ui/", "tests/", "scripts/", "resources/"];
const SELECTOR = /:\d+(?:-\d+)?$/;

function skillDirs() {
	return readdirSync(SKILLS, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

function frontmatterName(text) {
	if (!text.startsWith("---\n")) return null;
	const end = text.indexOf("\n---", 4);
	if (end < 0) return null;
	const block = text.slice(4, end);
	const match = block.match(/^name:\s*(\S+)\s*$/m);
	return match ? match[1] : null;
}

/** Expand one `{a,b}` group, so a record may name sibling files in one span. */
function expand(path) {
	const match = path.match(/^(.*)\{([^{}]+)\}(.*)$/);
	if (!match) return [path];
	return match[2]
		.split(",")
		.map((part) => `${match[1]}${part.trim()}${match[3]}`);
}

function quotedPaths(text) {
	const found = new Set();
	for (const match of text.matchAll(/`([^`\n]+)`/g)) {
		const raw = match[1].trim();
		if (/\s/.test(raw)) continue;
		if (/[*<>]/.test(raw)) continue;
		const path = raw.replace(SELECTOR, "");
		if (!PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
		for (const expanded of expand(path)) found.add(expanded);
	}
	return [...found].sort();
}

describe("skill records point at files that exist", () => {
	const dirs = skillDirs();

	test("every record names its own directory", () => {
		expect(dirs.length).toBeGreaterThan(0);
		for (const name of dirs) {
			const text = readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");
			expect(frontmatterName(text)).toBe(name);
		}
	});

	test("no record quotes a path that is gone", () => {
		const missing = [];
		for (const name of dirs) {
			const text = readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");
			for (const path of quotedPaths(text)) {
				if (!existsSync(join(ROOT, path))) missing.push(`${name} -> ${path}`);
			}
		}
		expect(missing).toEqual([]);
	});
});
