import { describe, expect, test } from "bun:test";
import {
  formatThinkingLabel,
  groupModelsByProvider,
  modelNickname,
} from "../../host-omp-ui/web/src/lib/model-display.ts";

const models = [
  { provider: "kw92", id: "kw92/mistral/deepseek-v4-1-flash-1017", name: "DeepSeek V4 Flash" },
  { provider: "kw92", id: "kw92/openai-codex/gpt-6.1-terra", name: "GPT 6.1 Terra" },
  { provider: "kw92", id: "kw92/xai-oauth/grok-4.7", name: "Grok 4.7" },
  { provider: "anthropic", id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" },
];

describe("model display", () => {
  test("modelNickname prefers the model list nickname and never falls back to a bare id", () => {
    expect(modelNickname(models[1], models)).toBe("GPT 6.1 Terra");
    expect(modelNickname({ provider: "kw92", id: "kw92/openai-codex/gpt-6.1-terra" }, models)).toBe(
      "GPT 6.1 Terra",
    );
    expect(modelNickname({ provider: "kw92", id: "kw92/unknown/model" }, models)).toBe("model");
  });

  test("matches a flattened current id to the full catalog id", () => {
    const flat = { provider: "kw92", id: "deepseek-v4-1-flash-1017" };
    expect(modelNickname(flat, models)).toBe("DeepSeek V4 Flash");
  });

  test("ignores a name that is only the raw id", () => {
    const fake = { provider: "zzz", id: "bar/baz", name: "zzz/bar/baz" };
    expect(modelNickname(fake, models)).toBe("baz");
  });

  test("groupModelsByProvider puts the current provider first and keeps every model", () => {
    const groups = groupModelsByProvider(models, models[1]);
    expect(groups[0].provider).toBe("kw92");
    expect(groups[0].models).toHaveLength(3);
    expect(groups.flatMap((group) => group.models)).toHaveLength(models.length);
    expect(groups.map((group) => group.provider)).toEqual(["kw92", "anthropic"]);
  });

  test("formatThinkingLabel capitalizes each level", () => {
    expect(formatThinkingLabel("off")).toBe("Off");
    expect(formatThinkingLabel("medium")).toBe("Medium");
    expect(formatThinkingLabel("xhigh")).toBe("Xhigh");
    expect(formatThinkingLabel(null)).toBe("");
  });
});
