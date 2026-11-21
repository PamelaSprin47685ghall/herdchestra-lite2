import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	charsToTokens,
	createEmptyCatalog,
	loadPricingCatalog,
	resolveModelPolicy,
} from "../src/host/index.mjs";

const savedEnv = {
	OMP_CODING_AGENT_DIR: process.env.OMP_CODING_AGENT_DIR,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	OMP_DEFAULT_MODEL: process.env.OMP_DEFAULT_MODEL,
};

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function writeCatalog(dir, models, settings) {
	writeFileSync(join(dir, "models.json"), JSON.stringify(models));
	writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
	return dir;
}

describe("charsToTokens", () => {
	test("scales characters by a default density", () => {
		expect(charsToTokens(100)).toBeCloseTo(30);
		expect(charsToTokens(100, 0.5)).toBe(50);
	});

	test("returns zero for non-positive or junk input", () => {
		expect(charsToTokens(0)).toBe(0);
		expect(charsToTokens(-4)).toBe(0);
		expect(charsToTokens("junk")).toBe(0);
		expect(charsToTokens(100, -1)).toBeCloseTo(30);
	});
});

describe("resolveModelPolicy", () => {
	test("fallback when no config and no usage cost", () => {
		const policy = resolveModelPolicy(createEmptyCatalog(), {}, {});
		expect(policy).toEqual({
			pHit: 1e-6,
			pMiss: 10e-6,
			pOut: 50e-6,
			contextWindow: null,
			knownPricing: false,
			label: "fallback",
		});
	});

	test("Anthropic pricing: cacheWrite > input > cacheRead", () => {
		const policy = resolveModelPolicy(createEmptyCatalog(), {
			model: {
				id: "claude-sonnet-4-5",
				provider: "anthropic",
				contextWindow: 200000,
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			},
		}, {});
		expect(policy.pHit).toBeCloseTo(0.3e-6);
		expect(policy.pMiss).toBeCloseTo(3.75e-6);
		expect(policy.pOut).toBeCloseTo(15e-6);
		expect(policy.contextWindow).toBe(200000);
		expect(policy.knownPricing).toBe(true);
	});

	test("no-cache model: pHit equals pMiss at the input price", () => {
		const policy = resolveModelPolicy(createEmptyCatalog(), {
			model: { id: "gpt-no-cache", cost: { input: 1, output: 2 } },
		}, {});
		expect(policy.pHit).toBeCloseTo(1e-6);
		expect(policy.pMiss).toBeCloseTo(1e-6);
		expect(policy.knownPricing).toBe(true);
	});

	test("free local model: prices are zero but pricing is known", () => {
		const policy = resolveModelPolicy(createEmptyCatalog(), {
			model: { id: "free-local", cost: { input: 0, cacheRead: 0, cacheWrite: 0 } },
		}, {});
		expect(policy.pHit).toBe(0);
		expect(policy.pMiss).toBe(0);
		expect(policy.knownPricing).toBe(true);
	});

	test("derives unit prices from usage cost when no model config", () => {
		const policy = resolveModelPolicy(createEmptyCatalog(), {}, {
			usage: {
				input: 100,
				cacheRead: 200,
				cacheWrite: 50,
				output: 10,
				cost: { cacheRead: 0.02, cacheWrite: 0.01, input: 0.01, output: 0.02 },
			},
		});
		expect(policy.knownPricing).toBe(true);
		expect(policy.pHit).toBeCloseTo(0.02 / 200);
		expect(policy.pMiss).toBeCloseTo(0.01 / 50);
		expect(policy.pOut).toBeCloseTo(0.02 / 10);
		expect(policy.contextWindow).toBeNull();
		expect(policy.label).toBe("usage-derived");
	});

	test("uses modelRegistry.find when it returns synchronously", () => {
		const policy = resolveModelPolicy(createEmptyCatalog(), {
			modelRegistry: {
				find(provider, modelId) {
					if (provider !== "acme" || modelId !== "m1") return undefined;
					return { id: "m1", cost: { input: 2, cacheRead: 0.5 } };
				},
			},
		}, { provider: "acme", modelId: "m1" });
		expect(policy.pHit).toBeCloseTo(0.5e-6);
		expect(policy.pMiss).toBeCloseTo(2e-6);
	});
});

describe("loadPricingCatalog", () => {
	test("reads an array-style models.json and the default model", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pricing-"));
		writeCatalog(
			dir,
			{
				providers: {
					anthropic: {
						models: [
							{
								id: "claude-x",
								contextWindow: 100000,
								cost: { input: 3, cacheRead: 0.3, cacheWrite: 3.75 },
							},
						],
					},
				},
			},
			{ defaultModel: "anthropic/claude-x" },
		);
		process.env.OMP_CODING_AGENT_DIR = dir;
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pricing-empty-"));
		try {
			const catalog = await loadPricingCatalog();
			expect(catalog.defaultModelKey).toBe("anthropic/claude-x");
			expect(catalog.byFullId.has("anthropic/claude-x")).toBe(true);
			const policy = resolveModelPolicy(catalog, {}, {});
			expect(policy.pHit).toBeCloseTo(0.3e-6);
			expect(policy.contextWindow).toBe(100000);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reads an object-style models.json by id", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pricing-"));
		writeCatalog(
			dir,
			{
				providers: {
					openai: {
						models: {
							"gpt-y": { contextWindow: 128000, cost: { input: 2 } },
						},
					},
				},
			},
			{ model: "gpt-y" },
		);
		process.env.OMP_CODING_AGENT_DIR = dir;
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pricing-empty-"));
		try {
			const catalog = await loadPricingCatalog();
			expect(catalog.byFullId.has("openai/gpt-y")).toBe(true);
			const policy = resolveModelPolicy(catalog, {}, {});
			expect(policy.pHit).toBeCloseTo(2e-6);
			expect(policy.pMiss).toBeCloseTo(2e-6);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("silently tolerates a missing catalog", async () => {
		process.env.OMP_CODING_AGENT_DIR = join(tmpdir(), "does-not-exist-xyz");
		process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "does-not-exist-abc");
		const catalog = await loadPricingCatalog();
		expect(catalog.defaultModelKey).toBeNull();
		expect(catalog.byFullId.size).toBeGreaterThanOrEqual(0);
	});

	test.skipIf(typeof globalThis.Bun?.YAML?.parse !== "function")(
		"reads model roles from the host config.yml",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "pricing-"));
			writeFileSync(
				join(dir, "config.yml"),
				"modelRoles:\n  task: fixture/qwen:medium\n",
			);
			process.env.OMP_CODING_AGENT_DIR = dir;
			process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pricing-empty-"));
			try {
				const catalog = await loadPricingCatalog();
				expect(catalog.modelRoles.get("task")).toBe("fixture/qwen:medium");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});
test("scope preparse keeps exact colon IDs and resolves role thinking suffixes", async () => {
	const { createEmptyCatalog, preparseModelSpec } = await import("../src/host/pricing.mjs");
	const first = { provider: "fixture", id: "qwen:high", contextWindow: 12_000, cost: { input: 2, cacheRead: 0.2 } };
	const second = { provider: "fixture", id: "qwen", contextWindow: 50_000, cost: { input: 3, cacheRead: 0.3 } };
	const ctx = { settings: { modelRoles: { fast: "fixture/qwen" } }, modelRegistry: {
		getAll: () => [first, second],
		find: (provider, id) => [first, second].find((model) => model.provider === provider && model.id === id),
	} };
	const catalog = createEmptyCatalog();
	const exact = preparseModelSpec(catalog, ctx, "fixture/qwen:high");
	expect(exact.canonicalKey).toBe("fixture/qwen:high");
	expect(exact.contextWindow).toBe(12_000);
	expect(exact.pricing.pHit).toBeCloseTo(0.2e-6, 12);
	const role = preparseModelSpec(catalog, ctx, "@fast:low");
	expect(role.canonicalKey).toBe("fixture/qwen");
	expect(role.contextWindow).toBe(50_000);
});

test("scope preparse prefers roles over fuzzy model matches", async () => {
	const { createEmptyCatalog, preparseModelSpec } = await import("../src/host/pricing.mjs");
	const target = { provider: "fixture", id: "qwen", contextWindow: 50_000, cost: { input: 3 } };
	const competitor = { provider: "gateway", id: "lazy/task", contextWindow: 1_000_000 };
	const models = [target, competitor];
	const modelRegistry = {
		getAll: () => models,
		find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
	};
	const catalog = createEmptyCatalog();
	const role = preparseModelSpec(
		catalog,
		{ settings: { modelRoles: { task: "fixture/qwen:medium" } }, modelRegistry },
		"task",
	);
	expect(role.canonicalKey).toBe("fixture/qwen");
	expect(role.thinkingLevel).toBe("medium");
	expect(role.exact).toBe(true);
	const fuzzy = preparseModelSpec(catalog, { modelRegistry }, "task");
	expect(fuzzy.canonicalKey).toBe("lazy/task");
	expect(fuzzy.exact).toBe(false);
});
