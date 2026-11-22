// Model selector resolution for scope_fork.
//
// The host owns model selection and exposes it to an extension as
// `ctx.models`. `resolve(spec)` accepts a provider/id, a bare id, a role
// alias, and a thinking or routing suffix, and returns the base Model: the
// suffix is not part of the answer. A suffix is never split here. The
// level is recovered only when the host's own resolver agrees that the text
// before the level names the same model. A literal id that contains a
// colon-shaped tail therefore wins: `resolve` returns that literal first,
// and the identity check below stops any split.

/** Thinking levels the host accepts as a selector suffix. */
const THINKING_LEVELS = Object.freeze([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** How many ids a refusal may name before it summarizes the rest. */
export const MAX_NAMED_MODELS = 40;

function modelIdOf(model) {
  const id = model?.id ?? model?.model;
  return typeof id === "string" && id !== "" ? id : null;
}

function modelIdentityOf(model) {
  const id = modelIdOf(model);
  if (id === null) return null;
  const provider = typeof model?.provider === "string" && model.provider !== "" ? model.provider : null;
  return provider === null ? id : `${provider}/${id}`;
}

/** Sorted, de-duplicated `${provider}/${id}` list from the host facade. */
export function availableModelIds(query) {
  const listed = typeof query?.list === "function" ? query.list() : null;
  if (!Array.isArray(listed)) return [];
  const seen = new Set();
  for (const model of listed) {
    const identity = modelIdentityOf(model);
    if (identity !== null) seen.add(identity);
  }
  return [...seen].sort();
}

/** One refusal shape: what failed, plus the ids a caller can pick. */
function unknownModel(query, message) {
  const available = availableModelIds(query);
  const named = available.slice(0, MAX_NAMED_MODELS);
  const rest = available.length - named.length;
  const list = named.length === 0 ? "none" : `${named.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`;
  return {
    ok: false,
    code: "MODEL_UNKNOWN",
    message: `${message}; available: ${list}`,
    available: named,
    availableTotal: available.length,
  };
}

function thinkingSuffixOf(query, selector, model) {
  const target = modelIdentityOf(model);
  if (target === null) return null;
  const lowered = selector.toLowerCase();
  for (const level of THINKING_LEVELS) {
    const suffix = `:${level}`;
    if (!lowered.endsWith(suffix)) continue;
    const head = selector.slice(0, selector.length - suffix.length).trim();
    if (head === "") continue;
    const base = query.resolve(head);
    if (base && modelIdentityOf(base) === target) return level;
  }
  return null;
}

/**
 * Resolve one selector against the host facade.
 *
 * Returns `{ ok: true, model, thinkingLevel }`, with `thinkingLevel: null`
 * when the selector names a model without a level, or
 * `{ ok: false, code: "MODEL_UNKNOWN", message, available, availableTotal }`.
 * `model` is the host's own object; callers must not write it.
 */
export function resolveModelSelector(query, selector) {
  const value = typeof selector === "string" ? selector.trim() : "";
  // A blank selector names nothing, so it is refused here rather than left to
  // the host, which would answer undefined and hide the real reason.
  if (value === "") return unknownModel(query, "model must be a non-empty selector");
  if (!query || typeof query.resolve !== "function") {
    return {
      ok: false,
      code: "MODEL_UNKNOWN",
      message: `this host exposes no model query, so "${value}" cannot be resolved; omit model to inherit the parent's`,
      available: [],
      availableTotal: 0,
    };
  }
  const model = query.resolve(value);
  if (!model) return unknownModel(query, `no available model matches "${value}"`);
  const identity = modelIdentityOf(model);
  const bare = modelIdOf(model);
  if (value === identity || value === bare) {
    return { ok: true, model, thinkingLevel: null };
  }
  return { ok: true, model, thinkingLevel: thinkingSuffixOf(query, value, model) };
}
