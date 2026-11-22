// scope_fork model selectors: the host resolves, the station refuses before
// any bracket exists. These tests use a facade with the host's documented
// shape (list/resolve) and a station harness with no host attached.

import { describe, expect, test } from "bun:test";

import { createBracketLedger, forkOf } from "../src/scope/forkjoin.mjs";
import {
  MAX_NAMED_MODELS,
  availableModelIds,
  resolveModelSelector,
} from "../src/scope/model-selector.mjs";
import { createState } from "../src/scope/state.mjs";
import { handleForkCall } from "../src/station/fork-controls.mjs";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const MODELS = [
  { provider: "acme", id: "deep" },
  { provider: "acme", id: "fast" },
  { provider: "acme", id: "vendor:exacto" },
  { provider: "beta", id: "fast" },
];

/** A stand-in for the host facade: literal id first, then a suffix strip. */
function hostModels(extra = {}, models = MODELS) {
  return {
    list: () => models,
    resolve: (spec) => {
      if (Object.hasOwn(extra, spec)) return extra[spec];
      const literal = models.find((model) => `${model.provider}/${model.id}` === spec || model.id === spec);
      if (literal) return literal;
      const colon = spec.lastIndexOf(":");
      if (colon <= 0) return undefined;
      const head = spec.slice(0, colon);
      const tail = spec.slice(colon + 1).toLowerCase();
      if (!LEVELS.includes(tail) && tail !== "exacto") return undefined;
      return models.find((model) => `${model.provider}/${model.id}` === head || model.id === head);
    },
  };
}

function stationWith(ledger, spawned) {
  return {
    state: createState(),
    forkLedgerPort: () => ledger,
    childSpawnPort: () => (spec) => spawned.push(spec),
  };
}

function forkOne(station, ctx, overrides = {}) {
  return handleForkCall(
    station,
    {
      id: "fork-call",
      arguments: {
        forks: [
          {
            scopeId: "parser",
            intent: "read the parser",
            blocked: false,
            budget: { read: 1 },
            time: 60,
            permission: "ro",
            ...overrides,
          },
        ],
      },
    },
    { ctx },
  );
}

describe("selector resolution", () => {
  test("resolves a provider/id with no level", () => {
    const out = resolveModelSelector(hostModels(), "acme/deep");
    expect(out.ok).toBe(true);
    expect(out.model).toBe(MODELS[0]);
    expect(out.thinkingLevel).toBeNull();
  });

  test("recovers a thinking level through the host resolver", () => {
    const out = resolveModelSelector(hostModels(), "acme/deep:high");
    expect(out.ok).toBe(true);
    expect(out.model).toBe(MODELS[0]);
    expect(out.thinkingLevel).toBe("high");
  });

  test("keeps a literal id that contains a colon whole", () => {
    const out = resolveModelSelector(hostModels(), "acme/vendor:exacto");
    expect(out.ok).toBe(true);
    expect(out.model).toBe(MODELS[2]);
    expect(out.thinkingLevel).toBeNull();
  });

  test("treats a level-shaped literal id as the id, not a level", () => {
    const models = [{ provider: "acme", id: "flash:high" }];
    const out = resolveModelSelector(hostModels({}, models), "acme/flash:high");
    expect(out.ok).toBe(true);
    expect(out.model).toBe(models[0]);
    expect(out.thinkingLevel).toBeNull();
  });

  test("leaves a routing suffix alone", () => {
    const out = resolveModelSelector(hostModels(), "acme/deep:exacto");
    expect(out.ok).toBe(true);
    expect(out.model).toBe(MODELS[0]);
    expect(out.thinkingLevel).toBeNull();
  });

  test("names the available ids on a miss", () => {
    const out = resolveModelSelector(hostModels(), "gamma/absent");
    expect(out.ok).toBe(false);
    expect(out.code).toBe("MODEL_UNKNOWN");
    expect(out.message).toContain("acme/deep");
    expect(out.available).toEqual(availableModelIds(hostModels()));
    expect(out.availableTotal).toBe(4);
  });

  test("refuses a blank selector and still names the available ids", () => {
    const out = resolveModelSelector(hostModels(), "   ");
    expect(out.ok).toBe(false);
    expect(out.code).toBe("MODEL_UNKNOWN");
    expect(out.message).toContain("acme/deep");
    expect(out.availableTotal).toBe(4);
  });

  test("bounds the named ids while reporting the full total", () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      provider: "p",
      id: `m${String(index).padStart(2, "0")}`,
    }));
    const out = resolveModelSelector(hostModels({}, many), "nope");
    expect(out.ok).toBe(false);
    expect(out.available).toHaveLength(MAX_NAMED_MODELS);
    expect(out.availableTotal).toBe(60);
    expect(out.message).toContain(`and ${60 - MAX_NAMED_MODELS} more`);
  });

  test("refuses when the host exposes no facade", () => {
    const out = resolveModelSelector(undefined, "acme/deep");
    expect(out.ok).toBe(false);
    expect(out.code).toBe("MODEL_UNKNOWN");
    expect(out.message).toContain("no model query");
  });

  test("expands a role alias without inventing a level", () => {
    const out = resolveModelSelector(hostModels({ "@slow": MODELS[1] }), "@slow");
    expect(out.ok).toBe(true);
    expect(out.model).toBe(MODELS[1]);
    expect(out.thinkingLevel).toBeNull();
  });
});

describe("scope_fork passes the resolved model to the spawn spec", () => {
  test("carries the host object and the level, and keeps the raw selector", () => {
    const ledger = createBracketLedger();
    const spawned = [];
    const out = forkOne(stationWith(ledger, spawned), { models: hostModels() }, { model: "acme/deep:high" });
    expect(out.isError).toBeUndefined();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].modelOverride).toBe(MODELS[0]);
    expect(spawned[0].thinkingLevel).toBe("high");
    expect(spawned[0].model).toBe("acme/deep:high");
    expect(forkOf(ledger, "fork-call").model).toBe("acme/deep:high");
  });

  test("omits the override when no model is requested", () => {
    const ledger = createBracketLedger();
    const spawned = [];
    const out = forkOne(stationWith(ledger, spawned), { models: hostModels() });
    expect(out.isError).toBeUndefined();
    expect(spawned[0].modelOverride).toBeUndefined();
    expect(spawned[0].thinkingLevel).toBeUndefined();
  });

  test("refuses an unknown selector before registering the bracket", () => {
    const ledger = createBracketLedger();
    const spawned = [];
    const out = forkOne(stationWith(ledger, spawned), { models: hostModels() }, { model: "gamma/absent" });
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("MODEL_UNKNOWN");
    expect(out.details.available).toContain("acme/deep");
    expect(spawned).toHaveLength(0);
    expect(ledger.order).toEqual([]);
    expect(forkOf(ledger, "fork-call")).toBeNull();
  });

  test("rejects the whole batch when one item's selector is unknown", () => {
    const ledger = createBracketLedger();
    const spawned = [];
    const station = stationWith(ledger, spawned);
    const out = handleForkCall(
      station,
      {
        id: "fork-batch",
        arguments: {
          forks: [
            { scopeId: "one", intent: "first", blocked: false, budget: { read: 1 }, time: 60, permission: "ro", model: "acme/deep" },
            { scopeId: "two", intent: "second", blocked: false, budget: { read: 1 }, time: 60, permission: "ro", model: "gamma/absent" },
          ],
        },
      },
      { ctx: { models: hostModels() } },
    );
    expect(out.isError).toBe(true);
    expect(out.details.index).toBe(1);
    expect(out.content[0].text).toContain("forks[1]");
    expect(spawned).toHaveLength(0);
    expect(ledger.order).toEqual([]);
  });

  test("does not resolve a model on a blocked checkpoint", () => {
    const ledger = createBracketLedger();
    const spawned = [];
    const out = forkOne(stationWith(ledger, spawned), { models: hostModels() }, { blocked: true, model: "gamma/absent" });
    expect(out.isError).toBeUndefined();
    expect(spawned).toHaveLength(0);
    expect(forkOf(ledger, "fork-call").status).toBe("blocked");
  });

  test("refuses a whitespace-only selector before registering the bracket", () => {
    const ledger = createBracketLedger();
    const spawned = [];
    const out = forkOne(stationWith(ledger, spawned), { models: hostModels() }, { model: "   " });
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("MODEL_UNKNOWN");
    expect(out.details.available).toContain("acme/deep");
    expect(spawned).toHaveLength(0);
    expect(ledger.order).toEqual([]);
  });

  test("refuses a selector when the host has no model facade", () => {
    const ledger = createBracketLedger();
    const spawned = [];
    const out = forkOne(stationWith(ledger, spawned), undefined, { model: "acme/deep" });
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("MODEL_UNKNOWN");
    expect(spawned).toHaveLength(0);
    expect(ledger.order).toEqual([]);
  });

  test("never writes the parent session's model", () => {
    const ledger = createBracketLedger();
    const spawned = [];
    const parent = { model: MODELS[0], thinkingLevel: "low" };
    const out = forkOne(stationWith(ledger, spawned), { models: hostModels(), session: parent }, { model: "beta/fast:max" });
    expect(out.isError).toBeUndefined();
    expect(spawned[0].modelOverride).toBe(MODELS[3]);
    expect(spawned[0].thinkingLevel).toBe("max");
    expect(parent.model).toBe(MODELS[0]);
    expect(parent.thinkingLevel).toBe("low");
  });
});
