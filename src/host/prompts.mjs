// Prompt text and prompt injection. Text comes from resources/prompts/.
//
// Inject operating rules. Load stage skills separately from skills/.

import { loadDoc } from "../prompts/index.mjs";

const system = loadDoc("system");
const vibe = loadDoc("vibe-mode");

export const commonRulesText = system["common-rules"];

const vibeModeReplacements = [
	{
		from: "drive two worker CLIs",
		to: vibe.workers,
	},
	{
		from: "Run sessions concurrently — normally one `fast` and one `good` on different workstreams.",
		to: vibe.concurrent,
	},
];

export function rewriteVibeModeContext(content) {
	if (typeof content !== "string") return content;
	let text = content;
	for (const { from, to } of vibeModeReplacements) {
		text = text.split(from).join(to);
	}
	return text;
}

const systemPromptStart = "<!-- herdchestra-lite2:system-prompt v1 -->";
const systemPromptEnd = "<!-- /herdchestra-lite2:system-prompt -->";

export const persistentOperatingSkill = system["persistent-rules"];

// The repo-aware rules are one switchable block, not a fixed prefix: the
// commonRules port decides whether it is assembled at all. Everything else in
// the managed block stays, so turning it off removes only that section.
function commonRulesBlock(options) {
	return options?.commonRules === "off" ? "" : commonRulesText;
}

// The Simplified-Chinese reminder is one line inside the persistent rules.
// Turning `chineseReminder` off removes that line and nothing else, so the
// rest of the skill text stays byte-identical.
const CHINESE_REMINDER_PREFIX = "- 强制以简体中文思考";

function persistentRulesBlock(options) {
	if (options?.chineseReminder !== "off") return persistentOperatingSkill;
	return persistentOperatingSkill
		.split("\n")
		.filter((line) => !line.startsWith(CHINESE_REMINDER_PREFIX))
		.join("\n");
}

/**
 * Build the managed block. `includeCommon` is false when the host prompt
 * already carries the repo-aware rules from AGENTS.md: the section is the same
 * text, and shipping it twice only spends context.
 */
function managedBlock(options = {}, includeCommon = true) {
	const sections = [];
	if (includeCommon) {
		const rules = commonRulesBlock(options);
		if (rules !== "") sections.push(rules);
	}
	sections.push(persistentRulesBlock(options));
	return `${systemPromptStart}\n${sections.join("\n\n")}\n${systemPromptEnd}`;
}

function hasRules(text) {
	return typeof text === "string" && text.includes("# Repo-aware Rules");
}

function replaceManaged(text, options = {}, includeCommon = true) {
	const start = text.indexOf(systemPromptStart);
	if (start < 0) return text;
	const end = text.indexOf(systemPromptEnd, start + systemPromptStart.length);
	if (end < 0) return text;
	return (
		text.slice(0, start) +
		managedBlock(options, includeCommon) +
		text.slice(end + systemPromptEnd.length)
	);
}

function outside(text) {
	const start = text.indexOf(systemPromptStart);
	if (start < 0) return text;
	const end = text.indexOf(systemPromptEnd, start + systemPromptStart.length);
	if (end < 0) return text;
	return text.slice(0, start) + text.slice(end + systemPromptEnd.length);
}

function injectIntoString(text, options = {}) {
	if (text.includes(systemPromptStart)) {
		return replaceManaged(text, options, !hasRules(outside(text)));
	}
	return `${managedBlock(options, !hasRules(text))}\n\n${text}`;
}

function injectIntoArray(prompt, options = {}) {
	const markerIndex = prompt.findIndex(
		(block) => typeof block === "string" && block.includes(systemPromptStart),
	);
	if (markerIndex >= 0) {
		const old = prompt[markerIndex];
		const includeCommon = !hasRules(outside(old)) &&
			!prompt.some((block, index) => index !== markerIndex && hasRules(block));
		const next = replaceManaged(old, options, includeCommon);
		if (next === old) return prompt;
		const copy = prompt.slice();
		copy[markerIndex] = next;
		return copy;
	}
	const includeCommon = !prompt.some(hasRules);
	return [managedBlock(options, includeCommon), ...prompt];
}

export function injectSystemPrompt(prompt, options = {}) {
	if (typeof prompt === "string") return injectIntoString(prompt, options);
	if (Array.isArray(prompt)) return injectIntoArray(prompt, options);
	return prompt;
}
