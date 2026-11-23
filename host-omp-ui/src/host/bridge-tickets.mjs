// Thin composition entry: the ticket coroutines live in ./tickets/.
// This module keeps the public seam stable for activation and tests.
export { createUiBridge } from "./tickets/interaction-bridge.mjs";
export { createHostTickets } from "./tickets/host-tickets.mjs";
