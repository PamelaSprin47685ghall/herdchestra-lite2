// Shared data primitives: shape predicates, result constructors, and amount
// rendering. One home for the helpers that the scope, relay and station layers
// all need, so a fix in one place reaches every caller.
//
// Pure functions only: no imports, no state, no I/O.

// -- Shape predicates -------------------------------------------------------

// "Plain" is a shape, not a realm. The `js` tool compiles model code in its own
// `vm` context, so a budget or a payload built there carries that context's
// `Object.prototype`; comparing against this realm's `Object.prototype` refused
// every fork issued from inside a script. What must stay refused is the class
// instance, the Date, the Map, the array: each has a prototype with something
// above it.
function isPlainObject(value) {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	if (proto === null) return true;
	// `Object.prototype` of any realm is itself a plain object whose prototype is
	// null, so a literal's chain ends one link above the literal.
	return Object.getPrototypeOf(proto) === null;
}

// The strict predicate for values this process built itself: the prototype must
// be this realm's `Object.prototype`. Use it at a serialization boundary, where
// a value from another realm means the payload crossed a boundary it should not
// have. `relay/state.mjs` keeps this meaning for its own `isPlainObject`.
function isLocalPlainObject(value) {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

// -- Small value predicates -------------------------------------------------

function isNonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "";
}

// -- Result constructors ----------------------------------------------------

// A refused decision. `details` is omitted from the object when the caller did
// not supply one, so a two-argument result keeps the exact same shape as before.
function failure(code, reason, details) {
	const out = { ok: false, code, reason };
	if (details !== undefined) out.details = details;
	return out;
}

// -- Object helpers ---------------------------------------------------------

// Define an own data property. This is safe for keys such as "__proto__".
function put(object, key, value) {
	Object.defineProperty(object, key, {
		value,
		enumerable: true,
		writable: true,
		configurable: true,
	});
}

function copyCounts(source) {
	const out = {};
	if (!isPlainObject(source)) return out;
	for (const key of Reflect.ownKeys(source)) {
		if (typeof key !== "string") continue;
		put(out, key, source[key]);
	}
	return out;
}

// -- Tool budgets -----------------------------------------------------------

// A budget maps a tool name to a whole number of turns. Zero is legal; a
// fractional or negative turn is not.
function validBudget(turns) {
	if (!isPlainObject(turns)) return false;
	for (const tool of Reflect.ownKeys(turns)) {
		if (typeof tool !== "string" || !isNonEmptyString(tool)) return false;
		const amount = turns[tool];
		if (!Number.isInteger(amount) || amount < 0) return false;
	}
	return true;
}

// Normalize tool names: apply_patch → edit. Two spellings of one tool must not
// buy two budgets.
function normalizeBudget(turns) {
	if (!isPlainObject(turns)) return turns;
	const normalized = {};
	for (const key of Reflect.ownKeys(turns)) {
		if (typeof key !== "string") continue;
		const normalizedKey = key === "apply_patch" ? "edit" : key;
		const currentValue = Object.hasOwn(normalized, normalizedKey)
			? normalized[normalizedKey]
			: 0;
		put(normalized, normalizedKey, currentValue + turns[key]);
	}
	return normalized;
}

// -- Amounts ----------------------------------------------------------------

// Charge amounts are real numbers with at most two decimal places.
function roundAmount(value) {
	return Math.round(value * 100) / 100;
}

// Fixed two-decimal display precision: a charge always shows both decimals.
function formatCents(value) {
	return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

// Trimmed display: `2` for integers, `2.5` at cent precision.
function formatUnits(value) {
	if (!Number.isFinite(value)) return "0";
	return String(roundAmount(value));
}

export {
	isPlainObject,
	isLocalPlainObject,
	isNonEmptyString,
	failure,
	put,
	copyCounts,
	validBudget,
	normalizeBudget,
	roundAmount,
	formatCents,
	formatUnits,
};
