import { expect, test } from "bun:test";

import { resolvePorts } from "../src/core/ports/resolve.mjs";
import { injectSystemPrompt, persistentOperatingSkill } from "../src/host/prompts.mjs";
import { rewriteVibeMessage } from "../src/transcript/tail.mjs";

test("each prompt-fragment switch resolves from its environment name", () => {
	const chineseReminder = resolvePorts({}, { HERD_DISABLE_CHINESE_REMINDER: "1" });
	const vibeCompat = resolvePorts({}, { HERD_DISABLE_VIBE_COMPAT: "1" });
	expect(chineseReminder.ports.chineseReminder).toBe("off");
	expect(vibeCompat.ports.vibeCompat).toBe("off");
});

test("chineseReminder off removes only the reminder line", () => {
	const prompt = injectSystemPrompt("plain prompt", { chineseReminder: "off" });
	expect(prompt).not.toContain("强制以简体中文思考");
	expect(prompt).toContain("Persistent operating rules");
	expect(persistentOperatingSkill).toContain("强制以简体中文思考");
});

test("chineseReminder on keeps the shipped skill text byte for byte", () => {
	const prompt = injectSystemPrompt("plain prompt", { chineseReminder: "on" });
	expect(prompt).toContain(persistentOperatingSkill);
});

test("vibeCompat off leaves the message untouched", () => {
	const message = {
		role: "custom",
		customType: "vibe-mode-context",
		content: "drive two worker CLIs",
	};
	expect(rewriteVibeMessage(message, { vibeCompat: "off" })).toBe(message);
});

test("vibeCompat on rewrites the two shipped lines", () => {
	const message = {
		role: "custom",
		customType: "vibe-mode-context",
		content: "drive two worker CLIs",
	};
	const rewritten = rewriteVibeMessage(message, { vibeCompat: "on" });
	expect(rewritten.content).toBe(
		"direct as many parallel slice/swarm workers as causality allows",
	);
});
