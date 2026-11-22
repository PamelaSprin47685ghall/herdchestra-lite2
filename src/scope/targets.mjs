// Fork targets: natural-language descriptions of what a child scope expects to
// create, read, update, or delete. Each item may name a file path, a source
// region, a behavior, or a goal; any human language is valid. An empty list
// cannot describe a separate scope: a scope with no output has nothing to join.

export function validTargets(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((target) => typeof target === "string" && target.trim() !== "")
  );
}

/** Trim every target and keep its order. Invalid input yields no targets. */
export function normalizeTargets(value) {
  return validTargets(value) ? value.map((target) => target.trim()) : [];
}

/** Render targets for a receipt or replay line. */
export function targetsText(value) {
  const targets = normalizeTargets(value);
  return targets.length > 0 ? targets.join(", ") : "unspecified";
}
