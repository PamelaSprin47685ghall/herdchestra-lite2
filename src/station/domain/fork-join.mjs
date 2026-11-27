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
import { decideAbandon, decideAbandonRequest } from "../../scope/abandon.mjs";
import { findScopeByPath, resolveForkPath } from "../../scope/path.mjs";
import { normalizeBudget, validBudget } from "../../scope/turns.mjs";
import { normalizeTargets, validTargets } from "../../scope/targets.mjs";
import { resolveModelSelector } from "../../scope/model-selector.mjs";
import { modelKey } from "../models.mjs";
import { trimText } from "../messages.mjs";

export { decideAbandon, decideAbandonRequest };

function admission({ baseTokens, recordChars, tokensPerChar, window, reserve, margin } = {}) {
	const projected = estimateJoinTokens({
		baseTokens,
		recordChars,
		tokensPerChar,
	});
	return joinAdmission({ window, projected, reserve, margin });
}

/** Can the caller's next request hold a subscope record of this size? */
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

/** Can the new subscope's initial context hold its upscope context + birth receipt? */
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
	const fsm = trimText(args?.fsm);
	if (fsm === "") return { ok: false, code: "INVALID_FSM" };
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
	const rawPath = typeof args?.path === "string" ? args.path.trim() : "";
	if (rawPath === "") {
		return { ok: false, code: "INVALID_PATH" };
	}
	// Quick syntax check against `/` for standalone callers; `decideRegister`
	// resolves relative to `callerPath` again for full accuracy.
	const profession = trimText(args?.profession);
	if (profession === "" || !profession.startsWith("You are ")) {
		return { ok: false, code: "INVALID_PROFESSION" };
	}
	return {
		ok: true,
		path: rawPath,
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
	return { ok: true, items, warnings: [] };
}

/**
 * Which receipt a fork item sends. A fork only creates, so every item sends
 * one fresh receipt; nothing else can be priced.
 */
export function forkReceiptPath(item = null) {
	if (!item) return null;
	if (item.action === "register" || item.action === "create") return "fresh";
	return null;
}

/**
 * The register decision: strict path resolution, duplicate fail-closed,
 * upscope existence & snapshot readiness, upscope model inheritance, and
 * upscope-based context admission.
 */
export function decideRegister({
	items = [],
	forks = [],
	root = null,
	callerPath = "/",
	ownerId = "",
	models = null,
	hasSpawner = false,
	pricedChars = [],
	priceFor = null,
	baseTokens = Number.POSITIVE_INFINITY,
	tokensPerChar = 0.3,
	window = null,
	reserve,
	margin,
} = {}) {
	const records = Array.isArray(forks) ? forks.filter(Boolean) : [];
	const snapshot = { forks: {}, order: [] };
	for (const record of records) {
		if (typeof record.forkId !== "string" || record.forkId === "") continue;
		snapshot.forks[record.forkId] = record;
		snapshot.order.push(record.forkId);
	}
	const caller = typeof callerPath === "string" && callerPath.startsWith("/") ? callerPath : "/";
	const callerForkId = typeof ownerId === "string" && ownerId !== "" && ownerId !== "root" ? ownerId : null;

	// Phase 1: Resolve paths, fail-closed on invalid path, duplicate path,
	// unknown upscope, or unready upscope snapshot.
	const batchPaths = new Set();
	const next = [];
	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];
		const rawPath = item?.path;
		const resolved = resolveForkPath(caller, rawPath);
		if (!resolved.ok) {
			return { ok: false, code: "INVALID_PATH", index, path: rawPath };
		}
		const pathLower = resolved.path.toLowerCase();
		if (batchPaths.has(pathLower)) {
			return {
				ok: false,
				code: "DUPLICATE_SCOPE_PATH",
				index,
				path: resolved.path,
				status: "pending",
			};
		}
		const existing = findScopeByPath(snapshot, resolved.path);
		if (existing) {
			return {
				ok: false,
				code: "DUPLICATE_SCOPE_PATH",
				index,
				path: existing.path ?? resolved.path,
				status: existing.status === "running" ? "running" : "done",
			};
		}
		batchPaths.add(pathLower);

		let upscopeId = null;
		let upscopePath = "/";
		let upscopeRecord = null;
		let upscopeSnapshotLeafId = null;
		let upscopeModel = null;
		let upscopeThinking = null;
		let upscopeContextTokens = null;
		let upscopeWindow = null;

		if (resolved.upscopePath === "/") {
			upscopePath = "/";
			upscopeId = null;
			upscopeSnapshotLeafId = root?.safeSnapshotLeafId ?? null;
			upscopeModel = root?.model ?? null;
			upscopeThinking = root?.thinkingLevel ?? null;
			upscopeContextTokens = root?.contextTokens ?? null;
			upscopeWindow = root?.contextWindow ?? null;
			// Non-root caller forking under `/` needs Root's closed snapshot leaf.
			if (caller !== "/" && !upscopeSnapshotLeafId) {
				return {
					ok: false,
					code: "UPSCOPE_NOT_READY",
					index,
					upscopePath: "/",
				};
			}
		} else {
			upscopeRecord = findScopeByPath(snapshot, resolved.upscopePath);
			if (!upscopeRecord) {
				return {
					ok: false,
					code: "UNKNOWN_UPSCOPE",
					index,
					upscopePath: resolved.upscopePath,
				};
			}
			upscopeId = upscopeRecord.forkId;
			upscopePath = upscopeRecord.path ?? resolved.upscopePath;
			const isSameCaller = upscopeId === callerForkId || upscopePath.toLowerCase() === caller.toLowerCase();
			if (!isSameCaller && !upscopeRecord.safeSnapshotLeafId) {
				return {
					ok: false,
					code: "UPSCOPE_NOT_READY",
					index,
					upscopePath,
				};
			}
			upscopeSnapshotLeafId = upscopeRecord.safeSnapshotLeafId ?? null;
			upscopeModel = upscopeRecord.resolvedModel ?? upscopeRecord.model ?? null;
			upscopeThinking = upscopeRecord.resolvedThinking ?? null;
			upscopeContextTokens = upscopeRecord.snapshotContextTokens ?? null;
			upscopeWindow = upscopeRecord.contextWindow ?? null;
		}

		const { blocked: _blocked, ...rest } = item;
		next.push({
			...rest,
			action: "register",
			scopeId: resolved.name,
			path: resolved.path,
			upscopeId,
			upscopePath,
			callerPath: caller,
			upscopeSnapshotLeafId,
			upscopeModel,
			upscopeThinking,
			upscopeContextTokens,
			upscopeWindow,
			sameCallerAsUpscope: upscopePath.toLowerCase() === caller.toLowerCase(),
		});
	}

	if (hasSpawner !== true) {
		return { ok: false, code: "CHILD_SPAWNER_UNAVAILABLE" };
	}

	// Phase 2: Resolve model (explicit selector, or inherit upscope's model + thinking).
	for (let index = 0; index < next.length; index += 1) {
		const item = next[index];
		if (item.model != null) {
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
			const resolvedKey = modelKey(resolved.model);
			const thinkingLevel = resolved.thinkingLevel ?? item.upscopeThinking ?? null;
			next[index] = {
				...item,
				modelOverride: resolved.model,
				thinkingLevel,
				resolvedModel: resolvedKey,
				resolvedThinking: thinkingLevel,
				resolvedWindow: resolved.model?.contextWindow ?? null,
			};
		} else {
			// Omit model: inherit upscope's model + thinking level.
			const inheritedModel = item.upscopeModel;
			const inheritedThinking = item.upscopeThinking;
			if (inheritedModel && models && typeof models.resolve === "function") {
				const selector = inheritedThinking
					? `${inheritedModel}:${inheritedThinking}`
					: inheritedModel;
				const resolved = resolveModelSelector(models, selector);
				if (!resolved.ok) {
					return {
						ok: false,
						code: resolved.code,
						index,
						selector,
						available: resolved.available,
						availableTotal: resolved.availableTotal,
					};
				}
				const resolvedKey = modelKey(resolved.model) ?? inheritedModel;
				const thinkingLevel = resolved.thinkingLevel ?? inheritedThinking ?? null;
				next[index] = {
					...item,
					modelOverride: resolved.model,
					thinkingLevel,
					resolvedModel: resolvedKey,
					resolvedThinking: thinkingLevel,
					resolvedWindow: resolved.model?.contextWindow ?? item.upscopeWindow ?? null,
				};
			} else {
				next[index] = {
					...item,
					modelOverride: undefined,
					thinkingLevel: inheritedThinking ?? null,
					resolvedModel: inheritedModel ?? null,
					resolvedThinking: inheritedThinking ?? null,
					resolvedWindow: item.upscopeWindow ?? null,
				};
			}
		}
	}

	// Phase 3: Context admission against upscope's context + subscope's target window.
	for (let index = 0; index < next.length; index += 1) {
		const item = next[index];
		const priced = typeof priceFor === "function" ? priceFor(item, index) : pricedChars[index];
		const chars = typeof priced === "number"
			? priced
			: (Number.isFinite(priced?.fresh) ? priced.fresh : 0);
		const itemBaseTokens = item.sameCallerAsUpscope
			? (Number.isFinite(item.upscopeContextTokens) ? item.upscopeContextTokens : baseTokens)
			: (Number.isFinite(item.upscopeContextTokens) ? item.upscopeContextTokens : Number.POSITIVE_INFINITY);
		const itemWindow =
			Number.isFinite(item.resolvedWindow) && item.resolvedWindow > 0
				? item.resolvedWindow
				: (Number.isFinite(item.upscopeWindow) && item.upscopeWindow > 0
					? item.upscopeWindow
					: window);
		const verdict = decideForkAdmission({
			baseTokens: itemBaseTokens,
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
		next[index] = {
			...item,
			birthContextTokens: Number.isFinite(itemBaseTokens) ? itemBaseTokens : null,
			contextWindow: Number.isFinite(itemWindow) && itemWindow > 0 ? itemWindow : null,
		};
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
	const abandoned = outcome?.abandoned === true;
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
			...(abandoned ? { abandoned: true } : {}),
			...(reason === null ? {} : { reason }),
			...(recordText === null ? {} : { record: recordText }),
		},
	};
}
