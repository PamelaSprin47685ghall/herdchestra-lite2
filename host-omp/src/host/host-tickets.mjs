/**
 * Host-bound tickets: the asynchronous flows that speak the omp host API.
 *
 * The pure control flows live in `src/tools/tickets.mjs` and are host-free;
 * this node binds them to the host capabilities they need (diagnostics, the
 * fork registry waiters, model switching) and adds the tickets whose whole
 * body is a host call (steer, prompt, rewind, scoped model switch).
 *
 * Everything here is the adapter side of the boundary: when the wiring moves
 * into the host package, this file moves with it unchanged.
 *
 * The bodies live in `./tickets/`, one concern per file; this module is the
 * public face, so every caller keeps importing the same names from here.
 */

export { sendSteerTicket } from "./tickets/steer.mjs";
export { sendUserMessageTicket } from "./tickets/prompt.mjs";
export { canRewindRoot, rewindRootTicket } from "./tickets/rewind.mjs";
export {
	applyPendingModelSwitch,
	restoreScopedModelTicket,
	switchModelTicket,
} from "./tickets/model.mjs";
