// Refusal table: one home for every refusal code.
//
// A refusal answers three questions: which documentation entry explains it,
// which values that entry interpolates, and which structured fields the host
// reads from `details`. Each control handler used to answer them inline, in a
// chain of `if` arms that repeated the same literal fallback text. A code and
// its documentation could drift apart with nothing to notice.
//
// This module holds the answers. It returns a plain `{ code, message, details }`
// and never builds a tool result itself, so it stays a pure table: the handler
// wraps the value with `errorResult` exactly as before, and the rendered text
// stays byte-identical.

import { loadDoc, render } from "../prompts/index.mjs";
import { publicScopeId } from "../scope/scope-id.mjs";

const E = loadDoc("errors");

/** The documentation entry for a code, or undefined when the code has none. */
export function doc(key) {
	return E[key];
}

/** The documentation text for one code, with its placeholders filled. */
export function docText(key, vars) {
	return vars === undefined ? E[key] : render(E[key], vars);
}

/**
 * Codes `validateForkBatch` answers, mapped to their documentation entry.
 *
 * The batch check runs before any ledger exists, so its refusals interpolate
 * nothing: the message is the entry itself plus the batch index.
 */
export const BATCH_DOC = {
	INVALID_PATH: "invalid-path",
	INVALID_SCOPE_ID: "invalid-path",
	INVALID_FSM: "invalid-fsm",
	INVALID_PROFESSION: "invalid-profession",
	INVALID_BUDGET: "invalid-budget",
	INVALID_ARGUMENT: "invalid-argument",
	INVALID_TARGETS: "invalid-targets",
	ROLE_ESCALATION: "role-escalation",
	DEVOPS_ALREADY_RUNNING: "devops-already-running",
	INVALID_EDITOR_TARGETS: "invalid-editor-targets",
	FORBIDDEN_ROLE_BUDGET: "forbidden-role-budget",
};

const UNKNOWN_ROLE = "unknown";

/**
 * One entry per refusal code.
 *
 * `vars` supplies the placeholder values; `details` supplies the structured
 * fields. `path` names the value the two role-escalation variants interpolate,
 * because a fork names the new path and an abandon names the target.
 */
const REFUSALS = {
  INVALID_PATH: {
  		indexed: true,
  		vars: () => ({}),
  		details: (d) => ({ index: d.index, path: d.path }),
  	},
	DUPLICATE_SCOPE_PATH: {
		vars: (d) => ({ path: d.path, status: d.status ?? "existing" }),
		details: (d) => ({ index: d.index, path: d.path, status: d.status }),
	},
	UNKNOWN_UPSCOPE: {
		vars: (d) => ({ upscopePath: d.upscopePath }),
		details: (d) => ({ index: d.index, upscopePath: d.upscopePath }),
	},
	UPSCOPE_NOT_READY: {
		vars: (d) => ({ upscopePath: d.upscopePath }),
		details: (d) => ({ index: d.index, upscopePath: d.upscopePath }),
	},
	ROLE_ESCALATION: {
		vars: (d, scope) => ({
			callerRole: d.callerRole ?? UNKNOWN_ROLE,
			targetRole: d.targetRole ?? UNKNOWN_ROLE,
			path: d.path ?? scope.targetPath,
		}),
		details: (d, scope) =>
			scope.abandon
				? {
						target: d.path ?? scope.targetPath,
						callerRole: d.callerRole,
						targetRole: d.targetRole,
					}
				: {
						index: d.index,
						path: d.path,
						callerRole: d.callerRole,
						targetRole: d.targetRole,
					},
	},
	DEVOPS_ALREADY_RUNNING: {
		vars: (d) => ({ activePath: d.activePath ?? "another scope" }),
		details: (d) => ({ index: d.index, path: d.path, activePath: d.activePath }),
	},
	INVALID_EDITOR_TARGETS: {
		vars: () => ({}),
		details: (d) => ({ index: d.index, path: d.path }),
	},
	FORBIDDEN_ROLE_BUDGET: {
		vars: (d) => ({
			tool: d.tool ?? UNKNOWN_ROLE,
			role: d.role ?? UNKNOWN_ROLE,
		}),
		details: (d) => ({ index: d.index, path: d.path, role: d.role, tool: d.tool }),
	},
	CHILD_SPAWNER_UNAVAILABLE: {
		vars: () => ({}),
		details: () => undefined,
	},
	FORK_CONTEXT_EXCEEDED: {
		vars: (d) => ({ index: d.index, reason: d.reason }),
		details: (d) => ({
			index: d.index,
			admission: d.admission,
			source: "measured",
			limit: d.limit,
			projected: d.projected,
			reserve: d.reserve,
			margin: d.margin,
			overBy: d.overBy,
		}),
	},
	MODEL_UNKNOWN: {
		vars: (d) => ({ index: d.index, selector: d.selector, available: availableText(d) }),
		details: (d) => ({
			index: d.index,
			selector: d.selector,
			available: d.available,
			availableTotal: d.availableTotal,
		}),
	},
	INVALID_RETURN_OATH: { vars: () => ({}), details: () => undefined },
	MISSING_DAFNY: { vars: () => ({}), details: () => undefined },
	MIXED_RETURN_TOOL_CALLS: { vars: () => ({}), details: () => undefined },
	UNRECEIVED_CHILDREN: {
		vars: (d) => ({ count: d.unreceived }),
		details: (d) => ({ unreceived: d.unreceived }),
	},
	ROOT_REWIND_UNAVAILABLE: { vars: () => ({}), details: () => undefined },
	NOT_A_CHILD: { vars: () => ({}), details: () => undefined },
	UNKNOWN_FORK: { vars: () => ({}), details: () => undefined },
	FORK_NOT_RUNNING: {
		vars: (d, scope) => ({ path: publicScopeId(scope.record), status: d.status }),
		details: () => undefined,
	},
	ORPHANS_WITHOUT_RECEIVER: { vars: () => ({}), details: () => undefined },
	CANNOT_ABANDON_ROOT: { vars: () => ({}), details: () => undefined },
	CANNOT_ABANDON_SELF: { vars: () => ({}), details: () => undefined },
	SCOPE_ALREADY_DONE: {
		vars: (d, scope) => ({ target: scope.record?.path ?? scope.targetPath }),
		details: () => undefined,
	},
	ABANDON_UNKNOWN_TARGET: {
		vars: (d, scope) => ({ target: scope.targetPath }),
		details: () => undefined,
	},
};

/** The documentation entry a refusal code reads. */
const DOC_KEY = {
	INVALID_PATH: "invalid-path",
	DUPLICATE_SCOPE_PATH: "duplicate-scope-path",
	UNKNOWN_UPSCOPE: "unknown-upscope",
	UPSCOPE_NOT_READY: "upscope-not-ready",
	ROLE_ESCALATION: "role-escalation",
	DEVOPS_ALREADY_RUNNING: "devops-already-running",
	INVALID_EDITOR_TARGETS: "invalid-editor-targets",
	FORBIDDEN_ROLE_BUDGET: "forbidden-role-budget",
	CHILD_SPAWNER_UNAVAILABLE: "child-spawner-unavailable",
	FORK_CONTEXT_EXCEEDED: "fork-context-exceeded",
	MODEL_UNKNOWN: "model-unknown",
	INVALID_RETURN_OATH: "invalid-return-oath",
	MISSING_DAFNY: "missing-dafny",
	MIXED_RETURN_TOOL_CALLS: "mixed-return",
	UNRECEIVED_CHILDREN: "return-unreceived",
	ROOT_REWIND_UNAVAILABLE: "return-rewind-unavailable",
	NOT_A_CHILD: "not-a-subscope",
	UNKNOWN_FORK: "unknown-fork",
	FORK_NOT_RUNNING: "fork-not-running",
	ORPHANS_WITHOUT_RECEIVER: "orphans-without-receiver",
	CANNOT_ABANDON_ROOT: "cannot-abandon-root",
	CANNOT_ABANDON_SELF: "cannot-abandon-self",
	SCOPE_ALREADY_DONE: "scope-already-done",
	ABANDON_UNKNOWN_TARGET: "abandon-unknown-target",
};

/** The tool list a model refusal names, as the receipt writes it. */
function availableText(decision) {
	const named = Array.isArray(decision.available) ? decision.available : [];
	const total = Number.isInteger(decision.availableTotal)
		? decision.availableTotal
		: named.length;
	if (named.length === 0) return "none";
	const more = total > named.length ? `, and ${total - named.length} more` : "";
	return `${named.join(", ")}${more}`;
}

/**
 * The refusal for one decision.
 *
 * `ctx` carries what the decision cannot: the record a fork-not-running names,
 * the target path an abandon names, and whether this is the abandon variant of
 * role escalation. Every arm returns the same three fields, so a handler wraps
 * it with `errorResult(message, details)` and sends exactly what it sent before.
 *
 * An unknown code is a bug, not a user error: it refuses with the code alone
 * rather than inventing documentation for it.
 */
export function refusal(decision, scope = {}) {
	const entry = REFUSALS[decision.code];
	if (!entry) {
		return { code: decision.code, message: decision.reason ?? decision.code, details: undefined };
	}
  	const key = DOC_KEY[decision.code];
  	const vars = entry.vars(decision, scope);
  	const text = key === undefined ? undefined : docText(key, vars);
  	// A refusal that names one item of a batch says which item, in the same
  	// suffix the batch check writes, so the two paths read alike.
  	const where =
  		entry.indexed === true && decision.index >= 0 ? ` (forks[${decision.index}])` : "";
  	return {
  		code: decision.code,
  		message: `${text ?? docText("invalid-argument")}${where}`,
  		details: entry.details(decision, scope),
  	};
}

/**
 * The refusal for a batch that never reached a ledger.
 *
 * A batch refusal interpolates nothing; it names the entry for its code and, when
 * the failure belongs to one item, says which item.
 */
export function batchRefusal(batch) {
	const where = batch.index >= 0 ? ` (forks[${batch.index}])` : "";
	const text = docText(BATCH_DOC[batch.code]) ?? "Invalid fork arguments.";
	return { code: batch.code, message: `${text}${where}`, details: undefined };
}
