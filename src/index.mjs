// Core API index. This node only lists its children's public keys.

// Station and its registry. The registry receives the host capability bag as
// a parameter, so nothing here knows which host runs it.
export { SessionStation, createStationRegistry } from "./station/index.mjs";

// Pure tickets: the ones that only orchestrate state and injected
// capabilities. Host-bound tickets live in the host package.
export {
	forkTicket,
	joinTicket,
	returnTicket,
	scopeContextTicket,
	panhandleTicket,
} from "./tools/tickets.mjs";
export { todoTicket, textResult, errorResult, continueFeedback } from "./tools/index.mjs";

// Tool descriptors are model-facing text owned by the core.
export {
	SCOPE_CONTEXT_DESCRIPTION,
	AMEND_PARAMETER_DESCRIPTION,
	PIN_PARAMETER_DESCRIPTION,
	REFLECTION_DESCRIPTION,
	PIN_ASSUMPTION_DESCRIPTION,
	PIN_DEDUCTION_DESCRIPTION,
	PIN_INDUCTION_DESCRIPTION,
	PIN_FINDING_DESCRIPTION,
	PIN_CONCLUSION_DESCRIPTION,
	FORK_DESCRIPTION,
	forkParameters,
	JOIN_DESCRIPTION,
	joinParameters,
	RETURN_DESCRIPTION,
	returnParameters,
	PANHANDLE_DESCRIPTION,
	PANHANDLE_TOOLS_DESCRIPTION,
	PANHANDLE_SECONDS_DESCRIPTION,
	PANHANDLE_BECAUSE_DESCRIPTION,
	scopeContextParameters,
	panhandleParameters,
	TODO_DESCRIPTION,
	TODO_OP_DESCRIPTION,
	TODO_LIST_DESCRIPTION,
	TODO_TASK_DESCRIPTION,
	TODO_PHASE_DESCRIPTION,
	TODO_ITEMS_DESCRIPTION,
	TODO_REASON_DESCRIPTION,
	TODO_PARAMETERS,
} from "./tools/index.mjs";

// Ports: names and resolution are core data; implementations are supplied by
// the host package for the host-specific entries.
export { resolvePorts, readSwitch } from "./core/ports/resolve.mjs";
export {
	PORT_NAMES,
	PORTS,
	NAMED_SWITCHES,

} from "./core/ports/registry.mjs";

// Port implementations owned by the core.
export { relayImplementations } from "./relay/policy.mjs";
export { createAmendOn, createAmendOff } from "./features/amend/index.mjs";
export { createHerdOn, createHerdOff } from "./features/herd/index.mjs";
export { createPinOn, createPinOff } from "./features/pin/index.mjs";
export { createClockOn, createClockOff, toolLimitOf } from "./scope/clock.mjs";

// Scope ledger: pure data and arithmetic.
export {
	emptyTotals,
	forkOf,
	markReady,
	takeReady,
	registerFork,
	amendFork,
	supersedeFork,
	openChildren,
	unreceivedChildren,
	assertPairing,
	applyCharge,
	applyRefund,
	restoreLedger,
	serializeLedger,
	validLedger,
} from "./scope/index.mjs";
export { RUNNING, READY } from "./scope/forkjoin.mjs";
export { scopeTitle, publicScopeId } from "./scope/scope-id.mjs";
export { normalizeTargets, validTargets } from "./scope/targets.mjs";
export { childReturnNudge } from "./scope/return-nudge.mjs";
export { selectForkLedger } from "./station/domain/fork-ledger.mjs";

// Transcript helpers.
export { renderChildRecord } from "./transcript/replay.mjs";
export { appendAt } from "./transcript/branch-writes.mjs";

// Prompt documents and injection.
export { loadDoc, render, preloadDocs, placeholderNames, DOCUMENTS } from "./prompts/index.mjs";
export {
	rewriteVibeModeContext,
	persistentOperatingSkill,
	injectSystemPrompt,
} from "./prompts/inject.mjs";

// Host-neutral policy values.
export {
	MAIN_AGENT,
	READ_ONLY_SUBAGENT,
	READ_WRITE_SUBAGENT,
	sessionInitFor,
	hasSessionInit,
	agentPolicy,
} from "./core/policy.mjs";
