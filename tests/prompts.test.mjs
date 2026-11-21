import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";

import { wireTools } from "../src/activation/tools.mjs";
import { loadDoc, placeholderNames, render } from "../src/prompts/index.mjs";
import * as scopeTools from "../src/tools/descriptions.mjs";
import * as todoTools from "../src/tools/todo-description.mjs";
import {
	commonRulesText,
	injectSystemPrompt,
	persistentOperatingSkill,
} from "../src/host/prompts.mjs";

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
	test("the three fork/join tools carry their mapped text", () => {
		const doc = loadDoc("tools/fork-join");
		const notes = loadDoc("tools/notes");
		expect(scopeTools.FORK_DESCRIPTION).toBe(doc["fork.tool"]);
		expect(scopeTools.FORK_INTENT_DESCRIPTION).toBe(doc["fork.intent"]);
		expect(scopeTools.FORK_BUDGET_DESCRIPTION).toBe(doc["fork.budget"]);
		expect(scopeTools.FORK_TIME_DESCRIPTION).toBe(doc["fork.time"]);
		expect(scopeTools.JOIN_DESCRIPTION).toBe(doc["join.tool"]);
		expect(scopeTools.RETURN_DESCRIPTION).toBe(doc["return.tool"]);
		// The retired working-level container has no description and no
		// schema; amend and pin live in their own document.
		expect(scopeTools.SCOPE_DESCRIPTION).toBeUndefined();
		expect(scopeTools.scopeParameters).toBeUndefined();
		expect(scopeTools.AMEND_DESCRIPTION).toBe(notes["amend.tool"]);
		expect(scopeTools.REFLECTION_DESCRIPTION).toBe(notes["amend.reflection"]);
		expect(scopeTools.PIN_DESCRIPTION).toBe(notes["pin.tool"]);
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
		expect(description).toMatch(/\bunique\b[^.]*\b(?:case-insensitive|regardless of case)\b|\bcase-insensitive\b[^.]*\bunique\b/i);
	});

	test("schemas carry the mapped text", () => {
		const doc = loadDoc("tools/fork-join");
		const item = scopeTools.forkParameters.properties.forks.items;
		expect(item.required).toEqual([
			"scopeId",
			"intent",
			"blocked",
			"budget",
			"time",
			"permission",
		]);
		expect(item.properties.intent.description).toBe(doc["fork.intent"]);
		expect(item.properties.budget.description).toBe(doc["fork.budget"]);
		expect(item.properties.time.description).toBe(doc["fork.time"]);
		expect(item.properties.permission.description).toBe(doc["fork.permission"]);
		expect(item.properties).not.toHaveProperty("stage");
		expect(item.properties).not.toHaveProperty("fission");
		expect(scopeTools.amendParameters.properties.reflection.description).toBe(
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
		expect(commonRulesText).toBe(doc["common-rules"]);
		expect(persistentOperatingSkill).toBe(doc["persistent-rules"]);
		expect(persistentOperatingSkill).toContain("强制以简体中文");
	});

	test("stage guidance is shipped as skills, not injected as a prompt block", () => {
		expect(persistentOperatingSkill).toMatch(/skills ship with this plugin/);
		expect(persistentOperatingSkill).toContain("the runtime enforces no order");
		expect(persistentOperatingSkill).not.toContain("Stage Prompts block");
	});

	test("every skill the persistent rules name is in the package", () => {
		const shipped = readdirSync(new URL("../skills/", import.meta.url), {
			withFileTypes: true,
		})
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
		const list = persistentOperatingSkill.match(
			/skills ship with this plugin \(([^)]*)\)/,
		);
		expect(list).not.toBeNull();
		const named = list[1].split(",").map((name) => name.trim());
		expect(named.sort()).toEqual([...shipped].sort());

		const referenced = [
			...persistentOperatingSkill.matchAll(/skill:\/\/([a-z0-9-]+)/g),
		].map((match) => match[1]);
		expect(referenced.length).toBeGreaterThan(0);
		for (const name of referenced) expect(shipped).toContain(name);
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
		expect(output).toContain(commonRulesText);
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
});

describe("fork item schema", () => {
	test("declares time as required and takes its text from the prompt document", () => {
		const time = scopeTools.forkParameters.properties.forks.items.properties.time;
		expect(scopeTools.forkParameters.properties.forks.items.required).toContain("time");
		expect(time.type).toBe("number");
		expect(time.description).toContain("Wall-clock budget");
	});
});
