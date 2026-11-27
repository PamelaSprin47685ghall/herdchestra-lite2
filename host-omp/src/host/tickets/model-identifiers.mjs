// Model identity: is the live model the one the request named?
//
// One model has several names — `id`, `provider/id`, `fullId`, and whatever the
// registry calls it — and the host may resolve an alias the extension cannot. So
// a comparison takes every identifier of the actual model and asks whether the
// expected key is one of them, with a bare id also matching as the tail of a
// qualified one.

import { modelFrom, modelOf, thinkingFrom, thinkingOf } from "../adapter.mjs";

const THINKING_SUFFIX =
	/(?:\s*[:@]\s*|\s+)(off|minimal|low|medium|high|xhigh|max)\s*$/i;

/**
 * Strip a trailing thinking level from a model spec.
 *
 * This variant trims its input first, because a control request may carry a
 * padded argument. The pricing copy does not trim, and the two are kept apart on
 * purpose.
 */
export function splitThinkingSuffix(text) {
	const value = String(text ?? "").trim();
	const match = THINKING_SUFFIX.exec(value);
	if (!match) return { model: value, thinking: null };
	return {
		model: value.slice(0, match.index).trim(),
		thinking: match[1].toLowerCase(),
	};
}

export function normalizedKey(value) {
	return String(value ?? "").trim().toLowerCase();
}

/** `provider/id` for a model object, or the trimmed string itself. */
export function modelKeyOf(model) {
	if (typeof model === "string") return model.trim() || null;
	if (!model || typeof model !== "object") return null;
	const id = model.id ?? model.model;
	if (typeof id !== "string" || !id) return null;
	return model.provider ? `${model.provider}/${id}` : id;
}

/** Every normalized name one model answers to. */
export function modelIdentifiers(model) {
	const key = modelKeyOf(model);
	if (!key) return [];
	const ids = new Set([key]);
	if (model && typeof model === "object") {
		const id = model.id ?? model.model;
		const provider = model.provider;
		if (typeof id === "string" && id) {
			ids.add(id);
			if (provider) ids.add(`${provider}/${id}`);
		}
		for (const extra of [model.fullId, model.full_id, model.key]) {
			if (typeof extra === "string" && extra) ids.add(extra);
		}
	}
	return [...ids].map(normalizedKey).filter(Boolean);
}

/** True when `actual` answers to `expectedKey`. */
export function sameModelKey(actual, expectedKey) {
	const expected = normalizedKey(expectedKey);
	if (!expected) return false;
	const ids = modelIdentifiers(actual);
	if (ids.includes(expected)) return true;
	if (!expected.includes("/")) {
		return ids.some((id) => id === expected || id.endsWith(`/${expected}`));
	}
	return false;
}

export function liveModelFor(ctx, session, target) {
	return modelFrom(target) ?? modelFrom(session) ?? modelOf(ctx);
}

export function liveThinkingFor(ctx, session, target) {
	return thinkingFrom(target) ?? thinkingFrom(session) ?? thinkingOf(ctx);
}

export function normalizeThinking(level) {
	return String(level ?? "").trim().toLowerCase();
}
