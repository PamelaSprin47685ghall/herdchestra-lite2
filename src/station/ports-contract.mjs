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
	"pin",
	"amend",
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
