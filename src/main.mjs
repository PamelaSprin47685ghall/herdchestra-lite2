/**
 * Herdchestra Lite 2.0 — omp extension entry.
 *
 * Wiring (wiring.mjs) assembles stations, hooks, and tools. This file only
 * sequences startup: capture host internals, wire the extension, install the
 * status surface.
 */

import { wireExtension, installCapture } from "./wiring.mjs";
import { installStatus } from "./status.mjs";

export async function activate(pi) {
	await installCapture(pi);
	wireExtension(pi);
	installStatus(pi);
}

export default activate;
