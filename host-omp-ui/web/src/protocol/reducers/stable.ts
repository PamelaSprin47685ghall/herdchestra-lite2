import type { MetaState, ModelRef } from "../types";
import { isRecord } from "../guards";
import {
  normalizeModel,
  normalizeModels,
  normalizeModes,
} from "./normalize";

export function sameModel(
  a: ModelRef | null | undefined,
  b: ModelRef | null | undefined,
): boolean {
  if (!a || !b || a.provider !== b.provider) return false;
  if (a.id === b.id) return true;
  // The host reports the current model with a flattened id while the catalog
  // keeps the full id (`kw92/deepseek-…` vs `kw92/mistral/deepseek-…`). They
  // are the same model; treating them as different lets a one-model snapshot
  // clobber the full catalog and lose every nickname.
  const aTail = a.id.split("/").filter(Boolean).pop() ?? a.id;
  const bTail = b.id.split("/").filter(Boolean).pop() ?? b.id;
  return Boolean(a.id && b.id && aTail === bTail);
}

export function sameStringArray(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

export function sameModes(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

// A snapshot or meta.update may omit capabilities that the host has not
// re-sent yet. Empty values must never erase the last known good selection,
// and equal values must keep their reference so message-only frames cannot
// re-render the model and thinking controls.
export function stableModels(
  next: ModelRef[] | undefined,
  previous: ModelRef[],
): ModelRef[] {
  if (!Array.isArray(next) || next.length === 0) return previous;
  const normalized = normalizeModels(next);
  if (normalized.length === 0) return previous;
  // Some snapshot paths synthesize a one-element list from the selected
  // model. A strict subset of the known list is not a real capability
  // update; keep the full list so the controls do not lose choices.
  if (
    normalized.length < previous.length &&
    normalized.every((entry) =>
      previous.some((known) => sameModel(entry, known)),
    )
  ) {
    return previous;
  }
  if (
    normalized.length === previous.length &&
    normalized.every((entry, index) => sameModel(entry, previous[index]))
  ) {
    return previous;
  }
  return normalized;
}

export function stableModel(
  next: ModelRef | null | undefined,
  previous: ModelRef | null,
): ModelRef | null {
  const normalized = normalizeModel(next);
  if (!normalized) return previous;
  return sameModel(normalized, previous) ? previous : normalized;
}

export function stableText(
  next: string | null | undefined,
  previous: string | null,
): string | null {
  if (typeof next !== "string" || next.trim().length === 0) return previous;
  return next === previous ? previous : next;
}

export function stableStringArray(
  next: string[] | undefined,
  previous: string[] | undefined,
): string[] {
  const before = previous ?? [];
  if (!Array.isArray(next)) return before;
  const normalized = next.map(String);
  if (normalized.length === 0) {
    return before.length === 0 ? before : [];
  }
  return sameStringArray(normalized, before) ? before : normalized;
}

export function stableModes(
  next: Record<string, string> | undefined,
  previous: Record<string, string>,
): Record<string, string> {
  if (!isRecord(next)) return previous;
  const normalized = normalizeModes(next);
  if (Object.keys(normalized).length === 0) return previous;
  return sameModes(normalized, previous) ? previous : normalized;
}

export function stableMeta(
  next: MetaState | undefined,
  previous: MetaState,
): MetaState {
  if (!next) return previous;
  const merged: MetaState = {
    ...previous,
    ...next,
    model: stableModel(next.model, previous.model ?? null),
    thinkingLevel: stableText(next.thinkingLevel, previous.thinkingLevel),
    thinkingLevels: stableStringArray(
      next.thinkingLevels,
      previous.thinkingLevels,
    ),
    modes: stableModes(next.modes, previous.modes),
  };
  const unchanged =
    merged.busy === previous.busy &&
    merged.title === previous.title &&
    merged.fence === previous.fence &&
    merged.model === previous.model &&
    merged.thinkingLevel === previous.thinkingLevel &&
    merged.thinkingLevels === previous.thinkingLevels &&
    merged.modes === previous.modes;
  return unchanged ? previous : merged;
}
