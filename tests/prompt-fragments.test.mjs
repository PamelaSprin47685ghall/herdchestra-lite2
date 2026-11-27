import { expect, test } from "bun:test";

import { resolvePorts } from "../src/core/ports/resolve.mjs";
import {
	defaultFeatures,
	parseFeatureEnv,
} from "../src/features/herd/features.mjs";
import { injectSystemPrompt, persistentOperatingSkill } from "../src/prompts/inject.mjs";
import { rewriteVibeMessage } from "../src/transcript/tail.mjs";

function features(overrides = {}) {
	return { ...defaultFeatures(), ...overrides };
}

test("the chinese feature resolves from its canonical and legacy environment names", () => {
	const canonical = parseFeatureEnv({ HERD_CHINESE: "off" });
	expect(canonical.ok).toBe(true);
	expect(canonical.explicit.chinese).toBe("off");

	const legacy = parseFeatureEnv({ HERD_CHINESE_REMINDER: "off" });
	expect(legacy.ok).toBe(true);
	expect(legacy.explicit.chinese).toBe("off");

	const disabled = parseFeatureEnv({ HERD_DISABLE_CHINESE_REMINDER: "1" });
	expect(disabled.ok).toBe(true);
	expect(disabled.explicit.chinese).toBe("off");
});

test("the vibeCompat port still resolves from its environment name", () => {
	const vibeCompat = resolvePorts({}, { HERD_DISABLE_VIBE_COMPAT: "1" });
	expect(vibeCompat.ports.vibeCompat).toBe("off");
});

test("chinese off removes the language section and leaves the rest intact", () => {
	const prompt = injectSystemPrompt("plain prompt", { features: features({ chinese: "off" }) });
	expect(prompt).not.toContain("强制以简体中文思考");
	expect(prompt).not.toContain("Punish You Otherwise");
	expect(prompt).toContain("The one tool");
	expect(prompt).toContain("plain prompt");
	expect(persistentOperatingSkill).not.toContain("强制以简体中文思考");
});

test("chinese on includes the language section exactly once", () => {
	const prompt = injectSystemPrompt("plain prompt", { features: features({ chinese: "on" }) });
	expect(prompt).toContain("Punish You Otherwise");
	expect(prompt.split("强制以简体中文思考").length - 1).toBe(1);
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
	expect(rewritten.content).toBe("direct as many parallel slice/swarm workers as causality allows");
});
