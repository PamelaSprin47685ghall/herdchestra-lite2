// Pure tool-call decision for the Station.
//
// The Station owns the side effects: it processes the carrying message's
// controls, charges a branch, persists, and turns a refusal into a host block.
// This module owns only the decision. It takes plain snapshots, returns a
// plain result, never mutates its inputs, and imports no Station or host
// module.
//
// `charge` is an intent. The Station calls `chargeBranch` with the request and
// converts `{ ok: false }` into a block; the accounting refusal stays in the
// scope layer.

import { loadDoc } from "../../prompts/index.mjs";
import { CONTROL_TOOLS, parseArgs } from "../messages.mjs";

const E = loadDoc("errors");
// `core/policy.mjs` owns the classifier; this module must not import host.
// The persisted policy values are stable public strings.
const READ_ONLY_POLICY = "read-only-subagent";

const ALLOW = Object.freeze({
	verdict: "allow",
	block: null,
	controls: Object.freeze({ process: true, directAmend: null }),
	todo: null,
	charge: null,
	persist: false,
});

function allow(overrides = {}) {
	return {
		...ALLOW,
		...overrides,
		controls: { ...ALLOW.controls, ...(overrides.controls ?? {}) },
	};
}

function blocked(reason, controls = ALLOW.controls) {
	return {
		...ALLOW,
		verdict: "block",
		block: { reason },
		controls: { ...controls },
		charge: null,
		persist: false,
	};
}

/**
 * Decide one tool call from plain data.
 *
 * @param {object} input
 * @param {{autopilot?: boolean, charges?: object}} input.state
 * @param {{handled?: boolean, hasCall?: boolean}} input.processed
 * @param {{found?: boolean, groupKey?: string, beatTools?: Array<{name: string, free: boolean}>}} input.dispatch
 * @param {{toolName: string, toolCallId: string, input?: unknown}} input.call
 * @param {string} input.policy
 * @param {{ownerId?: string|null, timeLimitMs?: number|null}} input.relay
 * @returns {{
 *   verdict: "allow"|"block"|"readonly"|"wait",
 *   controls: {process: boolean, directAmend: {args: object}|null},
 *   todo: {free: true, persist: true, grant: false}|null,
 *   charge: {request: object, alreadyCharged: boolean}|null,
 *   persist: boolean,
 *   block: {reason: string}|null,
 * }}
 */
export function decideToolCall({
	state = {},
	processed = {},
	dispatch = {},
	call = {},
	policy = "main",
	relay = {},
} = {}) {
	const toolName = call.toolName;
	const toolCallId = call.toolCallId;
	const input = call.input ?? {};

	// A read-only subagent keeps `ask` and `wait`; every other tool bypasses
	// station routing and returns early. The host policy owns the denial.
	if (policy === READ_ONLY_POLICY && toolName !== "ask" && toolName !== "wait") {
		return {
			...ALLOW,
			verdict: "readonly",
			controls: { process: false, directAmend: null },
		};
	}

	// Native `todo` stays free at every level (never overrides host behavior).
	if (toolName === "todo") {
		return allow({
			todo: { free: true, persist: true, grant: false },
			persist: true,
		});
	}

	if (CONTROL_TOOLS.has(toolName)) {
		// The amend half of `scope_context` lands before the ordinary calls of
		// the same message, so the refund is in the ledger already when the
		// model reads the result.
		const parsed =
			toolName === "scope_context" ? parseArgs({ arguments: input }) : null;
		const directAmend =
			parsed?.amend !== undefined && !processed.handled
				? { args: parsed.amend }
				: null;
		return allow({
			controls: { process: true, directAmend },
			persist: false,
		});
	}

	if (toolName === "ask") {
		return state.autopilot ? blocked(E["ask-blocked"]) : allow({ persist: false });
	}

	if (toolName === "wait") {
		return allow({ verdict: "wait", persist: false });
	}

	const alreadyCharged = Boolean(
		state.charges && Object.hasOwn(state.charges, toolCallId),
	);
	return allow({
		charge: {
			request: {
				ownerId: relay.ownerId,
				toolCallId,
				toolName,
				groupKey: dispatch.groupKey,
				beatTools: Array.isArray(dispatch.beatTools) ? dispatch.beatTools : [],
				input,
			},
			alreadyCharged,
		},
		persist: true,
	});
}
