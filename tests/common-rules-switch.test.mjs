import { expect, test } from "bun:test";

import { resolvePorts } from "../src/core/ports/resolve.mjs";
import { commonRulesText, injectSystemPrompt } from "../src/host/prompts.mjs";

test("HERD_DISABLE_COMMON_RULES=1 resolves the commonRules port to off", () => {
	const resolved = resolvePorts({}, { HERD_DISABLE_COMMON_RULES: "1" });
	expect(resolved.ok).toBe(true);
	expect(resolved.ports.commonRules).toBe("off");
});

test("the default keeps the repo-aware rules", () => {
	const resolved = resolvePorts({}, {});
	expect(resolved.ok).toBe(true);
	expect(resolved.ports.commonRules).toBe("on");
	const prompt = injectSystemPrompt("plain prompt", resolved.ports);
	expect(prompt).toContain(commonRulesText);
});

test("commonRules off omits the repo-aware block and keeps the rest", () => {
	const off = injectSystemPrompt("plain prompt", { commonRules: "off" });
	expect(off).not.toContain("# Repo-aware Rules");
	expect(off).toContain("Persistent operating rules");
	expect(off).toContain("plain prompt");

	const on = injectSystemPrompt("plain prompt", { commonRules: "on" });
	expect(on).toContain("# Repo-aware Rules");
});

test("commonRules switches off without touching the persistent rules", () => {
	const on = injectSystemPrompt("plain prompt", { commonRules: "on" });
	const off = injectSystemPrompt(on, { commonRules: "off" });
	expect(off).not.toContain("# Repo-aware Rules");
	expect(off).toContain("herdchestra-lite2:system-prompt");
	expect(off).toContain("plain prompt");
});
