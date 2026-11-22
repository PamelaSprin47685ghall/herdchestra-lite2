// Pure fork/join decisions for the Station.
//
// The Station owns the bracket ledger, the identity, and every side effect
// (take, commit, persistence, rendering). This module owns admission and
// fork validation. It takes plain snapshots, returns plain values, never
// mutates its inputs, and imports no Station or host module.

import {
	estimateJoinTokens,
	joinAdmission,
} from "../../scope/admission.mjs";
import { decideAbandon } from "../../scope/abandon.mjs";
import { normalizeBudget, validBudget } from "../../scope/budget.mjs";
import { normalizeTargets, validTargets } from "../../scope/targets.mjs";
import { publicScopeId, validScopeId } from "../../scope/scope-id.mjs";
import { resolveModelSelector } from "../../scope/model-selector.mjs";
import { trimText } from "../messages.mjs";

export { decideAbandon };

function admission({ baseTokens, recordChars, tokensPerChar, window, reserve, margin } = {}) {
	const projected = estimateJoinTokens({
		baseTokens,
		recordChars,
		tokensPerChar,
	});
	return joinAdmission({ window, projected, reserve, margin });
}

/** Can the parent's next request hold a child record of this size? */
export function decideJoinAdmission({
	baseTokens,
	recordChars,
	tokensPerChar,
	window,
	reserve,
	margin,
} = {}) {
	return admission({
		baseTokens,
		recordChars,
		tokensPerChar,
		window,
		reserve,
		margin,
	});
}

/** Can the parent's next request hold a fork receipt of this size? */
export function decideForkAdmission({
	baseTokens,
	receiptChars,
	tokensPerChar,
	window,
	reserve,
	margin,
} = {}) {
	return admission({
		baseTokens,
		recordChars: receiptChars,
		tokensPerChar,
		window,
		reserve,
		margin,
	});
}

/**
 * Check every fork argument without changing state. Returns the normalized
 * budget on success so the caller never normalizes twice.
 */
export function validateFork(args) {
	// Empty is valid here: a repeated scope id may carry only budget or
	// targets. A *new* scope still needs an intent, and the handler enforces
	// that after it knows whether the name already exists.
	const intent = trimText(args?.intent);
	if (!Object.hasOwn(args ?? {}, "budget") || !validBudget(args.budget)) {
		return { ok: false, code: "INVALID_BUDGET" };
	}
	const budget = normalizeBudget(args.budget);
	if (!validBudget(budget)) return { ok: false, code: "INVALID_BUDGET" };
	if (!validTargets(args?.targets)) {
		return { ok: false, code: "INVALID_TARGETS" };
	}
	if (args.model !== undefined && args.model !== null && typeof args.model !== "string") {
		return { ok: false, code: "INVALID_ARGUMENT" };
	}
	if (args.blocked !== undefined && typeof args.blocked !== "boolean") {
		return { ok: false, code: "INVALID_ARGUMENT" };
	}
	if (!validScopeId(args?.scopeId) || args.scopeId.toLowerCase() === "root") {
		return { ok: false, code: "INVALID_SCOPE_ID" };
	}
	return {
		ok: true,
		scopeId: args.scopeId,
		intent,
		budget,
		targets: normalizeTargets(args.targets),
		model: typeof args.model === "string" ? args.model.trim() : null,
		blocked: args.blocked === true,
	};
}

/**
 * Validate a whole fork batch before any state changes. One bad item rejects
 * the batch: a half-open batch would leave the model unsure which brackets it
 * owns.
 */
export function validateForkBatch(args) {
	if (!Array.isArray(args?.forks) || args.forks.length === 0) {
		return { ok: false, code: "INVALID_FORKS", index: -1 };
	}
	const items = [];
	for (let index = 0; index < args.forks.length; index += 1) {
		const item = validateFork(args.forks[index]);
		if (!item.ok) return { ok: false, code: item.code, index };
		items.push(item);
	}
	return { ok: true, items };
}

/**
 * The register decision: duplicate scope ids, model selectors and start
 * admission. The handler still registers, spawns, defers and reports.
 *
 * Items must already be validated by `validateForkBatch`. Forks are plain
 * records; the module reads their status/scope id and mutates nothing.
 */
export function decideRegister({
	items = [],
	forks = [],
	ownerId = "",
	models = null,
	hasSpawner = false,
	receiptChars = [],
	baseTokens = Number.POSITIVE_INFINITY,
	tokensPerChar = 0.3,
	window = null,
	reserve,
	margin,
} = {}) {
	// One live record per public name. A blocked entry is live: it is a
	// checkpoint that a later fork may amend and then start. Superseded
	// records are history and never answer a name.
	const live = new Map();
	for (const fork of Array.isArray(forks) ? forks : []) {
		if (!fork) continue;
		const key = publicScopeId(fork).toLowerCase();
		const previous = live.get(key);
		if (!previous) {
			live.set(key, fork);
			continue;
		}
		const generation = Number.isInteger(fork.generation) ? fork.generation : 1;
		const previousGeneration = Number.isInteger(previous.generation)
			? previous.generation
			: 1;
		if (generation >= previousGeneration) live.set(key, fork);
	}
	const next = [];
	// A repeated name inside one batch is not an error: the first item owns
	// the name and every later item amends that same record. The handler
	// resolves `targetStatus: "batch"` to the fork it created or amended
	// earlier in the same loop.
	const claimed = new Map();
	let needsSpawn = false;
	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];
		if (!item || typeof item.scopeId !== "string") {
			return { ok: false, code: "INVALID_SCOPE_ID", index };
		}
		const key = item.scopeId.toLowerCase();
		if (claimed.has(key)) {
			next.push({
				...item,
				action: "amend",
				targetForkId: null,
				targetStatus: "batch",
				spawnNextGeneration: false,
			});
			continue;
		}
		claimed.set(key, index);
		const existing = live.get(key);
		if (existing) {
			const recordOwner = existing.ownerId;
			if (
				typeof ownerId === "string" &&
				ownerId !== "" &&
				typeof recordOwner === "string" &&
				recordOwner !== "" &&
				recordOwner !== ownerId
			) {
				return {
					ok: false,
					code: "FOREIGN_SCOPE_ID",
					index,
					scopeId: item.scopeId,
				};
			}
			const spawning =
				existing.status === "ready" ||
				existing.status === "joined" ||
				existing.status === "failed";
			if (spawning) needsSpawn = true;
			next.push({
				...item,
				action: "amend",
				targetForkId: existing.forkId,
				targetStatus: existing.status,
				spawnNextGeneration: spawning,
			});
			continue;
		}
		if (item.blocked !== true) needsSpawn = true;
		next.push({ ...item, action: "create" });
	}
	if (needsSpawn && hasSpawner !== true) {
		return { ok: false, code: "CHILD_SPAWNER_UNAVAILABLE" };
	}
	for (let index = 0; index < next.length; index += 1) {
		const item = next[index];
		if (
			item.model == null ||
			item.blocked === true ||
			item.action === "amend"
		) {
			continue;
		}
		const resolved = resolveModelSelector(models, item.model);
		if (!resolved.ok) {
			return {
				ok: false,
				code: resolved.code,
				index,
				selector: item.model,
				available: resolved.available,
				availableTotal: resolved.availableTotal,
			};
		}
		next[index] = {
			...item,
			modelOverride: resolved.model,
			thinkingLevel: resolved.thinkingLevel,
		};
	}
	for (let index = 0; index < next.length; index += 1) {
		const item = next[index];
		if (item.blocked === true || item.action === "amend") continue;
		const override = item.modelOverride?.contextWindow;
		const itemWindow =
			Number.isFinite(override) && override > 0 ? override : window;
		const verdict = decideForkAdmission({
			baseTokens,
			receiptChars: receiptChars[index] ?? 0,
			tokensPerChar,
			window: itemWindow,
			reserve,
			margin,
		});
		if (!verdict.ok) {
			return {
				ok: false,
				code: "FORK_CONTEXT_EXCEEDED",
				index,
				reason: verdict.reason,
				admission: verdict.code,
				limit: verdict.limit,
				projected: verdict.projected,
				reserve: verdict.reserve,
				margin: verdict.margin,
				overBy: verdict.overBy,
			};
		}
	}
	const single = next.length === 1 ? next[0] : null;
	return {
		ok: true,
		items: next,
		needsSpawn,
		...(single
			? {
					action: single.action,
					targetForkId: single.targetForkId ?? null,
					targetStatus: single.targetStatus ?? null,
				}
			: {}),
	};
}

/** The return gate: identity, record, status and receiver, before any commit. */
export function decideReturn({
	identityForkId = "",
	record = null,
	receiverId = "",
	orphans = [],
} = {}) {
	if (typeof identityForkId !== "string" || identityForkId === "") {
		return { ok: false, code: "NOT_A_CHILD" };
	}
	if (!record || typeof record !== "object") {
		return { ok: false, code: "UNKNOWN_FORK" };
	}
	if (record.status !== "running") {
		return {
			ok: false,
			code: "FORK_NOT_RUNNING",
			status: record.status,
		};
	}
	if (typeof receiverId !== "string" || receiverId === "") {
		return { ok: false, code: "ORPHANS_WITHOUT_RECEIVER" };
	}
	return {
		ok: true,
		record,
		receiverId,
		orphans: Array.isArray(orphans) ? orphans : [],
	};
}

/** The ready gate and outcome normalization; the ledger mutation stays out. */
export function decideReady({ record = null, outcome = {} } = {}) {
	if (!record || typeof record !== "object") {
		return { ok: false, code: "UNKNOWN_FORK" };
	}
	if (record.status !== "running") {
		return { ok: false, code: "FORK_NOT_RUNNING", status: record.status };
	}
	const ok = outcome?.ok !== false;
	const reason =
		typeof outcome?.reason === "string" && outcome.reason !== ""
			? outcome.reason
			: null;
	const recordText =
		typeof outcome?.record === "string" ? outcome.record : null;
	return {
		ok: true,
		outcome: {
			ok,
			...(reason === null ? {} : { reason }),
			...(recordText === null ? {} : { record: recordText }),
		},
	};
}
