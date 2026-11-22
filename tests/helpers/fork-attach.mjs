// Test-only composition of the two production attach phases.
//
// Production wires the registry with attachBaseForkPorts and the composition
// root with bindHostForkPorts. Tests that need one station in one call use
// this helper instead of a production export.

import {
	attachBaseForkPorts,
	bindHostForkPorts,
} from "../../host-omp/src/host/fork-wiring.mjs";

export function attachForkPorts(station, wiring, options = {}) {
	const base = attachBaseForkPorts(station, wiring, options);
	bindHostForkPorts(station, wiring, options);
	return { registry: base.registry, ledger: base.ledger };
}
