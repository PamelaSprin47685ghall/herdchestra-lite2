// Capability projection: the single source of truth for what the model may
// call this turn.
//
// One pure function, `projectCapabilities`, computes the mode, the sorted
// tool-name list, the REPL `state` object, and the cache signature in a single
// pass. The same projection drives all three consumers, so they cannot drift:
//   1. the per-turn REPL probe text (`renderConsoleReceipt` here),
//   2. the frozen `api` object the js ticket builds inside the vm,
//   3. the `capSig` compared by receiptMatches/modeChanged for cache reuse.
//
// There is no alias/guard/preset mapping layer: every key on `api` is the real
// tool name, dispatched one-to-one. Pure functions only: no Station import, no
// host import, no mutation of inputs, no I/O.

import { createHash } from "node:crypto";
import { deadlineInfo } from "../../scope/clock.mjs";
import { renderYamlView } from "../../format/yaml-view.mjs";

// Free control-plane primitives every normal scope keeps. `scope_reply` is
// deliberately absent: it exists only inside the AWAITING_REPLY mode.
export const BASE_TOOLS = Object.freeze([
	"scope_request",
	"scope_fork",
	"scope_join",
	"scope_return",
	"scope_abandon",
	"wait",
]);

// Host tools that never reach a child scope's `api`: `ask` is the root's own
// user channel, `todo` is retired, `wait` is already a base tool, and `js` is
// the executor itself.
export const EXCLUDED_HOST_TOOLS = Object.freeze(new Set(["ask", "todo", "wait", "js"]));

/**
 * Project the current capability set from persisted session state.
 *
 * Mode priority (highest first):
 * - AWAITING_REPLY: a pending scope_request must be answered before anything else.
 *   It outranks CONTEXT_LIMIT so a half-full scope can still unblock its
 *   caller with one light reply turn instead of dying mid-RPC.
 * - CONTEXT_LIMIT: context is over half the window; only scope_return remains.
 * - FINAL_ANSWER: root finished its second oath; no tools at all, the model
 *   can only write the final answer. A new user message resets `canStop`.
 * - the default family (CHILD / ROOT_MANUAL / ROOT_AUTOPILOT): the full set
 *   for this scope kind.
 *
 * Returns a frozen `{ mode, tools, state, signature }`.
 */
export function projectCapabilities({
	isChild = false,
	autopilot = false,
	unreceived = 0,
	canStop = false,
	contextOverHalf = false,
	pendingRequest = null,
	remaining = null,
	selfPath = "/",
	activePaths = ["/"],
	hostToolNames = [],
} = {}) {
	let mode;
	let tools;
	if (pendingRequest) {
		mode = "AWAITING_REPLY";
		tools = ["scope_reply"];
	} else if (contextOverHalf) {
		mode = "CONTEXT_LIMIT";
		tools = ["scope_return"];
	} else if (!isChild && canStop === true) {
		mode = "FINAL_ANSWER";
		tools = [];
	} else {
		mode = isChild ? "CHILD" : autopilot ? "ROOT_AUTOPILOT" : "ROOT_MANUAL";
		const set = new Set(BASE_TOOLS);
		// `ask` is the root's user channel. A child talks to other scopes
		// through scope_request/scope_reply and never needs it, autopilot or not.
		if (!isChild && autopilot !== true) set.add("ask");
		if (isChild) {
			for (const name of Array.isArray(hostToolNames) ? hostToolNames : []) {
				if (typeof name !== "string" || name === "") continue;
				if (EXCLUDED_HOST_TOOLS.has(name)) continue;
				set.add(name);
			}
		}
		tools = [...set].sort();
	}

	const state = {
		mode,
		scope: isChild ? selfPath : "/",
		...(pendingRequest
			? {
					request: {
						from: typeof pendingRequest.from === "string" ? pendingRequest.from : "",
						message:
							typeof pendingRequest.message === "string" ? pendingRequest.message : "",
					},
				}
			: {}),
		...(isChild
			? { remaining: remaining && typeof remaining === "object" ? remaining : {} }
			: { autopilot: autopilot === true, canStop: canStop === true }),
		unreceived: Number.isInteger(unreceived) ? unreceived : 0,
		scopes: Array.isArray(activePaths) ? [...activePaths] : ["/"],
	};

	// The signature must cover everything the probe prints, because
	// `receiptMatches` compares it to decide whether a committed receipt can be
	// reused. A mode-only signature let a stale `remaining`, `scopes` list, or
	// clock survive every turn inside one mode, which contradicts the
	// level-triggered contract this probe exists to honour. The receipt is the
	// trailing message, so rewriting it never invalidates a cached prefix; the
	// hash only stops a rewrite when the bytes would be identical anyway.
	// The pending request id stays outside the hash: two requests carrying
	// identical text still each need their own delivery turn.
	const projected = JSON.stringify({ api: tools, ...state });
	const signature = `${typeof pendingRequest?.id === "string" ? pendingRequest.id : ""}:${createHash("sha256").update(projected).digest("hex")}`;

	return Object.freeze({
		mode,
		tools: Object.freeze(tools),
		state: Object.freeze(state),
		signature,
	});
}

/** Turn counts print trimmed: `2` for integers, `2.5` at cent precision. */
function formatAmount(n) {
	if (!Number.isFinite(n)) return "0";
	const rounded = Math.round(n * 100) / 100;
	return String(rounded);
}

/** Wall-clock spans print as `m:ss`, matching the retired scope line. */
function formatClock(ms) {
	if (!Number.isFinite(ms) || ms < 0) return "0:00";
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The structured balance object the REPL probe prints as `state.remaining`.
 *
 * Every entry reads `remaining/budget` for one tool, so the field name and
 * the value agree: it is what is left, never what is used. `budget` stays a
 * fork-input word; at runtime the balance is always `remaining`. Overtime
 * collapses the clock entry to `time: 'OVERTIME'`; panhandles appear only
 * when nonzero.
 */
export function forkRemaining(record, now = Date.now(), clock = null) {
	const out = {};
	if (!record || typeof record !== "object") return out;
	const remaining = record.remaining;
	if (remaining && typeof remaining === "object") {
		for (const tool of Object.keys(remaining).sort()) {
			const budget = record.budget?.[tool];
			if (!Number.isFinite(budget)) continue;
			const left = Number.isFinite(remaining[tool]) ? remaining[tool] : 0;
			out[tool] = `${formatAmount(left)}/${formatAmount(budget)}`;
		}
	}
	const info = clock && typeof clock.info === "function"
		? clock.info(record, now)
		: deadlineInfo(record, now);
	if (info.bounded) {
		out.time = info.overtime
			? "OVERTIME"
			: `${formatClock(info.leftMs)}/${formatClock(record.timeBudgetMs)}`;
	}
	const panhandled = Number.isInteger(record.panhandleTotal)
		? record.panhandleTotal
		: Array.isArray(record.panhandles)
			? record.panhandles.length
			: 0;
	if (panhandled > 0) out.panhandled = panhandled;
	return out;
}

const PROBE_COMMAND = "> ({ api: Object.keys(api), ...state })";
const CHINESE_REMINDER_LINE =
	"> // System Requirement: 强制以简体中文思考，以简体中文词开头，简体中文回答。";

/**
 * Render the per-turn REPL probe committed as the trailing user message.
 *
 * The probe is level-triggered: it prints the whole current projection every
 * turn, so a lost or compacted transition never hides the truth. On the one
 * turn where keys disappear, edge highlight lines (`> delete api.<k>` / true)
 * precede the level printout. The view is block YAML rendered by
 * `renderYamlView`, so nested tables and long values stay readable and the
 * same renderer also prints js results.
 */
export function renderConsoleReceipt(
	projection,
	{ removedKeys = [], chineseReminder = "on" } = {},
) {
	const lines = [];
	for (const key of Array.isArray(removedKeys) ? removedKeys : []) {
		if (typeof key !== "string" || key === "") continue;
		lines.push(`> delete api.${key}`, "true");
	}
	const view = { api: projection?.tools ?? [], ...(projection?.state ?? {}) };
	lines.push(PROBE_COMMAND, renderYamlView(view, { depth: 3 }));
	if (chineseReminder !== "off") {
		lines.push(CHINESE_REMINDER_LINE);
	}
	return lines.join("\n");
}
