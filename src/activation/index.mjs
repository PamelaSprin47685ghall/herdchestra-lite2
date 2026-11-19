/**
 * Activation domain index: assemble the extension from stations, hooks, and
 * tools. Mechanical only. No business logic lives here.
 */

import { createStationRegistry, setActiveRegistry } from "../station/index.mjs";
import { wireCommands } from "./commands.mjs";
import { wireHostDiagnosis } from "./diagnosis.mjs";
import { buildTickets } from "./tickets.mjs";
import { installCapture } from "./capture.mjs";
import { wireHooks } from "./hooks.mjs";
import { wireTools } from "./tools.mjs";

export { installCapture };

/** Assemble the extension: registry, hooks, tools, and commands. */
export function wireExtension(pi, pricingCatalog, diagnosis = null) {
	const registry = createStationRegistry(pi, buildTickets(pi), pricingCatalog);
	setActiveRegistry(registry);
	wireHooks(pi, registry);
	wireTools(pi, registry);
	wireCommands(pi, registry);
	wireHostDiagnosis(pi, diagnosis);
}
