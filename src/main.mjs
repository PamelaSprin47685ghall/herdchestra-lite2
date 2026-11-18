/**
 * Herdchestra Lite 2.0 — omp extension entry.
 *
 * This root only sequences startup: capture host internals, wire the
 * extension, install the status surface. The tree below it is indexed by
 * domain: each directory's index.mjs lists its children's public keys.
 */

import { wireExtension, installCapture } from "./activation/index.mjs";
import { installStatus } from "./host/index.mjs";

export async function activate(pi) {
	await installCapture(pi);
	wireExtension(pi);
	installStatus(pi);
}

export default activate;
