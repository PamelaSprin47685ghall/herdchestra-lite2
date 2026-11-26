// One plain-data predicate for the scope package. Pure, no imports, so both
// the state module and the bracket ledger reach it without a cycle.
//
// "Plain" is a shape, not a realm. The `js` tool compiles model code in its own
// `vm` context, so a budget or a payload built there carries that context's
// `Object.prototype`; comparing against this realm's `Object.prototype`
// refused every fork issued from inside a script. What must stay refused is the
// class instance, the Date, the Map, the array: each has a prototype with
// something above it.

function isPlainObject(value) {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto === null) return true;
  // `Object.prototype` of any realm is itself a plain object whose prototype is
  // null, so a literal's chain ends one link above the literal.
  return Object.getPrototypeOf(proto) === null;
}

export { isPlainObject };
