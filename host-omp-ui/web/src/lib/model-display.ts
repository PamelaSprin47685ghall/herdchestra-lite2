import type { ModelRef } from "../protocol/types";

export type ModelGroup = {
  provider: string;
  models: ModelRef[];
};

export function providerKey(model: ModelRef): string {
  const raw = (model.provider || "other").trim();
  return raw.split("/")[0] || raw || "other";
}

function tailOf(value: string): string {
  return value.split("/").filter(Boolean).pop() ?? value;
}

function providersMatch(a: string, b: string): boolean {
  if (!a || !b) return true;
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function sameModel(candidate: ModelRef, model: ModelRef): boolean {
  const candidateId = typeof candidate.id === "string" ? candidate.id : "";
  const id = typeof model.id === "string" ? model.id : "";
  if (!candidateId || !id) return false;
  const candidateProvider =
    typeof candidate.provider === "string" ? candidate.provider : "";
  const provider = typeof model.provider === "string" ? model.provider : "";
  if (!providersMatch(candidateProvider, provider)) return false;
  return candidateId === id || tailOf(candidateId) === tailOf(id);
}

/** Display name for a model: never fall back to a raw provider/id when a nickname exists. */
export function modelNickname(
  model: ModelRef | null | undefined,
  models: ModelRef[] = [],
): string {
  if (!model) return "";
  const id = typeof model.id === "string" ? model.id : "";
  const provider = typeof model.provider === "string" ? model.provider : "";
  const match = models.find((candidate) => sameModel(candidate, model));
  const fullKey = provider && id ? `${provider}/${id}` : id;
  const name = [match?.name, match?.displayName, match?.label, model.name, model.displayName, model.label]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => value && value !== id && value !== fullKey);
  if (name) return name;
  const tail = tailOf(id);
  return tail || provider || "模型";
}

/** Group models by top-level provider, current provider first, complete lists. */
export function groupModelsByProvider(
  models: ModelRef[],
  current: ModelRef | null | undefined,
): ModelGroup[] {
  const groups = new Map<string, ModelRef[]>();
  for (const model of models) {
    const key = providerKey(model);
    const list = groups.get(key) ?? [];
    list.push(model);
    groups.set(key, list);
  }
  const currentKey = current ? providerKey(current) : "";
  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === currentKey) return -1;
      if (b === currentKey) return 1;
      return a.localeCompare(b, "en");
    })
    .map(([provider, list]) => ({ provider, models: list }));
}

/** Capitalized label for a thinking level: off -> Off, xhigh -> Xhigh. */
export function formatThinkingLabel(level: string | null | undefined): string {
  if (!level) return "";
  return level.charAt(0).toUpperCase() + level.slice(1);
}
