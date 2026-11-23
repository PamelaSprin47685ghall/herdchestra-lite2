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
		// The size caps arrive through render(), so the exported text is the
		// filled sentence, not the raw template.
		for (const text of [
			scopeTools.FORK_INTENT_DESCRIPTION,
			scopeTools.FORK_BUDGET_DESCRIPTION,
		]) {
			expect(text).not.toContain("{{");
		}
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
		expect(description).toMatch(/is reused instead of starting a new one/i);
		expect(description).toContain("only its owner");
		expect(description).toMatch(/case-insensitive/i);
		expect(description).not.toMatch(/must be unique/i);
	});

	test("schemas carry the mapped text", () => {
		const doc = loadDoc("tools/fork-join");
		const item = scopeTools.forkParameters.properties.forks.items;
		expect(item.required).toEqual(["scopeId", "profession", "blocked", "budget", "targets"]);
		expect(item.required).not.toContain("intent");
		expect(item.properties.intent.description).toBe(scopeTools.FORK_INTENT_DESCRIPTION);
		expect(item.properties.budget.description).toBe(scopeTools.FORK_BUDGET_DESCRIPTION);
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
		expect(item.required).toEqual(["scopeId", "profession", "blocked", "budget", "targets"]);
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

describe("scope size stays O(1) at every depth", () => {
	test("no exported description leaks a template placeholder", () => {
		const leaked = Object.entries(scopeTools)
			.filter(([, value]) => typeof value === "string" && value.includes("{{"))
			.map(([name]) => name);
		expect(leaked).toEqual([]);
	});

	test("the fork intent asks for a small scope, not sqrt(n)", () => {
		const intent = scopeTools.FORK_INTENT_DESCRIPTION;
		expect(intent).not.toContain("sqrt");
		expect(intent).toMatch(/\b(?:18|eighteen)\b/i);
		expect(intent).toMatch(/\b(?:27|twenty-seven)\b/i);
	});

	test("the budget names the panhandle's small total and keeps its funding rule", () => {
		const budget = scopeTools.FORK_BUDGET_DESCRIPTION;
		expect(budget).not.toContain("at most 8");
		// The working scope carries the tripled turn budget.
		expect(budget).toMatch(/\b(?:18|eighteen)\b/i);
		expect(budget).toMatch(/\b(?:27|twenty-seven)\b/i);
		// The panhandle stays a third of the scope.
		expect(budget).toMatch(/\b(?:6|six)\b/i);
		expect(budget).toMatch(/\b(?:9|nine)\b/i);
		expect(budget).toContain("each item funds its own child at any depth");
		expect(budget).toContain("never charged");
		expect(budget).toContain("is free at any depth, so it needs no entry either");
	});

	test("the batch names the fanout floor and cap for one call", () => {
		const forks = scopeTools.forkParameters.properties.forks;
		expect(forks.description).toMatch(/\b(?:4|four)\b/i);
		expect(forks.description).toMatch(/\b(?:6|six)\b/i);
		// The cap is a rebuke, not a schema gate: over-cap batches still run.
		expect(forks.maxItems).toBeUndefined();
		const budget = scopeTools.forkParameters.properties.forks.items.properties.budget;
		expect(budget.additionalProperties.maximum).toBeUndefined();
	});

	test("the operating rules carry the floor and the cap at every depth", () => {
		const text = persistentOperatingSkill;
		// Scoped to the size sentence so an unrelated "Six project skills"
		// cannot satisfy the floor.
		const size = text
			.split(/(?<=\.)\s+/)
			.filter((sentence) =>
				/scope size|per scope|each scope|a scope should|scope should/i.test(sentence),
			)
			.join(" ");
		expect(size.length).toBeGreaterThan(0);
		expect(size).toMatch(/\b(?:18|eighteen)\b/i);
		expect(size).toMatch(/\b(?:27|twenty-seven)\b/i);
		// The panhandle keeps its own sentence and stays a third of the scope.
		const panhandle = text
			.split(/(?<=\.)\s+/)
			.filter((sentence) => /panhandle/i.test(sentence))
			.join(" ");
		expect(panhandle.length).toBeGreaterThan(0);
		expect(panhandle).toMatch(/\b(?:6|six)\b/i);
		expect(panhandle).toMatch(/\b(?:9|nine)\b/i);
		// The floor exists to refuse hoarding work and serial retreat.
		expect(text).toMatch(/hoard(?:ing)?|\bserial\b|hold(?:ing)? work back/i);
	});

	test("an over-cap batch still runs and earns a rebuke", () => {
		const fork = loadDoc("tools/fork-join");
		for (const key of ["fork.over-budget", "fork.over-fanout"]) {
			expect(typeof fork[key]).toBe("string");
			expect(fork[key].length).toBeGreaterThan(0);
			expect(fork[key]).toMatch(/\byou\b|\byour\b/i);
		}
	});
});

describe("panhandle caps render and measure one total", () => {
	test("the parameter descriptions render their placeholders", () => {
		for (const text of [
			scopeTools.PANHANDLE_DESCRIPTION,
			scopeTools.PANHANDLE_TOOLS_DESCRIPTION,
			scopeTools.PANHANDLE_SECONDS_DESCRIPTION,
		]) {
			expect(text).not.toContain("{{");
		}
	});

	test("tools are capped as one total across every tool, so no per-tool maximum", () => {
		const tools = scopeTools.PANHANDLE_TOOLS_DESCRIPTION;
		expect(tools).toMatch(/\b(?:6|six)\b/i);
		expect(tools).toMatch(/\b(?:9|nine)\b/i);
		expect(tools).toMatch(/total|altogether|combined|in all/i);
		// The tool description carries the same numbers as its parameters.
		const description = scopeTools.PANHANDLE_DESCRIPTION;
		expect(description).not.toContain("{{");
		expect(description).toMatch(/\b(?:6|six)\b/i);
		expect(description).toMatch(/\b(?:9|nine)\b/i);
		const schema = scopeTools.panhandleParameters.properties.tools;
		expect(schema.description).toBe(tools);
		expect(schema.additionalProperties.minimum).toBe(1);
		// A per-tool maximum would contradict the single-total cap.
		expect(schema.additionalProperties.maximum).toBeUndefined();
	});

	test("seconds keep their own cap and render it", () => {
		const seconds = scopeTools.PANHANDLE_SECONDS_DESCRIPTION;
		expect(seconds).toMatch(/\b(?:300|three hundred)\b/i);
		const schema = scopeTools.panhandleParameters.properties.seconds;
		expect(schema.description).toBe(seconds);
		expect(schema.maximum).toBe(300);
	});

	test("an oversized panhandle still runs and earns a rebuke", () => {
		const section = loadDoc("tools/panhandle")["panhandle.over-limit"];
		expect(typeof section).toBe("string");
		expect(section.length).toBeGreaterThan(0);
		expect(section).toMatch(/\byou\b|\byour\b/i);
	});
});

describe("tree depth methodology is default and recommended, not a max", () => {
	// Depth is the one dimension where the default is a target, not a floor:
	// a small job must not grow a relay layer just to look organized.
	const noCeiling = /\bmax\b|\bmaximum\b|\bceiling\b/i;

	test("the fork intent states the default depth and the roles that use it", () => {
		const intent = scopeTools.FORK_INTENT_DESCRIPTION;
		expect(intent).not.toContain("{{");
		expect(intent).toMatch(/2/);
		expect(intent).toMatch(/3/);
		expect(intent).toMatch(/recommended/i);
		expect(intent).toMatch(/leaf|subtree/i);
		// The guidance is advice. Any sentence carrying the depth must read as
		// a default, never as a hard bound.
		const depthSentences = intent
			.split(/(?<=\.)\s+/)
			.filter((sentence) => /depth|layer|level/i.test(sentence))
			.join(" ");
		expect(depthSentences.length).toBeGreaterThan(0);
		expect(depthSentences).not.toMatch(noCeiling);
	});

	test("the operating rules size the tree from closures and refuse both fakes", () => {
		const text = persistentOperatingSkill;
		expect(text).toMatch(/closure/i);
		expect(text).toMatch(/relay/i);
		expect(text).toMatch(/wave/i);
		expect(text).toMatch(/reason|warrant/i);
		expect(text).toMatch(/justify|explain/i);
		// Depth sentences carry 1/2/3 as a recommendation, not as a hard bound.
		const depthSentences = text
			.split(/(?<=\.)\s+/)
			.filter((sentence) => /depth|deeper tree|layer/i.test(sentence))
			.join(" ");
		expect(depthSentences.length).toBeGreaterThan(0);
		expect(depthSentences).not.toMatch(noCeiling);
		expect(text).toMatch(/\b(?:1|one)\b/i);
		expect(text).toMatch(/2/);
		expect(text).toMatch(/3/);
	});

	test("a deep tree is fine, so the note is context rather than a warning", () => {
		const section = loadDoc("tools/fork-join")["fork.deep-nesting"];
		expect(typeof section).toBe("string");
		expect(section.length).toBeGreaterThan(0);
		for (const name of [
			"childDepth",
			"defaultDepth",
			"recommendedDepth",
			"defaultPoints",
		]) {
			expect(section).toContain(`{{${name}}}`);
		}
		// The closure size is a constant, not a number baked into the prose.
		expect(section).not.toMatch(/six-point|6-point/i);
		// It informs. It does not scold, and it never presents itself as a cap.
		expect(section).not.toMatch(/WARNING/);
		expect(section).not.toMatch(/do not repeat/i);
		expect(section).not.toMatch(/\bmax\b/i);
	});

	test("the child's birth receipt shows its depth against the recommendation", () => {
		const status = loadDoc("receipts/scope")["fork.child-status"];
		expect(status.startsWith("{{marker}}")).toBe(true);
		for (const name of ["depth", "defaultDepth", "recommendedDepth"]) {
			expect(status).toContain(`{{${name}}}`);
		}
		expect(status).not.toMatch(/\bmax\b/i);
	});
});
