import type { ModelRef } from "../protocol/types";

export type ModelGroup = {
  provider: string;
  models: ModelRef[];
};

function providerKey(model: ModelRef): string {
  const raw = (model.provider || "other").trim();
  return raw.split("/")[0] || raw || "other";
}

/** Display name for a model: never fall back to a raw provider/id when a nickname exists. */
export function modelNickname(
  model: ModelRef | null | undefined,
  models: ModelRef[] = [],
): string {
  if (!model) return "";
  const id = typeof model.id === "string" ? model.id : "";
  const provider = typeof model.provider === "string" ? model.provider : "";
  const match = models.find(
    (candidate) =>
      candidate.id === id &&
      (!provider || !candidate.provider || candidate.provider === provider),
  );
  const name = (match?.name ?? model.name ?? "").trim();
  if (name) return name;
  const tail = id.split("/").filter(Boolean).pop() ?? id;
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
