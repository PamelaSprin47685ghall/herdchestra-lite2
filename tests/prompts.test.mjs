import { describe, expect, test } from "bun:test";

import { loadDoc, placeholderNames, render } from "../src/prompts/index.mjs";
import * as scopeTools from "../src/tools/descriptions.mjs";
import * as todoTools from "../src/tools/todo-description.mjs";
import * as stagePrompts from "../src/host/stage-prompts.mjs";
import {
	commonRulesText,
	injectSystemPrompt,
	languageSkill,
	outsideScopeInstruction,
	persistentOperatingSkill,
	stagePromptsBlock,
} from "../src/host/prompts.mjs";

const DOCS = [
	"tools/scope",
	"tools/todo",
	"stages",
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
		const first = loadDoc("tools/scope");
		expect(Object.isFrozen(first)).toBe(true);
		expect(loadDoc("tools/scope")).toBe(first);
	});

	test("reject a missing document and an invalid name", () => {
		expect(() => loadDoc("nope/missing")).toThrow(/Missing prompt document/);
		expect(() => loadDoc("../etc/passwd")).toThrow(/Invalid prompt document name/);
	});
});

describe("tool contracts map to their documents", () => {
	test("scope", () => {
		const doc = loadDoc("tools/scope");
		expect(scopeTools.SCOPE_DESCRIPTION).toBe(doc.tool);
		expect(scopeTools.BEGIN_INTENT_DESCRIPTION).toBe(doc["fission.intent"]);
		expect(scopeTools.BUDGET_DESCRIPTION).toBe(doc["fission.budget"]);
		expect(scopeTools.PERMISSION_DESCRIPTION).toBe(doc["fission.permission"]);
		expect(scopeTools.FISSION_DESCRIPTION).toBe(doc["begin.fission"]);
		expect(scopeTools.MODEL_DESCRIPTION).toBe(doc["fission.model"]);
		expect(scopeTools.END_DESCRIPTION).toBe(doc.end);
		expect(scopeTools.ELDER_REPORT_DESCRIPTION).toBe(doc["begin.elder_report"]);
		expect(scopeTools.AMEND_DESCRIPTION).toBe(doc["amend.tool"]);
		expect(scopeTools.REFLECTION_DESCRIPTION).toBe(doc["amend.reflection"]);
		expect(scopeTools.DEFER_DESCRIPTION).toBe(doc["defer.tool"]);
		expect(scopeTools.DEFER_INTENT_DESCRIPTION).toBe(doc["defer.intent"]);
		expect(scopeTools.PIN_DESCRIPTION).toBe(doc["pin.tool"]);
		expect(scopeTools.PIN_ASSUMPTION_DESCRIPTION).toBe(doc["pin.assumption"]);
		expect(scopeTools.PIN_DEDUCTION_DESCRIPTION).toBe(doc["pin.deduction"]);
		expect(scopeTools.PIN_INDUCTION_DESCRIPTION).toBe(doc["pin.induction"]);
		expect(scopeTools.PIN_FINDING_DESCRIPTION).toBe(doc["pin.finding"]);
		expect(scopeTools.PIN_CONCLUSION_DESCRIPTION).toBe(doc["pin.conclusion"]);
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

	test("schemas carry the mapped text", () => {
		const scope = loadDoc("tools/scope");
		const begin = scopeTools.scopeParameters.properties.begin;
		expect(begin.description).toBe(scope.begin);
		expect(begin.required).toEqual(["stage", "elder_report", "fission"]);
		expect(begin.properties.stage.description).toBe(scope["begin.stage"]);
		expect(begin.properties.elder_report.description).toBe(scope["begin.elder_report"]);
		expect(begin.properties).not.toHaveProperty("intent");
		expect(begin.properties).not.toHaveProperty("budget");
		expect(begin.properties).not.toHaveProperty("permission");
		expect(begin.properties).not.toHaveProperty("model");
		expect(begin.properties.fission).toMatchObject({ type: "array", minItems: 1 });
		expect(begin.properties.fission.description).toBe(scope["begin.fission"]);
		const item = begin.properties.fission.items;
		expect(item.required).toEqual(["intent", "budget", "permission"]);
		expect(item.properties.intent.description).toBe(scope["fission.intent"]);
		expect(item.properties.budget.description).toBe(scope["fission.budget"]);
		expect(item.properties.permission.description).toBe(scope["fission.permission"]);
		expect(item.properties.model.description).toBe(scope["fission.model"]);
		expect(scopeTools.amendParameters.properties.reflection.description).toBe(
			scope["amend.reflection"],
		);
		expect(scopeTools.deferParameters.properties.intent.description).toBe(
			scope["defer.intent"],
		);
		const todo = loadDoc("tools/todo");
		expect(
			todoTools.TODO_PARAMETERS.properties.list.items.properties.items.description,
		).toBe(todo["list.item"]);
	});
});

describe("stage and system prompts map to their documents", () => {
	test("stage sections", () => {
		const doc = loadDoc("stages");
		expect(stagePrompts.decisionFramingPrompt).toBe(doc["decision-framing"]);
		expect(stagePrompts.acceptanceCasesPrompt).toBe(doc["acceptance-cases"]);
		expect(stagePrompts.architectureDesignPrompt).toBe(doc["architecture-design"]);
		expect(stagePrompts.orchestrationPlanPrompt).toBe(doc["orchestration-plan"]);
	});

	test("stage block is the header plus the four sections", () => {
		const doc = loadDoc("stages");
		expect(stagePromptsBlock).toContain(doc.header);
		for (const key of [
			"decision-framing",
			"acceptance-cases",
			"architecture-design",
			"orchestration-plan",
		]) {
			expect(stagePromptsBlock).toContain(doc[key]);
		}
		expect(stagePromptsBlock).not.toContain("[Stage: direct-execution]");
	});

	test("system pieces", () => {
		const doc = loadDoc("system");
		expect(commonRulesText).toBe(doc["common-rules"]);
		expect(persistentOperatingSkill).toBe(doc["persistent-rules"]);
		expect(languageSkill).toBe(doc["language-skill"]);
		expect(outsideScopeInstruction).toBe(doc["outside-scope"]);
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
		expect(injectSystemPrompt(output)).toBe(output);
	});

	test("replaces a stale managed block", () => {
		const stale = `Intro.\n\n${START}\nSTALE\n${END}\n\nBody.`;
		const output = injectSystemPrompt(stale);
		expect(output).not.toContain("STALE");
		expect(output).toContain(commonRulesText);
		expect(output.startsWith("Intro.\n\n")).toBe(true);
		expect(output.endsWith(`${END}\n\nBody.`)).toBe(true);
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
