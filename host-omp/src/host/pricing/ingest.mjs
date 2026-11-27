// Catalog ingestion: the one place a model table becomes catalog entries.
//
// This is the leaf of the pricing trio. It reads environment files and the
// built-in table once, at activation, and it owns every normalizer that turns a
// raw provider row into a frozen entry. `policy.mjs` prices an entry and
// `parse.mjs` resolves a user spec, and both import from here, so the arrow
// points one way: ingest <- policy <- parse.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** A non-empty string, or null. */
export function asNonEmptyString(value) {
	return typeof value === "string" && value !== "" ? value : null;
}

/** A finite number greater than zero, or null. */
export function asPositiveNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: null;
}

/** A finite number at least zero, or null. */
export function asNonNegativeNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;
}

/** A property read that treats a throwing getter as an absent property. */
export function safeProperty(target, key) {
	try {
		return target?.[key];
	} catch {
		return undefined;
	}
}

/** The first defined value among the accepted setting names. */
export function settingValue(source, names) {
	if (!source || typeof source !== "object") return undefined;
	if (typeof source.get === "function") {
		for (const name of names) {
			try {
				const value = source.get(name);
				if (value !== undefined) return value;
			} catch {
				// Try the next accepted key.
			}
		}
	}
	if (source instanceof Map) {
		for (const name of names) {
			if (source.has(name)) return source.get(name);
		}
	}
	for (const name of names) {
		const value = safeProperty(source, name);
		if (value !== undefined) return value;
	}
	return undefined;
}

/**
 * Add model aliases or roles from one settings value into `target`.
 *
 * A bare string or number names the model directly; an object is read from its
 * `model`, `spec`, or `target` field. The key is lowercased because a user may
 * type `Opus` and the host resolves `opus`.
 */
export function addConfiguredEntries(target, value) {
	if (!value) return;
	const entries = value instanceof Map ? value.entries() : Object.entries(value);
	for (const [key, entry] of entries) {
		if (typeof key !== "string" || entry === null || entry === undefined) continue;
		const spec =
			typeof entry === "string" || typeof entry === "number"
				? String(entry)
				: safeProperty(entry, "model") ??
					safeProperty(entry, "spec") ??
					safeProperty(entry, "target");
		if (typeof spec === "string" && spec !== "") {
			target.set(key.trim().toLowerCase(), spec.trim());
		}
	}
}

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

/**
 * Keep a cost field only when it is present. An absent cacheRead means "no
 * cache", so pHit falls back to the full input price; a zero cacheRead means a
 * genuinely free cache and must stay zero.
 */
export function normalizeCost(cost) {
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

/**
 * Accept { providers: { p: { models: [...] | { id: {...} } } } } and a bare
 * provider -> models map (the shape some built-in tables export).
 */
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

/**
 * Read one YAML config file when the runtime offers a parser. Bun ships
 * `Bun.YAML`; other runtimes fall back to the JSON sources.
 */
async function readYamlConfig(path) {
	try {
		const text = await readFile(path, "utf8");
		const parse = globalThis.Bun?.YAML?.parse;
		return typeof parse === "function" ? parse(text) : null;
	} catch {
		return null;
	}
}

function freezeCatalog(byFullId, byId, defaultModelKey, modelRoles = new Map(), modelAliases = new Map()) {
	const catalog = {
		byFullId,
		byId,
		defaultModelKey,
		modelRoles,
		modelAliases,
	};
	Object.freeze(byFullId);
	Object.freeze(byId);
	return Object.freeze(catalog);
}

/** The catalog before any source is read. */
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
	const modelRoles = new Map();
	const modelAliases = new Map();
	for (const root of roots.reverse()) {
		const models = await readJson(join(root, "models.json"));
		if (models) ingestModels(target, models);
		const settings = await readJson(join(root, "settings.json"));
		const config =
			(await readYamlConfig(join(root, "config.yml"))) ??
			(await readYamlConfig(join(root, "config.yaml")));
		// Roles take priority over every model match: `task`, `default`, and
		// the other role names belong to the host configuration.
		addConfiguredEntries(modelRoles, config?.modelRoles ?? settings?.modelRoles);
		addConfiguredEntries(
			modelAliases,
			config?.modelAliases ??
				config?.aliases ??
				settings?.modelAliases ??
				settings?.aliases,
		);
		const key = asNonEmptyString(
			settings?.defaultModel ?? config?.defaultModel ?? settings?.model,
		);
		if (key) defaultModelKey = key;
	}
	if (!defaultModelKey) defaultModelKey = asNonEmptyString(process.env?.OMP_DEFAULT_MODEL);

	return freezeCatalog(byFullId, byId, defaultModelKey, modelRoles, modelAliases);
}
