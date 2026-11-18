// Subagent policy derived from the host's persisted session_init entry.
//
// omp records `{ type: "session_init", agent, readOnly }` on every subagent
// session (task/executor.ts). The main session has no `agent` field. A
// read-only subagent gets no scope or relay enforcement: its tool set cannot
// write, and the host strips `todo` from it. A read-write subagent keeps the
// relay protocol and must have `todo` reactivated in its active tool set.

const READ_ONLY_TOOL_NAMES = new Set([
	"read",
	"grep",
	"glob",
	"web_search",
	"ast_grep",
	"yield",
	"hub",
	"ask",
	"todo",
	"recall",
	"reflect",
	"retain",
	"memory_edit",
	"inspect_image",
	"checkpoint",
	"rewind",
]);

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
	if (init.readOnly === true) return READ_ONLY_SUBAGENT;
	if (init.readOnly === false) return READ_WRITE_SUBAGENT;
	const tools = Array.isArray(init.tools)
		? init.tools
		: Array.isArray(init.definition?.tools)
			? init.definition.tools
			: null;
	if (
		tools &&
		tools.length > 0 &&
		tools.every((name) => READ_ONLY_TOOL_NAMES.has(name))
	) {
		return READ_ONLY_SUBAGENT;
	}
	return READ_WRITE_SUBAGENT;
}
