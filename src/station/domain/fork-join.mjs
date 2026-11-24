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
import { allocateSiblingScopeId, childScopePath } from "../../scope/path.mjs";
import { normalizeBudget, validBudget } from "../../scope/turns.mjs";
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
	pricedChars = null,
	path = null,
	recordChars = null,
	tokensPerChar,
	window,
	reserve,
	margin,
} = {}) {
	let chars = 0;
	if (Number.isFinite(recordChars)) {
		chars = recordChars;
	} else if (pricedChars !== null && path !== null) {
		const priced = pricedChars[path];
		chars = typeof priced === "number"
			? priced
			: (Number.isFinite(priced?.fresh) ? priced.fresh : 0);
	}
	return admission({
		baseTokens,
		recordChars: chars,
		tokensPerChar,
		window,
		reserve,
		margin,
	});
}

/**
 * Check every fork argument without changing state. Returns the normalized
 * turns on success so the caller never normalizes twice.
 */
export function validateFork(args) {
	// A fork only creates, so it always carries the state-machine text that
	// describes the work. An empty one is refused here, before any bracket
	// moves.
	const fsm = trimText(args?.fsm);
	if (fsm === "") return { ok: false, code: "INVALID_FSM" };
	// `budget` is the persisted field name; its values are turn counts.
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
	if (!validScopeId(args?.scopeId) || args.scopeId.toLowerCase() === "root") {
		return { ok: false, code: "INVALID_SCOPE_ID" };
	}
	// The child's identity statement. It must open with "You are " so the
	// spawned scope receives a role, not a task summary; the spawner injects
	// it as the first line below the receipt marker, before any instruction.
	// The JSON schema already requires the field at the tool edge.
	const profession = trimText(args?.profession);
	if (profession === "" || !profession.startsWith("You are ")) {
		return { ok: false, code: "INVALID_PROFESSION" };
	}
	return {
		ok: true,
		scopeId: args.scopeId,
		fsm,
		profession,
		budget,
		targets: normalizeTargets(args.targets),
		model: typeof args.model === "string" ? args.model.trim() : null,
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
	// No size or fanout is refused, and none is rebuked: the batch always runs.
	return { ok: true, items, warnings: [] };
}

/**
 * Which receipt a fork item sends. A fork only creates, so every item sends
 * one fresh receipt; nothing else can be priced, and no second action
 * judgement can drift from this one.
 */
export function forkReceiptPath(item = null) {
	if (!item) return null;
	if (item.action === "register" || item.action === "create") return "fresh";
	return null;
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
	parentForkId,
	parentPath = null,
	ownerId = "",
	models = null,
	hasSpawner = false,
	pricedChars = [],
	baseTokens = Number.POSITIVE_INFINITY,
	tokensPerChar = 0.3,
	window = null,
	reserve,
	margin,
} = {}) {
	// A fork only creates. Names are unique among siblings and never across the
	// conversation: the same name under two parents is two unrelated scopes.
	const parent =
		parentForkId !== undefined
			? (typeof parentForkId === "string" && parentForkId !== "root" ? parentForkId : null)
			: (typeof ownerId === "string" && ownerId !== "" && ownerId !== "root" ? ownerId : null);
	const records = Array.isArray(forks) ? forks.filter(Boolean) : [];
	const parentRecord = parent === null
		? null
		: records.find((fork) => fork.forkId === parent);
	const base =
		typeof parentPath === "string" && parentPath !== ""
			? parentPath
			: (parentRecord?.path ?? "/");
	const snapshot = { forks: {}, order: [] };
	for (const record of records) {
		if (typeof record.forkId !== "string" || record.forkId === "") continue;
		snapshot.forks[record.forkId] = record;
		snapshot.order.push(record.forkId);
	}
	const reserved = new Set();
	const next = [];
	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];
		if (!item || typeof item.scopeId !== "string") {
			return { ok: false, code: "INVALID_SCOPE_ID", index };
		}
		const scopeId = allocateSiblingScopeId(snapshot, parent, item.scopeId, reserved);
		reserved.add(scopeId);
		const { blocked: _blocked, ...rest } = item;
		next.push({
			...rest,
			action: "register",
			scopeId,
			path: childScopePath(base, scopeId),
			parentForkId: parent,
		});
	}
	if (hasSpawner !== true) {
		return { ok: false, code: "CHILD_SPAWNER_UNAVAILABLE" };
	}
	for (let index = 0; index < next.length; index += 1) {
		const item = next[index];
		if (item.model == null) continue;
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
		const price = pricedChars[index];
		const chars = typeof price === "number"
			? price
			: (Number.isFinite(price?.fresh) ? price.fresh : 0);
		const override = item.modelOverride?.contextWindow;
		const itemWindow =
			Number.isFinite(override) && override > 0 ? override : window;
		const verdict = decideForkAdmission({
			baseTokens,
			recordChars: chars,
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
		needsSpawn: true,
		...(single
			? {
					action: single.action,
					targetForkId: null,
					targetStatus: null,
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
