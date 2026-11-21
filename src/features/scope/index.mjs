// Scope implementation table for the composition root.
//
// Three shapes, one port. `bare` takes nothing; `single` owns one container on
// the current session; `batch` owns many and needs the batch registry handed to
// it, which is why it takes a factory rather than being a bare object.

export { createBareScope, scopeRefusal, SCOPE_PORT } from "./bare.mjs";
export { createSingleScope } from "./single.mjs";
export { createBatchScope } from "./batch.mjs";

import { createBareScope } from "./bare.mjs";
import { createBatchScope } from "./batch.mjs";
import { createSingleScope } from "./single.mjs";

/**
 * Build the three implementations.
 *
 * `registerBatch` is optional: without it the batch implementation still
 * exists and refuses, which is what lets the contract suite run against all
 * three without inventing a station.
 */
export function createScopeImplementations(extras = {}) {
	return {
		bare: createBareScope(),
		single: createSingleScope(),
		batch: createBatchScope({ registerBatch: extras.registerBatch }),
	};
}
