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

const THINKING_SUFFIX =
	/(?:\s*[:@]\s*|\s+)(off|minimal|low|medium|high|xhigh)\s*$/i;

function splitThinkingSuffix(text) {
	const match = THINKING_SUFFIX.exec(text);
	if (!match) return { model: text, thinking: null };
	return {
		model: text.slice(0, match.index).trim(),
		thinking: match[1].toLowerCase(),
	};
}

function safeProperty(target, key) {
	try {
		return target?.[key];
	} catch {
		return undefined;
	}
}

function settingValue(source, names) {
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

function addConfiguredEntries(target, value) {
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

function configuredMaps(ctx, catalog) {
	let session = null;
	try {
		session = sessionFor(ctx);
	} catch {
		session = null;
	}
	const sources = [
		ctx?.settings,
		session?.settings,
		ctx?.session?.settings,
		ctx?.sessionManager?.settings,
	];
	const aliases = new Map(catalog?.modelAliases);
	const roles = new Map(catalog?.modelRoles);
	for (const source of sources) {
		addConfiguredEntries(
			aliases,
			settingValue(source, ["aliases", "modelAliases", "model_aliases"]),
		);
		addConfiguredEntries(
			roles,
			settingValue(source, ["modelRoles", "model_roles", "roles"]),
		);
	}
	return { aliases, roles };
}

function lookupConfigured(map, key) {
	return map.get(key.trim().toLowerCase());
}

function resolveConfiguredSpec(ctx, catalog, text) {
	const { aliases, roles } = configuredMaps(ctx, catalog);
	let current = text.trim();
	let thinking = null;
	const seen = new Set();
	for (let depth = 0; depth < 8; depth += 1) {
		if (!current) return { model: "", thinking };
		const key = current.toLowerCase();
		if (seen.has(key)) break;
		seen.add(key);
		const name = current.replace(/^@/, "");
		const next = lookupConfigured(aliases, name) ?? lookupConfigured(roles, name);
		if (next !== undefined) {
			current = next;
			continue;
		}
		const exact = resolveModelEntry(ctx, catalog, current, true);
		if (exact) return { model: current, thinking, entry: exact };
		const parts = splitThinkingSuffix(current);
		if (!parts.thinking) break;
		thinking ??= parts.thinking;
		current = parts.model;
	}
	return { model: current, thinking };
}

function registryFor(ctx) {
	let session = null;
	try {
		session = sessionFor(ctx);
	} catch {
		session = null;
	}
	const candidates = [
		ctx?.modelRegistry,
		session?.modelRegistry,
		ctx?.session?.modelRegistry,
	];
	for (const candidate of candidates) {
		if (
			candidate &&
			(typeof candidate.find === "function" ||
				typeof candidate.getAll === "function")
		) {
			return candidate;
		}
	}
	return null;
}

function registryAll(registry) {
	if (!registry) return [];
	let all = null;
	if (typeof registry.getAll === "function") {
		try {
			all = registry.getAll();
		} catch {
			all = null;
		}
	} else if (Array.isArray(registry.models)) {
		all = registry.models;
	} else if (registry.models && typeof registry.models === "object") {
		all = Object.values(registry.models);
	}
	if (!all || typeof all.then === "function") return [];
	return Array.isArray(all) ? all : Object.values(all);
}

function registryFind(registry, provider, id) {
	if (!registry || typeof registry.find !== "function" || !provider) return null;
	try {
		const found = registry.find(provider, id);
		return found && typeof found.then !== "function" ? found : null;
	} catch {
		return null;
	}
}

function registryEntry(value, providerHint, idHint) {
	if (typeof value === "string") {
		const id = value.trim();
		if (!id) return null;
		return Object.freeze({
			id,
			provider: providerHint ?? "unknown",
			fullId: id.includes("/") ? id : `${providerHint ?? "unknown"}/${id}`,
			label: id,
			cost: Object.freeze({}),
			contextWindow: null,
		});
	}
	if (!value || typeof value !== "object") return null;
	const rawId = asNonEmptyString(
		value.id ?? value.modelId ?? value.name ?? value.key ?? idHint,
	);
	const provider = asNonEmptyString(value.provider ?? providerHint);
	const fullId =
		asNonEmptyString(value.fullId ?? value.full_id ?? value.key) ??
		(rawId?.includes("/")
			? rawId
			: provider && rawId
				? `${provider}/${rawId}`
				: rawId);
	const id =
		asNonEmptyString(value.id ?? value.modelId ?? value.name) ??
		(fullId?.includes("/") ? fullId.slice(fullId.indexOf("/") + 1) : fullId);
	if (!id && !fullId) return null;
	const finalId = id ?? fullId;
	const finalFullId = fullId ?? (provider ? `${provider}/${finalId}` : finalId);
	return Object.freeze({
		id: finalId,
		provider: provider ?? "unknown",
		fullId: finalFullId,
		label: asNonEmptyString(value.label ?? value.name) ?? finalId,
		cost: Object.freeze(normalizeCost(value.cost ?? value.pricing ?? value)),
		contextWindow: asPositiveNumber(
			value.contextWindow ?? value.context_window ?? value.maxContextTokens,
		),
	});
}

function splitProviderId(text) {
	const index = text.indexOf("/");
	if (index <= 0 || index === text.length - 1) return { provider: null, id: text };
	return { provider: text.slice(0, index), id: text.slice(index + 1) };
}

function normalized(value) {
	return String(value ?? "").trim().toLowerCase();
}

function exactEntry(entry, text) {
	const target = normalized(text);
	return normalized(entry?.fullId) === target || normalized(entry?.id) === target;
}

function substringEntry(entry, text) {
	const target = normalized(text);
	if (!target) return false;
	return [entry?.fullId, entry?.id, entry?.label].some(
		(value) => value && normalized(value).includes(target),
	);
}

function mapGetCI(map, key) {
	if (!map || typeof map.get !== "function") return null;
	const direct = map.get(key) ?? map.get(key.toLowerCase());
	if (direct) return direct;
	const target = normalized(key);
	for (const [candidate, value] of map.entries()) {
		if (normalized(candidate) === target) return value;
	}
	return null;
}

function catalogExact(catalog, text) {
	if (!catalog) return null;
	const direct =
		mapGetCI(catalog.byFullId, text) ?? mapGetCI(catalog.byId, text);
	if (direct) return direct;
	const { provider, id } = splitProviderId(text);
	if (provider) {
		return mapGetCI(catalog.byFullId, `${provider}/${id}`);
	}
	return mapGetCI(catalog.byId, id);
}

function catalogEntries(catalog) {
	if (!catalog) return [];
	if (catalog.byFullId && catalog.byFullId.size > 0) {
		return [...catalog.byFullId.values()];
	}
	if (catalog.byId && catalog.byId.size > 0) {
		return [...catalog.byId.values()];
	}
	return [];
}

function resolveModelEntry(ctx, catalog, modelText, exactOnly = false) {
	const registry = registryFor(ctx);
	const { provider, id } = splitProviderId(modelText);

	const found = registryEntry(
		registryFind(registry, provider, id),
		provider,
		id,
	);
	if (found) return found;

	const registryEntries = registryAll(registry)
		.map((value) => registryEntry(value, provider, id))
		.filter(Boolean);
	const registryExact = registryEntries.filter((entry) =>
		exactEntry(entry, modelText),
	);
	if (registryExact.length > 0) return registryExact[0];

	const catalogHit = catalogExact(catalog, modelText);
	if (catalogHit) return catalogHit;
	if (exactOnly) return null;

	const registrySubstring = registryEntries.filter((entry) =>
		substringEntry(entry, modelText),
	);
	if (registrySubstring.length === 1) return registrySubstring[0];

	const catalogSubstring = catalogEntries(catalog).filter((entry) =>
		substringEntry(entry, modelText),
	);
	if (catalogSubstring.length === 1) return catalogSubstring[0];
	return null;
}

/**
 * Synchronous model-spec preparse for host `/model`-style commands.
 *
 * Resolves settings aliases/roles, strips a trailing thinking suffix
 * (`:off`, `:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, or the same after
 * `@`/whitespace), then tries the live model registry before the pricing
 * catalog. Unknown specs stay unrecognized so the host can apply its own
 * fuzzy resolution.
 */
export function preparseModelSpec(catalog, ctx, rawSpec) {
	const raw = typeof rawSpec === "string" ? rawSpec : String(rawSpec ?? "");
	const unresolved = {
		rawSpec: raw,
		canonicalKey: "",
		pricing: null,
		contextWindow: null,
		recognized: false,
		exact: false,
	};
	const resolved = resolveConfiguredSpec(ctx, catalog, raw.trim());
	const modelText = resolved.model.trim();
	if (!modelText) return unresolved;
	// A configured role or alias names one concrete model. A guessed
	// substring match only estimates size and price; it never becomes the
	// model that a later verification expects.
	const exactEntry =
		resolved.entry ?? resolveModelEntry(ctx, catalog, modelText, true);
	const entry = exactEntry ?? resolveModelEntry(ctx, catalog, modelText);
	if (!entry) {
		return { ...unresolved, canonicalKey: modelText };
	}
	const fromCatalog = catalogExact(catalog, entry.fullId ?? modelText);
	const contextWindow = asPositiveNumber(entry.contextWindow ?? fromCatalog?.contextWindow);
	const cost = { ...fromCatalog?.cost, ...entry.cost };
	return {
		rawSpec: raw,
		canonicalKey: entry.fullId ?? entry.id ?? modelText,
		pricing: Object.keys(cost).length ? policyFromCatalogEntry({ ...entry, cost, contextWindow }) : null,
		contextWindow,
		recognized: true,
		exact: Boolean(exactEntry),
		thinkingLevel: resolved.thinking,
	};
}

function freezeCatalog(byFullId, byId, defaultModelKey, modelRoles = new Map(), modelAliases = new Map()) {
	const catalog = {
		byFullId,
		byId,
		defaultModelKey,
		modelRoles,
		modelAliases,
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
