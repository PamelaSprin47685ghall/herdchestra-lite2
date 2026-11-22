// Prompt text and prompt injection. Text comes from resources/prompts/.
//
// Inject operating rules. Load stage skills separately from skills/.

import { loadDoc } from "../prompts/index.mjs";

const system = loadDoc("system");
const vibe = loadDoc("vibe-mode");

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
// rest of the skill text stays byte-identical.
const CHINESE_REMINDER_PREFIX = "- 强制以简体中文思考";

function persistentRulesBlock(options) {
	if (options?.chineseReminder !== "off") return persistentOperatingSkill;
	return persistentOperatingSkill
		.split("\n")
		.filter((line) => !line.startsWith(CHINESE_REMINDER_PREFIX))
		.join("\n");
}

/** Build the managed block: persistent rules, then the mode-specific rules. */
function managedBlock(options = {}) {
	const sections = [persistentRulesBlock(options)];
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
