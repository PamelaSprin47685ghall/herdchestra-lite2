/**
 * The one list of station ports.
 *
 * The composition root (activation/ports.mjs buildPorts) names and builds every
 * entry once. A station consumes the complete bundle; it never names an
 * implementation and never falls back per call, because a second construction
 * path would wire a different system than the one the user asked for.
 */
export const IMPLEMENTATION_KEYS = Object.freeze([
	"clock",
	"herd",
]);

export function missingPortsError(missing) {
	const error = new Error(
		`MISSING_PORTS: the station needs ${missing.join(", ")}`,
	);
	error.code = "MISSING_PORTS";
	error.missing = [...missing];
	return error;
}

/**
 * Resolve the shared ForkRegistry for a station or port-shaped double.
 * Never falls back to `station.registry` (which used to hold StationRegistry
 * and caused split-brain state across extension instances).
 */
export function forkRegistryOf(station) {
	if (!station || typeof station !== "object") return null;
	const direct =
		typeof station.forkRegistry === "function" ? station.forkRegistry() : null;
	if (direct && typeof direct === "object") return direct;
	const fromWait =
		typeof station.forkWaitPort === "function" ? station.forkWaitPort()?.registry : null;
	if (fromWait && typeof fromWait === "object") return fromWait;
	const fromWiring = station.forkWiring?.registry ?? null;
	return fromWiring && typeof fromWiring === "object" ? fromWiring : null;
}
