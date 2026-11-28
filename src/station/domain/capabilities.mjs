// Capability projection: the single source of truth for what the model may
// call this turn.
//
// One pure function, `projectCapabilities`, computes the mode, the sorted
// tool-name list, the REPL `state` object, and the cache signature in a single
// pass. Pure functions only: no Station import, no host import, no mutation of
// inputs, no I/O.

import { createHash } from "node:crypto";
import { deadlineInfo } from "../../scope/clock.mjs";
import { ROLE_CAPACITY, ROLE_MANAGER, roleTools } from "../../scope/roles.mjs";
import { renderYamlView } from "../../format/yaml-view.mjs";
import { formatUnits as formatAmount } from "../../core/primitives.mjs";

// Free control-plane primitives every normal scope keeps.
export const BASE_TOOLS = Object.freeze([
	"scope_fork",
	"scope_join",
	"scope_return",
	"scope_abandon",
	"wait",
]);

// Host tools that never reach a subscope's `api`: `ask` is the root's own
// user channel, `todo` is retired, `wait` is already a base tool, and `js` is
// the executor itself.
export const EXCLUDED_HOST_TOOLS = Object.freeze(new Set(["ask", "todo", "wait", "js"]));

/** Join present role phrases as "3+ managers, 10+ editors and 1 devops". */
function joinRoleList(parts) {
	if (parts.length === 1) return parts[0];
	return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * The idle-hands conclusion printed beside a manager's directory delta.
 *
 * Capacity is fixed per role; `runningByRole` counts the scopes now running,
 * root included. A role at or over capacity is dropped, and the whole line
	 * disappears when every role is full. `+` marks a count as a lower bound;
	 * `devops` is a single slot and takes no `+`. The projection mints the line
	 * only for a manager whose active `scope` feature is `hard`.
	 */
function idleHandsSummary(runningByRole) {
	if (!runningByRole || typeof runningByRole !== "object") return null;
	const roles = [
		{ key: ROLE_MANAGER, label: "managers", plus: true },
		{ key: "inspector", label: "inspectors", plus: true },
		{ key: "editor", label: "editors", plus: true },
		{ key: "devops", label: "devops", plus: false },
	];
	const present = [];
	let hands = 0;
	for (const { key, label, plus } of roles) {
		const capacity = ROLE_CAPACITY[key];
		const running = Number.isInteger(runningByRole[key]) ? runningByRole[key] : 0;
		const idle = Math.max(0, capacity - running);
		if (idle === 0) continue;
		present.push({ label, idle, text: plus ? `${idle}+ ${label}` : `${idle} ${label}` });
		hands += idle;
	}
	if (present.length === 0) return null;
	const list = joinRoleList(present.map((role) => role.text));
	const verb =
		present.length === 1 && present[0].label === "devops" && present[0].idle === 1
			? "is"
			: "are";
	return `${list} ${verb} on the clock with nothing to do. ${hands}+ paid-for hands sit idle while you work alone; parallel capacity burns, and nobody will assign them work for you. You are the bottleneck; every hour you serialize is a choice. Give them the next slices now, before your successor inherits a roster of spectators.`;
}

/**
 * Project the current capability set from persisted session state.
 *
 * Mode priority (highest first):
 * - ABANDONED: another scope abandoned this scope; only `scope_return` is bound
 *   (outranks CONTEXT_LIMIT and unreceived so the scope returns immediately).
 * - CONTEXT_LIMIT: context is over half the window; only `scope_return` remains.
 * - FINAL_ANSWER: root sealed; no tools at all, the model can only write the
 *   final answer. A new user message resets `canStop`.
 * - Normal family (`SUBSCOPE` / `ROOT_MANUAL` / `ROOT_AUTOPILOT`): full set.
 *   `ROOT_AUTOPILOT` names an active goal session (`/herd-goal`): no `ask`,
 *   and root cannot stop before `scope_return`. The name is kept for the
 *   projection's stability; there is no user-facing toggle.
 *
 * Returns a frozen `{ mode, tools, state, signature }`.
 */
export function projectCapabilities({
	isChild = false,
	role = null,
	autopilot = false,
	unreceived = 0,
	canStop = false,
	contextOverHalf = false,
	abandoned = null,
	remaining = null,
	selfPath = "/",
	scopesDelta = null,
	runningByRole = null,
	featureScope = "hard",
	hostToolNames = [],
	chinese = "on",
} = {}) {
	let mode;
	let tools;
	const abandonedInfo =
		isChild && abandoned && typeof abandoned === "object"
			? {
					by: typeof abandoned.by === "string" && abandoned.by !== "" ? abandoned.by : "/",
					...(typeof abandoned.reason === "string" && abandoned.reason !== ""
						? { reason: abandoned.reason }
						: {}),
				}
			: null;

	if (abandonedInfo) {
		mode = "ABANDONED";
		tools = ["scope_return"];
	} else if (contextOverHalf) {
		mode = "CONTEXT_LIMIT";
		tools = ["scope_return"];
	} else if (!isChild && canStop === true) {
		mode = "FINAL_ANSWER";
		tools = [];
	} else {
		mode = isChild ? "SUBSCOPE" : autopilot ? "ROOT_AUTOPILOT" : "ROOT_MANUAL";
		const set = new Set(BASE_TOOLS);
		if (!isChild && autopilot !== true) set.add("ask");
		if (isChild) {
			// The role decides which host tools exist at all; the projection only
			// removes the executor and the root's own channels.
			for (const name of roleTools(role, hostToolNames)) {
				if (typeof name !== "string" || name === "") continue;
				if (EXCLUDED_HOST_TOOLS.has(name)) continue;
				set.add(name);
			}
		}
		tools = [...set].sort();
	}

	const hasDelta =
		scopesDelta && typeof scopesDelta === "object" && Object.keys(scopesDelta).length > 0;
	const summary =
		hasDelta && role === ROLE_MANAGER && featureScope === "hard"
			? idleHandsSummary(runningByRole)
			: null;

	const state = {
		mode,
		...(typeof role === "string" && role !== "" ? { role } : {}),
		scope: isChild ? selfPath : "/",
		...(abandonedInfo ? { abandoned: abandonedInfo } : {}),
		...(isChild
			? { remaining: remaining && typeof remaining === "object" ? remaining : {} }
			: { autopilot: autopilot === true, canStop: canStop === true }),
		unreceived: Number.isInteger(unreceived) ? unreceived : 0,
		...(hasDelta ? { scopes_delta: { ...scopesDelta } } : {}),
		...(summary ? { scopes_summary: summary } : {}),
	};

	const projected = JSON.stringify({ api: tools, ...state, chinese });
	const signature = createHash("sha256").update(projected).digest("hex");

	return Object.freeze({
		mode,
		tools: Object.freeze(tools),
		state: Object.freeze(state),
		signature,
	});
}

  /** Wall-clock spans print as `m:ss`, matching the retired scope line. */
function formatClock(ms) {
	if (!Number.isFinite(ms) || ms < 0) return "0:00";
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

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
			: `${formatClock(info.leftMs)} left of ${formatClock(record.timeBudgetMs)}`;
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
	"# System Requirement: 强制以简体中文思考，以简体中文词开头，简体中文回答。";

export function renderConsoleReceipt(
	projection,
	{ removedKeys = [], chinese = "on" } = {},
) {
	const lines = [];
	for (const key of Array.isArray(removedKeys) ? removedKeys : []) {
		if (typeof key !== "string" || key === "") continue;
		lines.push(`> delete api.${key}`, "true");
	}
	const view = { api: projection?.tools ?? [], ...(projection?.state ?? {}) };
	lines.push(PROBE_COMMAND, renderYamlView(view, { depth: 3 }));
	if (chinese !== "off") {
		lines.push(CHINESE_REMINDER_LINE);
	}
	return lines.join("\n");
}
