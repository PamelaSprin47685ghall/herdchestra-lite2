// Pure meta-patch normalization. The Station receives `model_change` events
// whose model arrives as a string or as `{ model }`, and host readbacks that
// may use `id` or `modelId`; this module folds both into one shape before the
// Station commits. No state is read or written here.

export function normalizeMetaPatch(patch) {
  const next = { ...(patch ?? {}) };
  if (next.model !== undefined) {
    const raw = next.model;
    const text = typeof raw === "string"
      ? raw
      : typeof raw?.model === "string"
        ? raw.model
        : null;
    if (text) {
      const slash = text.indexOf("/");
      next.model = slash > 0
        ? { provider: text.slice(0, slash), id: text.slice(slash + 1) }
        : { provider: raw?.provider ?? "", id: text };
    } else if (raw && typeof raw === "object") {
      const id = typeof raw.id === "string" ? raw.id : typeof raw.modelId === "string" ? raw.modelId : null;
      if (id) next.model = { provider: raw.provider ?? "", id };
    }
  }
  if (next.thinkingLevel === undefined && next.level !== undefined) next.thinkingLevel = next.level;
  if (next.thinkingLevel !== undefined) delete next.level;
  return next;
}
