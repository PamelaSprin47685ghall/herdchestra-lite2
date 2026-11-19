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

export const languageSkill = system["language-skill"];

export const outsideScopeInstruction = system["outside-scope"];

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

function managedBlock() {
	return `${systemPromptStart}\n${commonRulesText}\n\n${persistentOperatingSkill}\n\n${stagePromptsBlock}\n${systemPromptEnd}`;
}

function replaceManaged(text) {
	const start = text.indexOf(systemPromptStart);
	if (start < 0) return text;
	const end = text.indexOf(systemPromptEnd, start + systemPromptStart.length);
	if (end < 0) return text;
	return text.slice(0, start) + managedBlock() + text.slice(end + systemPromptEnd.length);
}

function hasStagePrompts(text) {
	return typeof text === "string" && text.includes(stagePromptsStart);
}

function replaceStagePrompts(text) {
	const start = text.indexOf(stagePromptsStart);
	if (start < 0) return text;
	const end = text.indexOf(stagePromptsEnd, start + stagePromptsStart.length);
	if (end < 0) return text;
	return text.slice(0, start) + stagePromptsBlock + text.slice(end + stagePromptsEnd.length);
}

function hasRules(text) {
	return typeof text === "string" && text.includes("# Repo-aware Rules");
}

function injectIntoString(text) {
	if (text.includes(systemPromptStart)) return replaceManaged(text);
	if (hasRules(text)) {
		if (hasStagePrompts(text)) return text;
		return `${stagePromptsBlock}\n\n${text}`;
	}
	return `${managedBlock()}\n\n${text}`;
}

function injectIntoArray(prompt) {
	const markerIndex = prompt.findIndex(
		(block) => typeof block === "string" && block.includes(systemPromptStart),
	);
	if (markerIndex >= 0) {
		const old = prompt[markerIndex];
		const next = replaceManaged(old);
		const stageIndex = prompt.findIndex(
			(block) => typeof block === "string" && block.includes(stagePromptsStart),
		);
		if (next !== old) {
			const copy = prompt.slice();
			copy[markerIndex] = next;
			if (stageIndex >= 0 && stageIndex !== markerIndex) copy[stageIndex] = stagePromptsBlock;
			return copy;
		}
		if (stageIndex >= 0) {
			const oldStage = prompt[stageIndex];
			const nextStage = replaceStagePrompts(oldStage);
			if (nextStage === oldStage) return prompt;
			const copy = prompt.slice();
			copy[stageIndex] = nextStage;
			return copy;
		}
		const copy = prompt.slice();
		copy.splice(markerIndex + 1, 0, stagePromptsBlock);
		return copy;
	}
	const stageIndex = prompt.findIndex(
		(block) => typeof block === "string" && hasStagePrompts(block),
	);
	if (prompt.some(hasRules)) {
		if (stageIndex >= 0) {
			const nextStage = replaceStagePrompts(prompt[stageIndex]);
			if (nextStage === prompt[stageIndex]) return prompt;
			const copy = prompt.slice();
			copy[stageIndex] = nextStage;
			return copy;
		}
		const copy = prompt.slice();
		copy.unshift(stagePromptsBlock);
		return copy;
	}
	return [managedBlock(), ...prompt];
}

export function injectSystemPrompt(prompt) {
	if (typeof prompt === "string") return injectIntoString(prompt);
	if (Array.isArray(prompt)) return injectIntoArray(prompt);
	return prompt;
}
