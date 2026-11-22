/**
 * The project skills. They live under resources/skills/ and are read once,
 * synchronously, at module scope -- never inside a station method. inject.mjs
 * embeds the frozen bodies into the managed system prompt, so every request
 * carries the full text instead of a skill:// pointer the model may skip.
 */

import { readFileSync, readdirSync } from "node:fs";

const ROOT = new URL("../../resources/skills/", import.meta.url);
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

function fail(message, cause) {
	throw new Error(message, cause === undefined ? undefined : { cause });
}

function readSkill(name) {
	let raw;
	try {
		raw = readFileSync(new URL(`${name}/SKILL.md`, ROOT), "utf8");
	} catch (error) {
		throw fail(`Missing skill body: ${name}/SKILL.md`, error);
	}
	const text = raw.replace(/\r\n/g, "\n");
	if (!text.startsWith("---\n")) throw fail(`Skill has no frontmatter: ${name}`);
	const body = text.replace(FRONTMATTER, "").trim();
	if (body === "") throw fail(`Empty skill body: ${name}`);
	return Object.freeze({ name, body });
}

let names;
try {
	names = readdirSync(ROOT, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
} catch (error) {
	throw fail("Missing resources/skills directory", error);
}

for (const name of names) {
	if (!NAME.test(name)) throw fail(`Invalid skill directory: ${name}`);
}
if (names.length === 0) throw fail("No skills under resources/skills");

/** Every skill, sorted by name, with the YAML frontmatter removed. */
export const inlinedSkills = Object.freeze(names.map(readSkill));

export const SKILL_NAMES = Object.freeze(inlinedSkills.map((skill) => skill.name));

/** One deterministic block; inject.mjs places it inside its managed markers. */
export const inlinedSkillsSection = [
	"## Skills (inlined)",
	"The project skills are reproduced in full below. They are authoritative and need no `skill://` read.",
	...inlinedSkills.map(
		({ name, body }) => `<inlined-skill name="${name}">\n${body}\n</inlined-skill>`,
	),
].join("\n\n");

/** Load every skill now; a missing body throws here, at startup. */
export function preloadSkills() {
	return inlinedSkills.length;
}
