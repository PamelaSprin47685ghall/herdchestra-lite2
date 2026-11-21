// Prompt text and prompt injection. Text comes from resources/prompts/.

import {
	acceptanceCasesPrompt,
	architectureDesignPrompt,
	decisionFramingPrompt,
	orchestrationPlanPrompt,
} from "./stage-prompts.mjs";
import { loadDoc } from "../prompts/index.mjs";

const system = loadDoc("system");
const stages = loadDoc("stages");
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

export const stagePromptsStart = "<!-- herdchestra-lite2:stage-prompts v1 -->";
export const stagePromptsEnd = "<!-- /herdchestra-lite2:stage-prompts -->";

// The four stage sections live in the stable prefix so providers can reuse
// their prompt cache. direct-execution has no section.
export const stagePromptsBlock = [
	stagePromptsStart,
	stages.header,
	decisionFramingPrompt,
	acceptanceCasesPrompt,
	architectureDesignPrompt,
	orchestrationPlanPrompt,
	stagePromptsEnd,
].join("\n\n");

function stageBlock(options) {
	return options?.stages === "off" ? "" : stagePromptsBlock;
}

function managedBlock(options = {}) {
	const sections = [commonRulesText, persistentOperatingSkill];
	const block = stageBlock(options);
	if (block !== "") sections.push(block);
	return `${systemPromptStart}\n${sections.join("\n\n")}\n${systemPromptEnd}`;
}

function replaceManaged(text, options = {}) {
	const start = text.indexOf(systemPromptStart);
	if (start < 0) return text;
	const end = text.indexOf(systemPromptEnd, start + systemPromptStart.length);
	if (end < 0) return text;
	return text.slice(0, start) + managedBlock(options) + text.slice(end + systemPromptEnd.length);
}

function hasStagePrompts(text) {
	return typeof text === "string" && text.includes(stagePromptsStart);
}

function replaceStagePrompts(text, options = {}) {
	const start = text.indexOf(stagePromptsStart);
	if (start < 0) return text;
	const end = text.indexOf(stagePromptsEnd, start + stagePromptsStart.length);
	if (end < 0) return text;
	const replacement = stageBlock(options);
	if (replacement !== "") {
		return text.slice(0, start) + replacement + text.slice(end + stagePromptsEnd.length);
	}
	const before = text.slice(0, start).replace(/\n+$/, "");
	const after = text.slice(end + stagePromptsEnd.length).replace(/^\n+/, "");
	return after === "" ? before : `${before}\n\n${after}`;
}

function hasRules(text) {
	return typeof text === "string" && text.includes("# Repo-aware Rules");
}

function injectIntoString(text, options = {}) {
	if (text.includes(systemPromptStart)) return replaceManaged(text, options);
	if (hasRules(text)) {
		if (hasStagePrompts(text)) {
			return stageBlock(options) === "" ? replaceStagePrompts(text, options) : text;
		}
		const block = stageBlock(options);
		return block === "" ? text : `${block}\n\n${text}`;
	}
	return `${managedBlock(options)}\n\n${text}`;
}

function injectIntoArray(prompt, options = {}) {
	const off = stageBlock(options) === "";
	const markerIndex = prompt.findIndex(
		(block) => typeof block === "string" && block.includes(systemPromptStart),
	);
	if (markerIndex >= 0) {
		const old = prompt[markerIndex];
		const next = replaceManaged(old, options);
		const stageIndex = prompt.findIndex(
			(block) => typeof block === "string" && block.includes(stagePromptsStart),
		);
		if (next !== old) {
			const copy = [];
			for (let index = 0; index < prompt.length; index += 1) {
				if (index === markerIndex) copy.push(next);
				else if (off && index === stageIndex) continue;
				else if (index === stageIndex) copy.push(stagePromptsBlock);
				else copy.push(prompt[index]);
			}
			return copy;
		}
		if (stageIndex >= 0) {
			if (off) return prompt.filter((_, index) => index !== stageIndex);
			const oldStage = prompt[stageIndex];
			const nextStage = replaceStagePrompts(oldStage, options);
			if (nextStage === oldStage) return prompt;
			const copy = prompt.slice();
			copy[stageIndex] = nextStage;
			return copy;
		}
		if (off) return prompt;
		const copy = prompt.slice();
		copy.splice(markerIndex + 1, 0, stagePromptsBlock);
		return copy;
	}
	const stageIndex = prompt.findIndex(
		(block) => typeof block === "string" && hasStagePrompts(block),
	);
	if (prompt.some(hasRules)) {
		if (stageIndex >= 0) {
			if (off) return prompt.filter((_, index) => index !== stageIndex);
			const nextStage = replaceStagePrompts(prompt[stageIndex], options);
			if (nextStage === prompt[stageIndex]) return prompt;
			const copy = prompt.slice();
			copy[stageIndex] = nextStage;
			return copy;
		}
		if (off) return prompt;
		const copy = prompt.slice();
		copy.unshift(stagePromptsBlock);
		return copy;
	}
	return [managedBlock(options), ...prompt];
}

export function injectSystemPrompt(prompt, options = {}) {
	if (typeof prompt === "string") return injectIntoString(prompt, options);
	if (Array.isArray(prompt)) return injectIntoArray(prompt, options);
	return prompt;
}
