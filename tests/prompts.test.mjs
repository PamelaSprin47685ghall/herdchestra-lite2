import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import { wireTools } from "../src/tools/catalog.mjs";
import { loadDoc, placeholderNames, render } from "../src/prompts/index.mjs";
import * as scopeTools from "../src/tools/descriptions.mjs";
import * as todoTools from "../src/tools/todo-description.mjs";
import {
	injectSystemPrompt,
	persistentOperatingSkill,
} from "../src/prompts/inject.mjs";
import { inlinedSkills, SKILL_NAMES } from "../src/prompts/skills.mjs";

const DOCS = [
	"tools/fork-join",
	"tools/notes",
	"tools/todo",
	"system",
	"receipts/scope",
	"receipts/relay",
	"errors",
	"vibe-mode",
	"labels",
];

const START = "<!-- herdchestra-lite2:system-prompt v1 -->";
const END = "<!-- /herdchestra-lite2:system-prompt -->";

describe("prompt documents", () => {
	test("load with non-empty sections", () => {
		for (const name of DOCS) {
			const doc = loadDoc(name);
			expect(Object.keys(doc).length).toBeGreaterThan(0);
			for (const text of Object.values(doc)) {
				expect(typeof text).toBe("string");
				expect(text.length).toBeGreaterThan(0);
			}
		}
	});

	test("are frozen and cached", () => {
		const first = loadDoc("tools/fork-join");
		expect(Object.isFrozen(first)).toBe(true);
		expect(loadDoc("tools/fork-join")).toBe(first);
	});

	test("reject a missing document and an invalid name", () => {
		expect(() => loadDoc("nope/missing")).toThrow(/Missing prompt document/);
		expect(() => loadDoc("../etc/passwd")).toThrow(/Invalid prompt document name/);
	});
});

describe("tool contracts map to their documents", () => {
	test("a nested fork is funded by its item, not the caller's balance", () => {
		const budget = loadDoc("tools/fork-join")["fork.budget"];
		expect(budget).toContain("each item funds its own child at any depth");
		expect(budget).toContain("never charged");
		expect(budget).not.toContain("draws from that flow's remaining balance");
	});

	test("the panhandle description points at the fork that avoids it", () => {
		expect(loadDoc("tools/panhandle")["panhandle.tool"]).toContain("`scope_fork`");
	});

	test("the three fork/join tools carry their mapped text", () => {
		const doc = loadDoc("tools/fork-join");
		const notes = loadDoc("tools/notes");
		expect(scopeTools.FORK_DESCRIPTION).toBe(doc["fork.tool"]);
		expect(scopeTools.FORK_INTENT_DESCRIPTION).toBe(doc["fork.intent"]);
		expect(scopeTools.FORK_BUDGET_DESCRIPTION).toBe(doc["fork.budget"]);
		expect(scopeTools.FORK_TIME_DESCRIPTION).toBeUndefined();
		expect(scopeTools.JOIN_DESCRIPTION).toBe(doc["join.tool"]);
		// join takes no argument: the child record arrives as a digest, so no
		// elder_report and no other parameter may survive.
		expect(scopeTools.joinParameters).toBeDefined();
		expect(scopeTools.joinParameters.required).toBeUndefined();
		expect(scopeTools.joinParameters.properties).not.toHaveProperty("elder_report");
		expect(scopeTools.RETURN_DESCRIPTION).toBe(doc["return.tool"]);
		// The retired working-level container has no description and no
		// schema; amend and pin live in their own document.
		expect(scopeTools.SCOPE_DESCRIPTION).toBeUndefined();
		expect(scopeTools.scopeParameters).toBeUndefined();
		expect(scopeTools.SCOPE_CONTEXT_DESCRIPTION).toBe(notes["scope_context.tool"]);
		expect(scopeTools.AMEND_PARAMETER_DESCRIPTION).toBe(notes["amend.tool"]);
		expect(scopeTools.REFLECTION_DESCRIPTION).toBe(notes["amend.reflection"]);
		expect(scopeTools.PIN_PARAMETER_DESCRIPTION).toBe(notes["pin.tool"]);
		expect(scopeTools.PIN_ASSUMPTION_DESCRIPTION).toBe(notes["pin.assumption"]);
		expect(scopeTools.PIN_DEDUCTION_DESCRIPTION).toBe(notes["pin.deduction"]);
		expect(scopeTools.PIN_INDUCTION_DESCRIPTION).toBe(notes["pin.induction"]);
		expect(scopeTools.PIN_FINDING_DESCRIPTION).toBe(notes["pin.finding"]);
		expect(scopeTools.PIN_CONCLUSION_DESCRIPTION).toBe(notes["pin.conclusion"]);
	});

	test("todo", () => {
		const doc = loadDoc("tools/todo");
		expect(todoTools.TODO_DESCRIPTION).toBe(doc.tool);
		expect(todoTools.TODO_OP_DESCRIPTION).toBe(doc.op);
		expect(todoTools.TODO_LIST_DESCRIPTION).toBe(doc.list);
		expect(todoTools.TODO_TASK_DESCRIPTION).toBe(doc.task);
		expect(todoTools.TODO_PHASE_DESCRIPTION).toBe(doc.phase);
		expect(todoTools.TODO_ITEMS_DESCRIPTION).toBe(doc.items);
		expect(todoTools.TODO_REASON_DESCRIPTION).toBe(doc.reason);
	});

	test("the registered scope name rules prevent case-only collisions and reserved names", () => {
		const tools = new Map();
		wireTools({ registerTool: (tool) => tools.set(tool.name, tool) }, {});
		const item = tools.get("scope_fork").parameters.properties.forks.items;
		const { description } = item.properties.scopeId;
		expect(description).toMatch(/\broot`? is reserved\b[^.]*\b(?:any capitalization|regardless of case|case-insensitive)\b/i);
		expect(description).toMatch(/amends? that scope/i);
		expect(description).toContain("only its owner");
		expect(description).toMatch(/case-insensitive/i);
		expect(description).not.toMatch(/must be unique/i);
	});

	test("schemas carry the mapped text", () => {
		const doc = loadDoc("tools/fork-join");
		const item = scopeTools.forkParameters.properties.forks.items;
		expect(item.required).toEqual(["scopeId", "blocked", "budget", "targets"]);
		expect(item.required).not.toContain("intent");
		expect(item.properties.intent.description).toBe(doc["fork.intent"]);
		expect(item.properties.budget.description).toBe(doc["fork.budget"]);
		expect(item.properties.time).toBeUndefined();
		expect(item.properties.targets.description).toBe(doc["fork.targets"]);
		expect(item.properties).not.toHaveProperty("stage");
		expect(item.properties).not.toHaveProperty("fission");
		expect(item.properties).not.toHaveProperty("permission");
		expect(scopeTools.scopeContextParameters.properties.amend.properties.reflection.description).toBe(
			loadDoc("tools/notes")["amend.reflection"],
		);
		const todo = loadDoc("tools/todo");
		expect(
			todoTools.TODO_PARAMETERS.properties.list.items.properties.items.description,
		).toBe(todo["list.item"]);
	});
});

describe("system prompts map to their documents", () => {
	test("system pieces", () => {
		const doc = loadDoc("system");
		expect(doc["common-rules"]).toBeUndefined();
		expect(persistentOperatingSkill).toBe(doc["persistent-rules"]);
		expect(persistentOperatingSkill).toContain("强制以简体中文");
		expect(persistentOperatingSkill).toContain("inlined below");
		for (const name of SKILL_NAMES) {
			expect(persistentOperatingSkill).toContain(name);
			expect(persistentOperatingSkill).not.toContain(`skill://${name}`);
		}
	});

	test("stage guidance ships as inlined skills, not a prompt block", () => {
		expect(SKILL_NAMES).toEqual([
			"constitution",
			"decision-framing",
			"polish",
			"prompt-craft",
			"skill-authoring",
			"tdd-crowdsource",
		]);
		expect(persistentOperatingSkill).toMatch(/project skills are inlined below/);
		expect(persistentOperatingSkill).toContain("the runtime enforces no stage gate");
		expect(persistentOperatingSkill).not.toContain("Stage Prompts block");
	});

	test("constitution is a shipped skill with a loadable description", () => {
		const text = readFileSync(
			new URL("../resources/skills/constitution/SKILL.md", import.meta.url),
			"utf8",
		);
		expect(text.startsWith("---\nname: constitution\n")).toBe(true);
		expect(text).toContain("description:");
		expect(text).toContain("Read before work.");
		const body = inlinedSkills.find((skill) => skill.name === "constitution").body;
		expect(body.startsWith("# Constitution")).toBe(true);
		expect(body.startsWith("---")).toBe(false);
	});

	test("every skill the persistent rules name is inlined", () => {
		const shipped = readdirSync(new URL("../resources/skills/", import.meta.url), {
			withFileTypes: true,
		})
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		expect(shipped).toEqual([...SKILL_NAMES]);

		const list = persistentOperatingSkill.match(
			/Six project skills are inlined below: ([^.]+)\./,
		);
		expect(list).not.toBeNull();
		const named = list[1]
			.replace(/, and /g, ", ")
			.split(",")
			.map((name) => name.trim())
			.sort();
		expect(named).toEqual(shipped);

		for (const name of shipped) {
			expect(persistentOperatingSkill).not.toContain(`skill://${name}`);
		}
	});

	test("task nature is documented in the system prompt, not repeated by todo", () => {
		const todo = loadDoc("tools/todo");
		expect(persistentOperatingSkill).toContain("Choose by task nature.");
		expect(persistentOperatingSkill).toContain("A refactor counts as development:");
		expect(persistentOperatingSkill).toContain("in principle submit a ledger");
		expect(persistentOperatingSkill).toContain("in principle do not submit one");
		expect(persistentOperatingSkill).toContain("let that judgment override the default");
		expect(todo.tool).not.toContain("Choose by task nature.");
	});

	test("every level hears the free-fork tip before the handout", () => {
		expect(persistentOperatingSkill).toContain("Every level, root included");
		expect(persistentOperatingSkill).toContain("Word to the wise, at every depth");
		expect(persistentOperatingSkill).toContain(
			"Plan the split the moment the task arrives",
		);
		expect(persistentOperatingSkill).toContain("already started cramming");
		expect(persistentOperatingSkill).toContain("forking is cheaper than any handout");
	});

	test("an exhausted budget names the free fork before the handout", () => {
		const text = loadDoc("errors")["tool-budget-exhausted"];
		expect(text).toContain("scope_fork");
		expect(text.indexOf("scope_fork")).toBeLessThan(text.indexOf("scope_panhandle"));
	});

	test("a built-in protocol read or write is free wherever the budget is explained", () => {
		expect(persistentOperatingSkill).toContain("built-in protocol URI");
		expect(persistentOperatingSkill).toContain("no tool point, at any depth");
		expect(persistentOperatingSkill).not.toContain("may read `skill://` paths");
		expect(loadDoc("tools/fork-join")["fork.budget"]).toContain(
			"is free at any depth, so it needs no entry either",
		);
		expect(loadDoc("errors")["root-has-no-budget"]).toContain(
			"built-in protocol URI",
		);
	});
});

describe("template rendering", () => {
	test("finds placeholders and fills them", () => {
		const template = "a {{x}} b {{y}}";
		expect(placeholderNames(template)).toEqual(["x", "y"]);
		expect(render(template, { x: 1, y: "two" })).toBe("a 1 b two");
	});

	test("throws instead of rendering a half sentence", () => {
		expect(() => render("a {{x}}", {})).toThrow(/Missing prompt variable: x/);
	});
});

describe("inlined skills", () => {
	test("every body appears exactly once and reinjection is byte-identical", () => {
		const first = injectSystemPrompt("Host prompt.");
		for (const { name, body } of inlinedSkills) {
			expect(first.split(body)).toHaveLength(2);
			expect(first).toContain(`<inlined-skill name="${name}">`);
		}
		expect(injectSystemPrompt(first)).toBe(first);

		const array = injectSystemPrompt(["Host prompt."]);
		const text = array.join("\n");
		for (const { body } of inlinedSkills) expect(text.split(body)).toHaveLength(2);
		expect(injectSystemPrompt(array)).toEqual(array);
	});

	test("frontmatter stays on disk and is stripped from the injected body", () => {
		for (const { name, body } of inlinedSkills) {
			expect(body.startsWith("---")).toBe(false);
			expect(body.startsWith("# ")).toBe(true);
			const file = readFileSync(
				new URL(`../resources/skills/${name}/SKILL.md`, import.meta.url),
				"utf8",
			);
			expect(file.startsWith("---\n")).toBe(true);
		}
	});
});

describe("injectSystemPrompt", () => {
	test("injects the managed block once and is idempotent", () => {
		const output = injectSystemPrompt("Host prompt.");
		expect(output.startsWith(`${START}\n`)).toBe(true);
		expect(output.endsWith(`${END}\n\nHost prompt.`)).toBe(true);
		const again = injectSystemPrompt(output);
		expect(again).toBe(output);
	});

	test("replaces a stale managed block", () => {
		const stale = `Intro.\n\n${START}\nSTALE\n${END}\n\nBody.`;
		const output = injectSystemPrompt(stale);
		expect(output).not.toContain("STALE");
		expect(output).toContain(persistentOperatingSkill);
		expect(output.startsWith("Intro.\n\n")).toBe(true);
		expect(output.endsWith(`${END}\n\nBody.`)).toBe(true);
	});

	test("does not repeat repo rules the host prompt already carries", () => {
		const host = "# Repo-aware Rules\n\nAlready here.";
		const output = injectSystemPrompt(host);
		expect(output).toContain(persistentOperatingSkill);
		expect(output.split("# Repo-aware Rules").length - 1).toBe(1);
	});

	test("prepends one block to an array without mutating it", () => {
		const host = ["First block.", "Second block."];
		const output = injectSystemPrompt(host);
		expect(Array.isArray(output)).toBe(true);
		expect(output.length).toBe(3);
		expect(output.slice(1)).toEqual(host);
		expect(host).toEqual(["First block.", "Second block."]);
		expect(injectSystemPrompt(output)).toEqual(output);
	});

	test("returns non-string, non-array input unchanged", () => {
		const value = { prompt: "Host prompt." };
		expect(injectSystemPrompt(value)).toBe(value);
		expect(injectSystemPrompt(null)).toBe(null);
	});

	test("keeps each mode's rules inside a skill element", () => {
		for (const autopilot of [true, false]) {
			const text = injectSystemPrompt("Host prompt.", { autopilot });
			const modeAt = text.indexOf("### Close the work");
			const lastOpen = text.lastIndexOf("<skill");
			const lastClose = text.lastIndexOf("</skill>");

			expect(modeAt).toBeGreaterThan(lastOpen);
			expect(modeAt).toBeLessThan(lastClose);
			expect((text.match(/<skill\b/g) ?? []).length).toBe(
				(text.match(/<\/skill>/g) ?? []).length,
			);
			expect(text).toContain(persistentOperatingSkill);
			expect(text.endsWith(`${END}\n\nHost prompt.`)).toBe(true);
		}
	});
});

describe("fork item schema", () => {
	test("does not ask the model for a time budget", () => {
		const item = scopeTools.forkParameters.properties.forks.items;
		expect(item.required).not.toContain("time");
		expect(item.properties.time).toBeUndefined();
		expect(loadDoc("tools/fork-join")["fork.time"]).toContain("Do not pass `time`");
	});

	test("a reused scopeId amends, and intent may be omitted", () => {
		const item = scopeTools.forkParameters.properties.forks.items;
		expect(item.required).toEqual(["scopeId", "blocked", "budget", "targets"]);
		expect(item.required).not.toContain("intent");
		expect(item.properties.intent.description).toMatch(/next turn boundary/i);
		expect(item.properties.scopeId.description).toMatch(/ready.*supersedes/i);
		expect(item.properties.scopeId.description).toMatch(/joined.*failed.*new generation/i);
	});

	test("reuse errors replace duplicate-scope-id", () => {
		const errors = loadDoc("errors");
		expect(errors["duplicate-scope-id"]).toBeUndefined();
		for (const key of [
			"missing-intent",
			"foreign-scope-id",
			"scope-running-blocked",
			"scope-reuse-empty",
			"scope-not-amendable",
		]) {
			expect(typeof errors[key]).toBe("string");
			expect(errors[key].length).toBeGreaterThan(0);
		}
	});
});
