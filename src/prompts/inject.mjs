// Prompt text and prompt injection. Text comes from resources/prompts/.
//
// This module is pure: it reads resources and returns the next prompt. The
// host layer re-exports it so the Station can inject the managed block without
// depending on the host adapter.

import { loadDoc } from "./index.mjs";
import { inlinedSkillsSection } from "./skills.mjs";

const system = loadDoc("system");

const systemPromptStart = "<!-- herdchestra-lite2:system-prompt v1 -->";
const systemPromptEnd = "<!-- /herdchestra-lite2:system-prompt -->";

export const persistentOperatingSkill = system["persistent-rules"];

// The mode section is chosen per request, never cached into the session: the
// user may toggle autopilot mid-session, and the next request must see the new
// rules. Manual duty keeps the fork/join rules but none of the relay protocol.
const autopilotRules = system["autopilot-rules"];
const manualRules = system["manual-rules"];
const childRules = system["child-rules"];

function modeRulesBlock(options) {
	if (options?.branch === true) return childRules;
	return options?.autopilot === true ? autopilotRules : manualRules;
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

/**
 * Build the managed block: persistent rules, the inlined skill bodies, then
 * the mode-specific rules. The block is replaced between its markers on every
 * injection, so a second call returns the same bytes instead of appending.
 */
function managedBlock(options = {}) {
	const sections = [persistentRulesBlock(options), inlinedSkillsSection];
	const mode = modeRulesBlock(options);
	if (mode !== "") sections.push(mode);
	return `${systemPromptStart}\n${sections.join("\n\n")}\n${systemPromptEnd}`;
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
