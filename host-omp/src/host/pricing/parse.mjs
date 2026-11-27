// Model-spec resolution: turn what the user typed into a catalog entry.
//
// The order is fixed and each step answers a different question. Settings
// aliases and roles come first, because they belong to the host configuration
// and outrank any guess. Then the live model registry, then the pricing catalog.
// An exact match always wins over a substring match, and a substring match is
// only accepted when exactly one entry fits: a guess must never become the model
// that a later verification expects.

import { sessionOf } from "../adapter.mjs";
import {
	addConfiguredEntries,
	asNonEmptyString,
	asPositiveNumber,
	normalizeCost,
	settingValue,
} from "./ingest.mjs";
import { policyFromCatalogEntry } from "./policy.mjs";

const THINKING_SUFFIX =
	/(?:\s*[:@]\s*|\s+)(off|minimal|low|medium|high|xhigh|max)\s*$/i;

/**
 * Strip a trailing thinking level from a model spec.
 *
 * This variant does not trim its input, and the ticket-side copy does. They are
 * separate on purpose: the ticket copy receives a possibly padded CLI argument,
 * while this one receives a spec that a caller already trimmed.
 */
function splitThinkingSuffix(text) {
	const match = THINKING_SUFFIX.exec(text);
	if (!match) return { model: text, thinking: null };
	return {
		model: text.slice(0, match.index).trim(),
		thinking: match[1].toLowerCase(),
	};
}

function configuredMaps(ctx, catalog) {
	// `sessionOf` is the adapter's total read: it returns the live session or
	// null and never throws. Calling a bare `sessionFor` here used to raise a
	// ReferenceError that the surrounding catch turned into `session = null`,
	// so settings that live on the AgentSession were silently ignored.
	const session = sessionOf(ctx);
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
	const session = sessionOf(ctx);
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
 * Synchronous model-spec pre-parse for host `/model`-style commands.
 *
 * Resolves settings aliases/roles, strips a trailing thinking suffix
 * (`:off`, `:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, `:max`, or the
 * same after `@`/whitespace), then tries the live model registry before the pricing
 * catalog. An unknown spec stays unrecognized so the host can apply its own
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
