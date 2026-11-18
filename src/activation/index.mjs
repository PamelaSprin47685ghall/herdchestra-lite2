/**
 * Activation domain index: assemble the extension from stations, hooks, and
 * tools. Mechanical only. No business logic lives here.
 */

import { createStationRegistry, setActiveRegistry } from "../station/index.mjs";
import { buildTickets } from "./tickets.mjs";
import { installCapture } from "./capture.mjs";
import { wireHooks } from "./hooks.mjs";
import { wireTools } from "./tools.mjs";

export { installCapture };

/** Assemble the extension: registry, hooks, tools. Mechanical only. */
export function wireExtension(pi) {
	const registry = createStationRegistry(pi, buildTickets(pi));
	setActiveRegistry(registry);
	wireHooks(pi, registry);
	wireTools(pi, registry);
}
