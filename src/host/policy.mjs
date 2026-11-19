// Subagent policy derived from the host's persisted session_init entry.
//
// omp records `{ type: "session_init", agent, readOnly, tools }` on every
// subagent session (task/executor.ts). The main session has no `agent` field.
// `readOnly` is the host's own verdict on the agent definition
// (task/read-only-policy.ts), and it is authoritative. `tools` records every
// tool the session was granted, including extension-owned tools (`scope`,
// `amend`, `defer`, `pin`), so it must never be read as a capability list on
// its own. A read-only subagent gets no scope or relay enforcement and keeps
// no `todo`: the host strips `todo` from spawned subagents
// (task/executor.ts). A read-write subagent keeps the relay protocol and must
// have `todo` reactivated because that same strip removed it.

const READ_ONLY_TOOL_NAMES = new Set([
	"read",
	"wait",
	"grep",
	"glob",
	"find",
	"web_search",
	"ast_grep",
	"yield",
	"ask",
	"todo",
	"recall",
	"reflect",
	"retain",
	"memory_edit",
	"checkpoint",
	"rewind",
]);

// Tools this extension registers itself. They record bookkeeping, not file
// writes, so they must not turn a read-only agent into a read-write one when
// only the legacy `tools` list is available.
const NEUTRAL_TOOL_NAMES = new Set(["scope", "amend", "defer", "pin"]);

function isReadTier(name) {
	return READ_ONLY_TOOL_NAMES.has(name) || NEUTRAL_TOOL_NAMES.has(name);
}

export const MAIN_AGENT = "main";
export const READ_ONLY_SUBAGENT = "read-only-subagent";
export const READ_WRITE_SUBAGENT = "read-write-subagent";

function branchOf(ctx) {
	try {
		const branch = ctx?.sessionManager?.getBranch?.();
		return Array.isArray(branch) ? branch : [];
	} catch {
		return [];
	}
}

/** The newest session_init entry, or the runtime agent metadata fallback. */
export function sessionInitFor(ctx) {
	const branch = branchOf(ctx);
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type === "session_init") return entry;
	}
	const agent = ctx?.agent;
	if (
		agent &&
		(agent.kind === "sub" ||
			agent.kind === "subagent" ||
			(typeof agent.depth === "number" && agent.depth > 0))
	) {
		return agent;
	}
	return null;
}

/** True when the branch carries the host's persisted session contract. */
export function hasSessionInit(ctx) {
	const branch = branchOf(ctx);
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		if (branch[index]?.type === "session_init") return true;
	}
	return false;
}

/**
 * Classify the calling session. Unknown sessions stay on the main policy so a
 * missing or unreadable init entry can never disable the relay for the user.
 */
export function agentPolicy(ctx) {
	const init = sessionInitFor(ctx);
	if (!init) return MAIN_AGENT;
	const isSubagent =
		(typeof init.agent === "string" && init.agent !== "") ||
		init.kind === "sub" ||
		init.kind === "subagent" ||
		(typeof init.depth === "number" && init.depth > 0);
	if (!isSubagent) return MAIN_AGENT;
	// The host derives this flag from the agent definition and persists it
	// beside the granted tools. Trust it first: the granted list also carries
	// extension tools, which say nothing about write capability.
	if (init.readOnly === true) return READ_ONLY_SUBAGENT;
	if (init.readOnly === false) return READ_WRITE_SUBAGENT;
	const tools = Array.isArray(init.tools)
		? init.tools
		: Array.isArray(init.definition?.tools)
			? init.definition.tools
			: null;
	// Legacy sessions predate the flag. Apply the host's rule to the granted
	// list, counting this extension's own tools as read-tier.
	if (tools && tools.length > 0) {
		return tools.every((name) => isReadTier(name))
			? READ_ONLY_SUBAGENT
			: READ_WRITE_SUBAGENT;
	}
	// Only the runtime identity is known, so no tool grant has been recorded
	// yet. Assume read-only: a relay started here would demand a `todo` the
	// host has already stripped, while a read-write agent regains the relay
	// as soon as its contract lands.
	return READ_ONLY_SUBAGENT;
}
