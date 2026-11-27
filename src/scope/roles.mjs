// Role domain core: a scope's name is its privilege.
//
// Pure functions only: no I/O, no Station import, no host import. A scope path
// segment must be `<role>.<name>`; the role prefix decides which host tools the
// scope may call, and privilege narrows monotonically down the tree.

export const ROLE_MANAGER = "manager";
export const ROLE_DEVOPS = "devops";
export const ROLE_EDITOR = "editor";
export const ROLE_INSPECTOR = "inspector";

/** Highest privilege first. */
export const ROLES = Object.freeze([
	ROLE_MANAGER,
	ROLE_DEVOPS,
	ROLE_EDITOR,
	ROLE_INSPECTOR,
]);

/** Smaller rank means more privilege. */
export const ROLE_RANK = Object.freeze({
	[ROLE_MANAGER]: 0,
	[ROLE_DEVOPS]: 1,
	[ROLE_EDITOR]: 2,
	[ROLE_INSPECTOR]: 3,
});

/** One path segment: `<role>.<name>` where `name` is an existing scope id. */
// The role is the first capture group: `roleOfSegment` reads `match[1]`.
export const ROLE_SEGMENT_SOURCE =
	"(manager|devops|editor|inspector)\\.[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*";

export const ROLE_SEGMENT_PATTERN = `^${ROLE_SEGMENT_SOURCE}$`;

const segmentPattern = new RegExp(ROLE_SEGMENT_PATTERN);

/** Tools that run commands or spawn work: never available to `editor`. */
export const EXEC_TOOLS = Object.freeze(
	new Set(["bash", "shell", "eval", "python", "task", "manage_skill"]),
);

/** The complete host-tool surface of `inspector`; everything else is refused. */
export const INSPECTOR_HOST_TOOLS = Object.freeze(
	new Set([
		"read",
		"grep",
		"glob",
		"find",
		"ast_grep",
		"web_search",
		"web_fetch",
		"fetch",
		"recall",
		"reflect",
	]),
);

/** True when `name` is a well-formed `<role>.<name>` segment. */
export function validRoleSegment(name) {
	return typeof name === "string" && segmentPattern.test(name);
}

/** The role encoded by one path segment, or null when the segment names none. */
export function roleOfSegment(name) {
	if (typeof name !== "string") return null;
	const match = segmentPattern.exec(name);
	return match ? match[1] : null;
}

/**
 * The role of a full scope path. Root (`/`) is always `manager`; a path whose
 * last segment carries no role prefix has no role (null).
 */
export function roleOfPath(path) {
	if (typeof path !== "string" || path === "") return null;
	if (path === "/") return ROLE_MANAGER;
	const segments = path.split("/").filter((segment) => segment !== "");
	if (segments.length === 0) return ROLE_MANAGER;
	return roleOfSegment(segments[segments.length - 1]);
}

/** Rank of a role, or null when the value names no role. */
export function roleRank(role) {
	const rank = ROLE_RANK[role];
	return Number.isInteger(rank) ? rank : null;
}

/** True when `callerRole` may act on `targetRole` (equal or narrower only). */
export function canActOn(callerRole, targetRole) {
	const caller = roleRank(callerRole);
	const target = roleRank(targetRole);
	if (caller === null || target === null) return false;
	return target >= caller;
}

/**
 * The host tools a role may hold, filtered from the host's advertised names.
 * `manager` holds none: it plans, delegates, joins, and synthesizes.
 */
export function roleTools(role, hostToolNames) {
	const names = Array.isArray(hostToolNames) ? hostToolNames : [];
	if (role === ROLE_MANAGER) return [];
	if (role === ROLE_INSPECTOR) {
		return names.filter(
			(name) => typeof name === "string" && INSPECTOR_HOST_TOOLS.has(name),
		);
	}
	if (role === ROLE_EDITOR) {
		return names.filter(
			(name) => typeof name === "string" && !EXEC_TOOLS.has(name),
		);
	}
	if (role === ROLE_DEVOPS) {
		// `devops` keeps every host tool the projection does not exclude.
		return names.filter((name) => typeof name === "string");
	}
	// No role means no host tool: an unnamed scope keeps only the control plane.
	return [];
}

const GLOB_CHARS = /[*?[\]{}]/;
const EXTENSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UPPERCASE_NAME = /^[A-Z][A-Za-z0-9_.-]*$/;

/**
 * True when one target names a concrete file, not prose, a glob, or a bare
 * directory. An `editor` may only be pointed at files it can open.
 */
export function isConcreteFilePath(value) {
	if (typeof value !== "string") return false;
	const path = value.trim();
	if (path === "" || /\s/.test(path)) return false;
	if (GLOB_CHARS.test(path)) return false;
	if (path.endsWith("/")) return false;
	const last = path.split("/").pop();
	if (last === "" || last === "." || last === "..") return false;
	if (last.startsWith(".")) return true;
	if (last.includes(".")) {
		const extension = last.slice(last.indexOf(".") + 1);
		return EXTENSION.test(extension);
	}
	// A bare uppercase name is a standard extensionless file (Makefile, LICENSE).
	return UPPERCASE_NAME.test(last);
}

/** True when every target is a concrete file path and at least one exists. */
export function validEditorTargets(value) {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((target) => isConcreteFilePath(target))
	);
}

/**
 * True when `budget` may fund this role. `manager` holds no host tool, so its
 * budget must be empty; `inspector` may only fund its read-only surface;
 * `editor` may not fund a command runner.
 */
export function roleBudgetAllowed(role, budget) {
	if (!budget || typeof budget !== "object") return false;
	const tools = Object.keys(budget);
	if (role === ROLE_MANAGER) return tools.length === 0;
	if (role === ROLE_INSPECTOR) {
		return tools.every((tool) => INSPECTOR_HOST_TOOLS.has(tool));
	}
	if (role === ROLE_EDITOR) {
		return tools.every((tool) => !EXEC_TOOLS.has(tool));
	}
	return true;
}

/** The one running `devops` in a fork list, or null. */
export function runningDevops(forks) {
	for (const record of Array.isArray(forks) ? forks : []) {
		if (!record || record.status !== "running") continue;
		if (roleOfPath(record.path) === ROLE_DEVOPS) return record;
		if (record.role === ROLE_DEVOPS) return record;
	}
	return null;
}
