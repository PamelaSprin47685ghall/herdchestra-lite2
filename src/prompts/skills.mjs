/**
 * The project's meta skills. They live under resources/skills/ and are read
 * once, synchronously, at module scope -- never inside a station method.
 * inject.mjs embeds the frozen bodies only when the workspace feature selects
 * the full profile; the engineering policy itself lives in features.md.
 */

import { readFileSync } from "node:fs";

const ROOT = new URL("../../resources/skills/", import.meta.url);
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

/** The only skills that are inlined, and only for workspace=full. */
export const META_SKILLS = Object.freeze(["polish", "prompt-craft", "skill-authoring"]);

/** Every meta skill, sorted by name, with the YAML frontmatter removed. */
export const inlinedSkills = Object.freeze(
	META_SKILLS.map(readSkill).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
);

/** One deterministic block; inject.mjs places it inside its managed markers. */
export const metaSkillsSection = [
	"## Skills (inlined)",
	"The project meta skills are reproduced in full below. They are authoritative and need no `skill://` read.",
	...inlinedSkills.map(
		({ name, body }) => `<inlined-skill name="${name}">\n${body}\n</inlined-skill>`,
	),
].join("\n\n");

/** Load every meta skill now; a missing body throws here, at startup. */
export function preloadSkills() {
	return inlinedSkills.length;
}
