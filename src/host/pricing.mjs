// Model pricing catalog for the folding economics.
//
// loadPricingCatalog() is async and runs once at activation. Every other
// export is a pure synchronous query over an immutable, in-memory catalog.
// No network access and no writes after construction.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { sessionFor } from "./capture.mjs";
import { usageField, usageSnapshot } from "./usage.mjs";

// Fallback when no model configuration and no usage cost are available.
// The dimensionless ratio (pMiss = 10 * pHit) still drives the inequality.
const FALLBACK = Object.freeze({
	pHit: 1e-6,
	pMiss: 10e-6,
	contextWindow: null,
	knownPricing: false,
	label: "fallback",
});

const COST_KEYS = {
	input: ["input", "input_cost", "inputCost", "prompt"],
	output: ["output", "output_cost", "outputCost"],
	cacheRead: [
		"cacheRead",
		"cache_read",
		"cacheReadInputTokens",
		"cache_read_input_tokens",
	],
	cacheWrite: [
		"cacheWrite",
		"cache_write",
		"cacheCreationInputTokens",
		"cache_creation_input_tokens",
	],
};

/** Convert a character count into an estimated token count. */
export function charsToTokens(chars, tokensPerChar = 0.3) {
	const count = Number(chars);
	const rate =
		Number.isFinite(tokensPerChar) && tokensPerChar >= 0 ? tokensPerChar : 0.3;
	return Number.isFinite(count) && count > 0 ? count * rate : 0;
}

function asNonEmptyString(value) {
	return typeof value === "string" && value !== "" ? value : null;
}

function asPositiveNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: null;
}

function asNonNegativeNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;
}

function numOrZero(value) {
	return asNonNegativeNumber(value) ?? 0;
}

// Keep a cost field only when it is present. An absent cacheRead means "no
// cache", so pHit falls back to the full input price; a zero cacheRead means a
// genuinely free cache and must stay zero.
function normalizeCost(cost) {
	const out = {};
	if (!cost || typeof cost !== "object") return out;
	for (const [key, names] of Object.entries(COST_KEYS)) {
		for (const name of names) {
			const value = asNonNegativeNumber(cost[name]);
			if (value !== null) {
				out[key] = value;
				break;
			}
		}
	}
	return out;
}

function addEntry(target, provider, raw) {
	let entry = raw;
	if (typeof entry === "string") entry = { id: entry };
	if (!entry || typeof entry !== "object") return;
	const id = asNonEmptyString(entry.id ?? entry.modelId ?? entry.name);
	if (!id) return;
	const providerName = asNonEmptyString(entry.provider ?? provider) ?? "unknown";
	const fullId = id.includes("/") ? id : `${providerName}/${id}`;
	const model = Object.freeze({
		id,
		provider: providerName,
		fullId,
		label: asNonEmptyString(entry.label) ?? id,
		cost: Object.freeze(normalizeCost(entry.cost ?? entry.pricing)),
		contextWindow: asPositiveNumber(
			entry.contextWindow ?? entry.context_window,
		),
	});
	target.byFullId.set(fullId, model);
	target.byId.set(id, model);
}

function ingestProvider(target, provider, models) {
	if (Array.isArray(models)) {
		for (const model of models) addEntry(target, provider, model);
		return;
	}
	if (models && typeof models === "object") {
		for (const [id, model] of Object.entries(models)) {
			const value =
				model && typeof model === "object" && !Array.isArray(model) ? model : {};
			addEntry(target, provider, { ...value, id: value.id ?? id });
		}
	}
}

// Accept { providers: { p: { models: [...] | { id: {...} } } } } and a bare
// provider -> models map (the shape some built-in tables export).
function ingestModels(target, data) {
	if (!data || typeof data !== "object" || Array.isArray(data)) return;
	const providers = data.providers;
	if (providers && typeof providers === "object") {
		for (const [provider, config] of Object.entries(providers)) {
			if (!config || typeof config !== "object") continue;
			ingestProvider(target, provider, config.models ?? config);
		}
		return;
	}
	for (const [provider, config] of Object.entries(data)) {
		if (config && typeof config === "object" && !Array.isArray(config)) {
			ingestProvider(target, provider, config.models ?? config);
		}
	}
}

async function readJson(path) {
	try {
		const text = await readFile(path, "utf8");
		const data = JSON.parse(text);
		return data && typeof data === "object" ? data : null;
	} catch {
		return null;
	}
}

function entryFromCandidate(catalog, value, fallbackProvider, fallbackId) {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") {
		return catalog.byFullId.get(value) ?? catalog.byId.get(value) ?? null;
	}
	if (typeof value !== "object") return null;
	const hasConfig =
		value.cost !== undefined ||
		value.pricing !== undefined ||
		value.contextWindow !== undefined ||
		value.context_window !== undefined;
	const id = asNonEmptyString(value.id ?? value.modelId ?? value.name ?? fallbackId);
	const provider = asNonEmptyString(value.provider ?? fallbackProvider);
	if (hasConfig && id) {
		const fullId = id.includes("/") ? id : `${provider ?? "unknown"}/${id}`;
		return Object.freeze({
			id,
			provider: provider ?? "unknown",
			fullId,
			label: asNonEmptyString(value.label) ?? id,
			cost: Object.freeze(normalizeCost(value.cost ?? value.pricing)),
			contextWindow: asPositiveNumber(
				value.contextWindow ?? value.context_window,
			),
		});
	}
	if (id && provider) {
		const exact = catalog.byFullId.get(`${provider}/${id}`);
		if (exact) return exact;
	}
	if (id) {
		const byId = catalog.byId.get(id);
		if (byId) return byId;
	}
	const fullId = asNonEmptyString(value.fullId ?? value.key);
	if (fullId) {
		const exact = catalog.byFullId.get(fullId);
		if (exact) return exact;
	}
	return null;
}

function resolveModelFromCatalog(catalog, ctx, hint) {
	const data = hint && typeof hint === "object" ? hint : {};
	let session = null;
	try {
		session = sessionFor(ctx);
	} catch {
		session = null;
	}
	// Priority 1: a live model object on the context or captured session.
	const candidates = [
		ctx?.model,
		session?.model,
		session?.agent?.state?.model,
		data.model,
	];
	for (const candidate of candidates) {
		const found = entryFromCandidate(catalog, candidate);
		if (found) return found;
	}
	// Priority 2: provider/model id from the hint or the default model key.
	const key = asNonEmptyString(data.modelId ?? data.model) ?? catalog.defaultModelKey;
	const provider = asNonEmptyString(data.provider) ??
		(key && key.includes("/") ? key.slice(0, key.indexOf("/")) : null);
	const modelId = asNonEmptyString(data.modelId) ??
		(key && key.includes("/") ? key.slice(key.indexOf("/") + 1) : key);
	if (provider && modelId) {
		let registryModel = null;
		try {
			const found = ctx?.modelRegistry?.find?.(provider, modelId);
			if (found && typeof found === "object") registryModel = found;
		} catch {
			registryModel = null;
		}
		const fromRegistry = registryModel
			? entryFromCandidate(catalog, registryModel, provider, modelId)
			: null;
		if (fromRegistry) return fromRegistry;
		const exact = catalog.byFullId.get(`${provider}/${modelId}`);
		if (exact) return exact;
	}
	if (modelId) {
		const byId = catalog.byId.get(modelId);
		if (byId) return byId;
	}
	return null;
}

function policyFromCatalogEntry(entry) {
	const cost = entry.cost ?? {};
	const pHit = numOrZero(cost.cacheRead ?? cost.input) / 1e6;
	const writeSource =
		asPositiveNumber(cost.cacheWrite) !== null ? cost.cacheWrite : cost.input;
	const pMiss = numOrZero(writeSource) / 1e6;
	return {
		pHit,
		pMiss,
		contextWindow: asPositiveNumber(entry.contextWindow),
		knownPricing: true,
		label: entry.label ?? entry.id ?? "model",
	};
}

// Priority 3: derive per-token prices from an observed usage cost.
function policyFromUsage(usage) {
	if (!usage || typeof usage !== "object") return null;
	const snapshot = usageSnapshot(usage);
	const cost = usage.cost && typeof usage.cost === "object" ? usage.cost : null;
	if (!cost) return null;
	const readCost = usageField(cost, COST_KEYS.cacheRead);
	if (!(snapshot.cacheRead > 0) || asPositiveNumber(readCost) === null) return null;
	const pHit = readCost / snapshot.cacheRead;
	let pMiss = pHit;
	const writeCost = usageField(cost, COST_KEYS.cacheWrite);
	const inputCost = usageField(cost, COST_KEYS.input);
	if (snapshot.cacheWrite > 0 && asPositiveNumber(writeCost) !== null) {
		pMiss = writeCost / snapshot.cacheWrite;
	} else if (snapshot.input > 0 && asPositiveNumber(inputCost) !== null) {
		pMiss = inputCost / snapshot.input;
	}
	return {
		pHit,
		pMiss,
		contextWindow: null,
		knownPricing: true,
		label: "usage-derived",
	};
}

/** Pure synchronous pricing query. Never throws. */
export function resolveModelPolicy(catalog, ctx, hint) {
	try {
		const entry = catalog?.resolveModel?.(ctx, hint) ?? null;
		if (entry && typeof entry === "object") return policyFromCatalogEntry(entry);
		const data = hint && typeof hint === "object" ? hint : {};
		return policyFromUsage(data.usage ?? data.lastUsage) ?? { ...FALLBACK };
	} catch {
		return { ...FALLBACK };
	}
}

function freezeCatalog(byFullId, byId, defaultModelKey) {
	const catalog = {
		byFullId,
		byId,
		defaultModelKey,
		resolveModel(ctx, hint) {
			return resolveModelFromCatalog(catalog, ctx, hint);
		},
	};
	Object.freeze(byFullId);
	Object.freeze(byId);
	return Object.freeze(catalog);
}

export function createEmptyCatalog() {
	return freezeCatalog(new Map(), new Map(), null);
}

/** Async asset loading. Runs once during activation, never on a hot path. */
export async function loadPricingCatalog() {
	const byFullId = new Map();
	const byId = new Map();
	const target = { byFullId, byId };

	// Built-in model table is best effort: test hosts may not ship the package.
	try {
		const builtin = await import("@oh-my-pi/pi-ai");
		const sources = [
			builtin?.models,
			builtin?.defaultModels,
			builtin?.MODELS,
			builtin?.modelsTable,
			builtin?.default,
		];
		for (const source of sources) ingestModels(target, source);
		if (builtin && typeof builtin === "object") {
			for (const value of Object.values(builtin)) ingestModels(target, value);
		}
	} catch {
		// No built-in table available.
	}

	const roots = [
		process.env?.OMP_CODING_AGENT_DIR || join(homedir(), ".omp", "agent"),
		process.env?.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
	];
	let defaultModelKey = null;
	for (const root of roots) {
		const models = await readJson(join(root, "models.json"));
		if (models) ingestModels(target, models);
		const settings = await readJson(join(root, "settings.json"));
		const key = asNonEmptyString(settings?.defaultModel ?? settings?.model);
		if (!defaultModelKey && key) defaultModelKey = key;
	}
	if (!defaultModelKey) defaultModelKey = asNonEmptyString(process.env?.OMP_DEFAULT_MODEL);

	return freezeCatalog(byFullId, byId, defaultModelKey);
}
