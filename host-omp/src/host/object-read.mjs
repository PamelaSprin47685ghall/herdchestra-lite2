/**
 * Shared host primitives: the two readers every host module needs, plus the
 * record test the frame observers share.
 *
 * `read` answers "does this host object expose this property?" without letting a
 * throwing getter escape, `isNonEmptyString` is the one string test, and
 * `isObject` is the one record test: non-null, not an array.
 *
 * These are deliberately narrow. `capture.mjs` keeps its own callable-accepting
 * object test because a host seam can be a function object; folding the two
 * would either let a non-record into the frame observers or drop a seam.
 * `digest` is not here either: the frame digest throws on an unrepresentable
 * value while the provider hash returns null, because one guards a capture and
 * the other guards a record.
 */

/** A property read that treats a throwing getter as an absent property. */
export function read(target, key) {
	if (!target || typeof target !== "object") return undefined;
	try {
		return target[key];
	} catch {
		return undefined;
	}
}

/** True for a string with at least one character. */
export function isNonEmptyString(value) {
	return typeof value === "string" && value !== "";
}

/** True for a non-null, non-array object: a record, not a list or a callable. */
export function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
