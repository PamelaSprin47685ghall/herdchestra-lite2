import { describe, expect, test } from "bun:test";
import {
  commonCoreRules,
  commonRulesText,
  injectSystemPrompt,
  languageSkill,
  outsideScopeInstruction,
  persistentOperatingSkill,
  rewriteVibeModeContext,
} from "../src/host/index.mjs";
import { BUDGET_DESCRIPTION } from "../src/tools/index.mjs";

const HEADING = "# Repo-aware Rules";
const START = "<!-- herdchestra-lite2:system-prompt v1 -->";
const END = "<!-- /herdchestra-lite2:system-prompt -->";
const BLOCK = `${START}\n${commonRulesText}\n\n${persistentOperatingSkill}\n${END}`;

describe("languageSkill", () => {
  test("holds the exact Chinese instruction now carried by the system prompt", () => {
    expect(languageSkill).toBe(
      '<skill version="1.0">(Routine reminder appended by the host extension at the end of every turn; not a new user message. Continue the current work.) 强制以简体中文思考，尤其要以简体中文词开头。强制简体中文回答用户。</skill>',
    );
  });

  test("has one skill element and no surrounding whitespace", () => {
    expect(languageSkill.startsWith('<skill version="1.0">')).toBe(true);
    expect(languageSkill.endsWith("</skill>")).toBe(true);
    expect(languageSkill).toBe(languageSkill.trim());
    expect(languageSkill.split("<skill").length - 1).toBe(1);
  });
});

describe("persistentOperatingSkill", () => {
  test("carries the static rules and Chinese instruction in the system prompt", () => {
    expect(persistentOperatingSkill).toContain("强制以简体中文思考");
    expect(persistentOperatingSkill).toContain("scope({ end: true })");
    expect(persistentOperatingSkill).toContain("evaluate the ledger with todo");
    expect(persistentOperatingSkill.split('<skill version="1.0">').length - 1).toBe(1);
  });
});

describe("BUDGET_DESCRIPTION", () => {
  test("explains one shared unit per assistant turn", () => {
    expect(BUDGET_DESCRIPTION).toContain("assistant turns");
    expect(BUDGET_DESCRIPTION).toContain("two decimals");
  });
});

describe("outsideScopeInstruction", () => {
  test("is the exact instruction for work outside every scope", () => {
    expect(outsideScopeInstruction).toBe(
      "You are outside all scopes. Only todo and the free control tools (scope, regret, defer, pin) may be called here; todo is the only functional tool allowed outside a scope and it is forbidden inside every scope. Before stopping, call todo outside all scopes to evaluate the ledger: a non-empty ledger forbids a natural stop; an empty ledger triggers a relay handoff (write the handoff report in your message body with no tool calls, followed by a compaction boundary for a successor) whose first todo evaluation must also be empty. Only that promotion allows the final user-facing answer as ordinary assistant text. Close a scope with scope({ end: true }); no report is written at close time. When you open another sibling scope at this level, pass the prior scope's summary in begin.elder_report; if none is pending, pass null. Finishing is not a tool call, and there is no finish tool.",
    );
  });
});

describe("commonRulesText", () => {
  test("starts with the repo-aware heading followed by a blank line", () => {
    expect(commonRulesText.startsWith(`${HEADING}\n\n`)).toBe(true);
  });

  test("is the heading plus the 11 core paragraphs", () => {
    expect(commonCoreRules.length).toBe(11);
    expect(commonRulesText).toBe([HEADING, ...commonCoreRules].join("\n\n"));
    expect(commonRulesText.split("\n\n").length).toBe(12);
  });

  test("keeps the 11 core rule markers in order", () => {
    const tags = commonCoreRules.slice(1).map((paragraph) => paragraph.slice(0, paragraph.indexOf("]") + 1));
    expect(tags).toEqual([
      "[instructions]",
      "[engineering]",
      "[communication]",
      "[team]",
      "[execution]",
      "[candor]",
      "[epistemics]",
      "[flow]",
      "[introspection]",
      "[courage]",
    ]);
    expect((commonRulesText.match(/^\[[a-z]+\] /gm) ?? []).length).toBe(10);
    expect(commonRulesText).toContain(
      "You are in repo-aware mode. Obey the following repo-aware rules (AGENTS.md) as much as possible.",
    );
  });

  test("has one physical line per paragraph", () => {
    for (const paragraph of commonCoreRules) {
      expect(paragraph.length).toBeGreaterThan(0);
      expect(paragraph.includes("\n")).toBe(false);
      expect(paragraph).toBe(paragraph.trim());
    }
  });

  test("carries no scope mechanics, no sandbox promise note, no UFSS note", () => {
    expect(commonRulesText).not.toContain("scope({");
    expect(commonRulesText).not.toContain("regret");
    expect(commonRulesText).not.toContain("defer(");
    expect(commonRulesText).not.toContain("BUDGET_EXHAUSTED");
    expect(commonRulesText).not.toContain("You are now inside this scope.");
    expect(commonRulesText).not.toMatch(/sandbox|promesa|UFSS/i);
    expect(commonRulesText).not.toContain("All sandbox capabilities return js/Promise");
    expect(commonRulesText).not.toContain("Universal Fence-Scaled String");
  });

  test("the only defer is the plain verb inside the execution rule", () => {
    expect(commonRulesText.match(/defer/g)).toEqual(["defer"]);
    expect(commonRulesText).toContain("never silently drop, defer, or shrink the intended scope");
  });
});

describe("rewriteVibeModeContext", () => {
  test("rewrites both known sentences", () => {
    const input =
      "You drive two worker CLIs. Run sessions concurrently — normally one `fast` and one `good` on different workstreams.";
    const output = rewriteVibeModeContext(input);

    expect(output).toContain("direct as many parallel slice/swarm workers as causality allows");
    expect(output).toContain(
      "Run independent workstreams concurrently. For decomposable work, use more and more workers aggressively.",
    );
    expect(output).not.toContain("drive two worker CLIs");
    expect(output).not.toContain("normally one `fast` and one `good`");
  });

  test("rewrites every occurrence, not only the first", () => {
    const input = "drive two worker CLIs and drive two worker CLIs";
    const output = rewriteVibeModeContext(input);
    expect(output).toBe(
      "direct as many parallel slice/swarm workers as causality allows and direct as many parallel slice/swarm workers as causality allows",
    );
  });

  test("leaves near misses unchanged", () => {
    const cases = [
      "Drive two worker CLIs",
      "drive two worker CLI",
      "drives two worker CLIs",
      "drive two worker",
      "Run sessions concurrently - normally one `fast` and one `good` on different workstreams.",
      "Run sessions concurrently — normally one `fast` and one `good` on the same workstream.",
      "Run sessions concurrently — normally one `good` and one `fast` on different workstreams.",
      "run sessions concurrently — normally one `fast` and one `good` on different workstreams.",
    ];
    for (const text of cases) {
      expect(rewriteVibeModeContext(text)).toBe(text);
    }
  });

  test("returns the same value for a string with nothing to rewrite", () => {
    const text = "Unrelated vibe-mode context.";
    expect(rewriteVibeModeContext(text)).toBe(text);
  });

  test("hands back non-string input unchanged", () => {
    const value = { content: "drive two worker CLIs" };
    expect(rewriteVibeModeContext(value)).toBe(value);
    expect(rewriteVibeModeContext(null)).toBe(null);
    expect(rewriteVibeModeContext(undefined)).toBe(undefined);
    expect(rewriteVibeModeContext(7)).toBe(7);
  });
});

describe("injectSystemPrompt with a string", () => {
  test("prepends the managed block before the host prompt", () => {
    const output = injectSystemPrompt("You are a helpful agent.");

    expect(output.startsWith(`${START}\n`)).toBe(true);
    expect(output).toContain(commonRulesText);
    expect(output.endsWith(`${END}\n\nYou are a helpful agent.`)).toBe(true);
    expect(output.split(START).length - 1).toBe(1);
    expect(output.split(END).length - 1).toBe(1);
  });

  test("is idempotent", () => {
    const once = injectSystemPrompt("Host system prompt.");
    const twice = injectSystemPrompt(once);
    expect(twice).toBe(once);
  });

  test("leaves a host prompt that already carries the rules but not our markers", () => {
    const hostPrompt = `${HEADING}\n\nSomebody else's rules.`;
    const output = injectSystemPrompt(hostPrompt);

    expect(output).toBe(hostPrompt);
    expect(output).not.toContain(START);
  });

  test("replaces a stale managed block in place", () => {
    const stale = `Host intro.\n\n${START}\nSTALE-BLOCK-CONTENT\n${END}\n\nHost body.`;
    const output = injectSystemPrompt(stale);

    expect(output.startsWith("Host intro.\n\n")).toBe(true);
    expect(output).toContain(commonRulesText);
    expect(output).not.toContain("STALE-BLOCK-CONTENT");
    expect(output.endsWith(`${END}\n\nHost body.`)).toBe(true);
    expect(injectSystemPrompt(output)).toBe(output);
  });

  test("keeps text unchanged when only the start marker is present", () => {
    const broken = `${START}\nno closing marker`;
    expect(injectSystemPrompt(broken)).toBe(broken);
  });

  test("uses the lite2 markers, never the legacy herd markers", () => {
    const output = injectSystemPrompt("Host prompt.");
    expect(output).toContain("<!-- herdchestra-lite2:system-prompt v1 -->");
    expect(output).not.toContain("<!-- herdchestra:system-prompt v1 -->");
  });
});

describe("injectSystemPrompt with an array", () => {
  test("prepends the managed block as one new first element", () => {
    const host = ["First block.", "Second block."];
    const output = injectSystemPrompt(host);

    expect(Array.isArray(output)).toBe(true);
    expect(output.length).toBe(3);
    expect(output[0]).toBe(BLOCK);
    expect(output.slice(1)).toEqual(host);
  });

  test("does not mutate the host array", () => {
    const host = ["First block.", "Second block."];
    injectSystemPrompt(host);
    expect(host).toEqual(["First block.", "Second block."]);
  });

  test("is idempotent", () => {
    const once = injectSystemPrompt(["First block.", "Second block."]);
    const twice = injectSystemPrompt(once);
    expect(twice).toBe(once);
  });

  test("leaves an array that already carries the rules but not our markers", () => {
    const host = ["First block.", `${HEADING}\nbody`];
    expect(injectSystemPrompt(host)).toBe(host);
    expect(injectSystemPrompt(host).join("\n")).not.toContain(START);
  });

  test("replaces a stale managed block in the middle of the array", () => {
    const stale = ["First block.", `${START}\nSTALE-BLOCK-CONTENT\n${END}`, "Last block."];
    const output = injectSystemPrompt(stale);

    expect(output.length).toBe(3);
    expect(output[0]).toBe("First block.");
    expect(output[1]).toBe(BLOCK);
    expect(output[2]).toBe("Last block.");
    expect(output.join("\n")).not.toContain("STALE-BLOCK-CONTENT");
  });

  test("keeps non-string array entries untouched", () => {
    const host = [1, null, "text"];
    const output = injectSystemPrompt(host);
    expect(output).toEqual([BLOCK, 1, null, "text"]);
  });
});

describe("injectSystemPrompt with other input", () => {
  test("returns non-string, non-array input unchanged", () => {
    const value = { prompt: "Host prompt." };
    expect(injectSystemPrompt(value)).toBe(value);
    expect(injectSystemPrompt(null)).toBe(null);
    expect(injectSystemPrompt(undefined)).toBe(undefined);
    expect(injectSystemPrompt(42)).toBe(42);
  });
});
