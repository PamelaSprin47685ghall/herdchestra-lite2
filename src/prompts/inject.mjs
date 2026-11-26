// Prompt text and prompt injection. Text comes from resources/prompts/.
//
// This module is pure: it reads resources and returns the next prompt. The
// host layer re-exports it so the Station can inject the managed block without
// depending on the host adapter.

import { loadDoc, placeholderNames } from "./index.mjs";
import { inlinedSkillsSection } from "./skills.mjs";
import { renderCapabilitiesDts } from "../tools/js-protocol.mjs";

const system = loadDoc("system");
const forkJoin = loadDoc("tools/fork-join");

const systemPromptStart = "<!-- herdchestra-lite2:system-prompt v1 -->";
const systemPromptEnd = "<!-- /herdchestra-lite2:system-prompt -->";

export const persistentOperatingSkill = system["persistent-rules"];

// The scope and relay section is one fixed text for every request. A forked
// scope inherits the owner's prompt prefix, and the host clears the inherited
// provider cache key whenever the system prompt changes, so a per-request
// section would make every child's first request re-prefill the whole prompt.
// The section states both duties instead of swapping them; the current mode
// reaches the model through the receipt, never through this block.
const scopeRules = system["scope-rules"];

/**
 * The control plane's own contract. `js` is the only registered tool, so the
 * five `scope_*` methods have no JSON schema to carry a description; this text
 * is the carrier, compiled next to the declarations it constrains. A section
 * that declares a placeholder is a receipt rendered elsewhere, not prose, and
 * a raw template must never enter the prompt: those are skipped.
 */
function controlPlaneSkill() {
	const sections = Object.keys(forkJoin)
		.filter((key) => placeholderNames(forkJoin[key]).length === 0)
		.map((key) => `### ${key}\n\n${forkJoin[key]}`);
	if (sections.length === 0) return "";
	return `<skill version="1.0" enforced>\n${sections.join("\n\n")}\n</skill>`;
}

// The Simplified-Chinese reminder is one line inside the persistent rules.
// Turning `chineseReminder` off removes that line and nothing else, so the
// rest of the skill text stays byte-identical. The line is matched by its
// text, not by a bullet prefix, because the document may carry it either way.
const CHINESE_REMINDER = "强制以简体中文思考";

function persistentRulesBlock(options) {
	if (options?.chineseReminder !== "off") return persistentOperatingSkill;
	return persistentOperatingSkill
		.split("\n")
		.filter((line) => !line.includes(CHINESE_REMINDER))
		.join("\n");
}

// The tool declarations are compiled from the confiscated tools' own JSON
// schemas. One cache per tool-name set: a host that adds or drops a tool
// changes the names, which is the only event that can change the compiled
// text, and the prefix stays byte-identical for every request in between.
let cachedToolKey = "";
let cachedToolDts = "";

function capabilitiesSection(options = {}) {
	const specs = Array.isArray(options.toolSpecs) ? options.toolSpecs : [];
	if (specs.length === 0) return "";
	const key = specs
		.map((spec) => String(spec?.name ?? ""))
		.sort()
		.join("|");
	if (key !== cachedToolKey) {
		cachedToolDts = renderCapabilitiesDts(specs);
		cachedToolKey = key;
	}
	return cachedToolDts;
}

/**
 * Build the managed block: persistent rules, the inlined skill bodies, the one
 * scope-and-relay section, then the tool declarations. Nothing in the block
 * depends on the request, so an owner and a forked scope share the same bytes.
 * The block is replaced between its markers on every injection, so a second
 * call returns the same string instead of appending.
 */
function managedBlock(options = {}) {
	const capabilities = capabilitiesSection(options);
	return `${systemPromptStart}\n${[
		persistentRulesBlock(options),
		inlinedSkillsSection,
		scopeRules,
		controlPlaneSkill(),
		capabilities,
	]
		.filter((part) => part !== "")
		.join("\n\n")}\n${systemPromptEnd}`;
}

function replaceManaged(text, options = {}) {
	const start = text.indexOf(systemPromptStart);
	if (start < 0) return text;
	const end = text.indexOf(systemPromptEnd, start + systemPromptStart.length);
	if (end < 0) return text;
	return (
		text.slice(0, start) +
		managedBlock(options) +
		text.slice(end + systemPromptEnd.length)
	);
}

function injectIntoString(text, options = {}) {
	if (text.includes(systemPromptStart)) return replaceManaged(text, options);
	return `${managedBlock(options)}\n\n${text}`;
}

function injectIntoArray(prompt, options = {}) {
	const markerIndex = prompt.findIndex(
		(block) => typeof block === "string" && block.includes(systemPromptStart),
	);
	if (markerIndex >= 0) {
		const old = prompt[markerIndex];
		const next = replaceManaged(old, options);
		if (next === old) return prompt;
		const copy = prompt.slice();
		copy[markerIndex] = next;
		return copy;
	}
	return [managedBlock(options), ...prompt];
}

export function injectSystemPrompt(prompt, options = {}) {
	if (typeof prompt === "string") return injectIntoString(prompt, options);
	if (Array.isArray(prompt)) return injectIntoArray(prompt, options);
	return prompt;
}
