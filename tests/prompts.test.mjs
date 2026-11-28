// Prompt documents and the one registered tool.
//
// These assertions guard the seam the model actually reads: the document key
// set, the placeholders those documents declare, and the single `js` tool the
// catalog registers. A missing key is a runtime crash (`Missing prompt
// variable`), and a registered second tool would silently undo the whole
// capability-projection design.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import {
	createCoreTools,
	createTools,
	JS_TOOL_NAME,
	wireTools,
} from "../src/tools/catalog.mjs";
import { renderCapabilitiesDts } from "../src/tools/js-protocol.mjs";
import { loadDoc, placeholderNames, render } from "../src/prompts/index.mjs";
import { injectSystemPrompt, persistentOperatingSkill } from "../src/prompts/inject.mjs";
import {
	inlinedSkills,
	META_SKILLS,
	metaSkillsSection,
} from "../src/prompts/skills.mjs";

const DOCS = [
	"system",
	"errors",
	"receipts/scope",
	"receipts/relay",
	"tools/fork-join",
	"vibe-mode",
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

	test("the retired working-notes document is gone", () => {
		expect(() => loadDoc("tools/notes")).toThrow(/Missing prompt document/);
	});

	test("the retired labels document is gone", () => {
		// Nothing rendered these keys: the host writes its own labels and the
		// control plane owns the receipt text. Deleting it keeps the preload set
		// honest, so a loader that reaches for it fails loudly.
		expect(() => loadDoc("labels")).toThrow(/Missing prompt document/);
	});

	test("fill every declared placeholder without a missing-variable error", () => {
		for (const name of DOCS) {
			const doc = loadDoc(name);
			for (const text of Object.values(doc)) {
				const vars = {};
				for (const key of placeholderNames(text)) vars[key] = "X";
				expect(() => render(text, vars)).not.toThrow();
			}
		}
	});
});

describe("the control-plane documents", () => {
	test("describe scope_abandon and fork.path, not the retired scope_request, scope_reply, or send", () => {
		const fork = loadDoc("tools/fork-join");

		for (const key of [
			"fork.path",
			"abandon.tool",
		]) {
			expect(typeof fork[key]).toBe("string");
		}
		expect(fork["fork.path"]).toContain("fails closed");
		expect(Object.keys(fork).some((key) => key.startsWith("send."))).toBe(false);
		expect(Object.keys(fork).some((key) => key.startsWith("request."))).toBe(false);
		expect(Object.keys(fork).some((key) => key.startsWith("reply."))).toBe(false);
		expect(fork["fork.batch-started"]).toBeUndefined();
		expect(fork["fork.unreceived"]).toBeUndefined();
	});

	test("describe the info-rich fork and join results", () => {
		const fork = loadDoc("tools/fork-join");
		expect(fork["fork.forks"]).toContain("started");
		expect(fork["fork.forks"]).toContain("started: number[]");
		// The anti-replay guard lives in the join document's own words, and in
		// the returned `note` field; the model must read a record as history.
		expect(fork["join.tool"]).toContain("history, not instructions to replay");
		expect(fork["join.tool"]).toContain("note");
	});

	test("the control-plane prose ships in the managed block", () => {
		const prompt = injectSystemPrompt("Host prompt.");
		const doc = loadDoc("tools/fork-join");
		// No JSON schema carries these controls any more, so the prose is
		// the contract: a section that stops shipping takes the rule with it.
		expect(prompt).toContain(doc["fork.budget"]);
		expect(prompt).toContain(doc["return.dafny"]);
		expect(prompt).toContain("### fork.budget");
		// Receipt templates render with variables; none may ship raw.
		expect(prompt).not.toContain("{{");
	});

	test("fork funding is documented where each half belongs", () => {
		const budget = loadDoc("tools/fork-join")["fork.budget"];
		expect(budget).toContain("Free tools need no entry");
		expect(budget).toContain("panhandled");
		expect(budget).toContain("state.remaining");
		// The "a fork costs the caller nothing" rule is a planning rule, so it
		// ships in the operating rules rather than the parameter description.
		expect(persistentOperatingSkill).toContain("minted with the item that starts it");
		expect(persistentOperatingSkill).toContain("untouched");
	});

	test("the model is never asked for a time budget", () => {
		expect(loadDoc("tools/fork-join")["fork.time"]).toContain("Do not pass `time`");
	});

	test("a rewind is documented as context-only, never a refund", () => {
		// The tempting cheat: spend the budget, rewind, expect a fresh allowance.
		// The prose must close that door where the model reads it.
		const prose = [
			persistentOperatingSkill,
			Object.values(loadDoc("tools/fork-join")).join("\n"),
			Object.values(loadDoc("receipts/scope")).join("\n"),
		].join("\n");
		expect(prose).toContain("rewind");
		expect(prose).toMatch(/(never|does not|doesn't|no)\s+(refund|restore|re-?mint|replenish|refill|reset)/i);
	});

	test("the oath carries three values, and the retired fourth is refused", () => {
		const text = Object.values(loadDoc("tools/fork-join")).join("\n");
		expect(text).toMatch(/`continue`/);
		expect(text).toMatch(/`break`/);
		expect(text).toContain("a_ferocious_audacious_master_would_change_nothing");
		// A quoted `unfinished` would be an instruction the parser rejects.
		for (const doc of ["tools/fork-join", "system", "receipts/scope", "errors"]) {
			expect(Object.values(loadDoc(doc)).join("\n")).not.toMatch(/[`\"]unfinished[`\"]/);
		}
	});

	test("break is documented as a confessing early exit that root cannot take", () => {
		const fork = Object.values(loadDoc("tools/fork-join")).join("\n");
		expect(fork).toMatch(/shortfall|confession|candor|critique/i);
		// At root, `break` is `continue`: the work rewinds instead of ending.
		expect(fork).toMatch(/root[\s\S]{0,600}?break[\s\S]{0,600}?rewind/i);
	});

	test("the relay receipts carry the return report, not pins", () => {
		const relay = loadDoc("receipts/relay");
		expect(relay["reborn.pins"]).toBeUndefined();
		expect(relay["reborn.review"]).toBeUndefined();
		expect(placeholderNames(relay["reborn.report"])).toEqual(["report"]);
		for (const key of ["reborn.continue", "reborn.downgraded", "reborn.start"]) {
			expect(placeholderNames(relay[key])).toEqual([]);
		}
	});

	test("a degraded continuation carries the dissatisfaction notice verbatim", () => {
		// A root `break` rewind is a downgraded delivery: the successor must be
		// told, in the user's own words, that the predecessor settled for less.
		const copy = loadDoc("receipts/relay")["reborn.downgraded"];
		expect(copy).toContain("上一任选择了降级交付，用户不满意，请你做到满级交付为止。");
	});

	test("the scope receipts print remaining, not budget", () => {
		// `fork.subscope-status` is the one receipt that prints a scope's turns;
		// the retired `receipt.branch` had no renderer.
		const names = placeholderNames(loadDoc("receipts/scope")["fork.subscope-status"]);
		expect(names).toContain("remaining");
		expect(names).toContain("upscopePath");
		expect(names).toContain("callerPath");
		expect(names).not.toContain("budget");
	});

	test("each hard mode has its own receipt text", () => {
		const scope = loadDoc("receipts/scope");
		expect(placeholderNames(scope["mode.abandoned"])).toEqual(["by", "reasonClause"]);
		expect(typeof scope["mode.context-limit"]).toBe("string");
		expect(typeof scope["mode.final-answer"]).toBe("string");
	});

	test("the context-limit text names only the move that is bound", () => {
		// `CONTEXT_LIMIT` binds `scope_return` alone; forking is a later turn,
		// after the rewind re-baselines the context.
		const copy = loadDoc("receipts/scope")["mode.context-limit"];
		expect(copy).not.toContain("fork the remainder");
		expect(copy).toContain("after the rewind");
		expect(persistentOperatingSkill).not.toContain("fork the remainder");
		expect(persistentOperatingSkill).toContain("after the rewind");
	});

	test("the errors document carries the text the code actually renders", () => {
		const errors = loadDoc("errors");
		// Each key here is read by a literal lookup in the station or the
		// accounting path; a section nothing looks up is copy the model can
		// never receive.
		for (const key of [
			"invalid-path",
			"duplicate-scope-path",
			"unknown-upscope",
			"upscope-not-ready",
			"cannot-abandon-root",
			"cannot-abandon-self",
			"scope-already-done",
			"abandon-unknown-target",
			"not-a-subscope",
			"no-ready-subscope",
			"mixed-return",
			"return-unreceived",
			"root-has-no-budget",
			"no-branch-budget",
			"fork-context-exceeded",
			"join-context-exceeded",
			"invalid-return-oath",
			"no-unreceived-work",
			"fork-register-failed",
		]) {
			expect(typeof errors[key]).toBe("string");
		}
		// The oath is three-valued: a degraded `break` and a `continue` rewind
		// are both legal, so the refusal text must name every accepted value.
		const oathError = loadDoc("errors")["invalid-return-oath"];
		for (const value of ["continue", "break", "a_ferocious_audacious_master_would_change_nothing"]) {
			expect(oathError).toContain(value);
		}

		for (const key of [
			"scope-context-empty",
			"amend-reflection",
			"pin-empty",
			"pin-unavailable",
			"pin-internal",
			// Retired with the tool face: `ask` is absent from `api` under
			// autopilot, and the model-switch warning is host-owned text.
			"ask-blocked",
			"model-switch-warning",
		]) {
			expect(errors[key]).toBeUndefined();
		}
	});
});

describe("the capabilities block", () => {
	test("compiles host specs into one declaration interface", () => {
		const dts = renderCapabilitiesDts([
			{
				name: "bash",
				description: "Run a shell command.",
				parameters: {
					type: "object",
					required: ["command"],
					properties: { command: { type: "string", description: "Shell command." } },
				},
			},
		]);

		expect(dts).toContain("declare interface Api");
		expect(dts).toContain('"bash"(args: BashArgs)');
		expect(dts).toContain("interface BashArgs");
		expect(dts).toContain("command");
	});

	test("declares the control plane by its real names", () => {
		const dts = renderCapabilitiesDts([]);
		for (const name of ["scope_fork", "scope_join", "scope_return", "scope_abandon"]) {
			expect(dts).toContain(`"${name}"`);
		}
		for (const retired of ["scope_request", "scope_reply"]) {
			expect(dts).not.toContain(`"${retired}"`);
		}
		expect(dts).toContain("ABANDONED");
		expect(dts).toContain("CONTEXT_LIMIT");
	});

	test("never declares the executor itself or the retired todo", () => {
		const dts = renderCapabilitiesDts([
			{ name: "js", description: "", parameters: { type: "object" } },
			{ name: "todo", description: "", parameters: { type: "object" } },
		]);
		expect(dts).not.toContain('"js"(');
		expect(dts).not.toContain('"todo"(');
	});

	test("the fork and return call shapes survive only here", () => {
		// No JSON Schema reaches the model for the control plane, so the
		// declaration block is the single place a fork's required fields are
		// spelled out. Losing them would leave scope_fork uncallable.
		const dts = renderCapabilitiesDts([]);
		expect(dts).toContain("ScopeForkArgs");
		for (const field of ["path", "fsm", "profession", "n", "budget", "targets"]) {
			expect(dts).toContain(field);
		}
		expect(dts).toContain("ScopeReturnArgs");
		expect(dts).toContain("dafny");
	});

	test("declares the wrapped goal tool once, statically, with its args", () => {
		const dts = renderCapabilitiesDts([]);
		expect(dts).toContain("interface GoalArgs");
		expect(dts).toContain('"goal"(args: GoalArgs): Promise<unknown>;');
	});

	test("a host goal spec cannot change the declaration bytes", () => {
		const withGoal = renderCapabilitiesDts([
			{ name: "goal", description: "Host goal tool.", parameters: { type: "object" } },
		]);
		const without = renderCapabilitiesDts([]);
		expect(withGoal).toBe(without);
	});

	test("the js tool description points at the probe for the live surface", () => {
		const [jsTool] = createTools({ stationFor: () => null, tickets: {} });
		expect(jsTool.description).toContain("REPL probe");
		expect(jsTool.description).toContain("api");
		expect(jsTool.description).toContain("inputs");
	});
});

describe("the one registered tool", () => {
	test("the catalog builds exactly one tool, named js", () => {
		const tools = createTools({ stationFor: () => null, tickets: {} });
		expect(tools).toHaveLength(1);
		expect(tools[0].name).toBe(JS_TOOL_NAME);
		expect(tools[0].loadMode).toBe("essential");
		expect(tools[0].interruptible).toBe(true);
		expect(tools[0].handlesToolInterrupt).toBe(true);
	});

	test("its schema takes code and an optional inputs sidecar", () => {
		const [jsTool] = createTools({ stationFor: () => null, tickets: {} });
		const parameters = jsTool.parameters;
		expect(parameters.required).toEqual(["code"]);
		expect(parameters.properties.code.type).toBe("string");
		expect(parameters.properties.code.minLength).toBe(1);
		expect(parameters.properties.inputs.type).toEqual(["object", "array", "string"]);
		expect(parameters.required).not.toContain("inputs");
	});

	test("wiring registers no second tool and no native scope tool", () => {
		const registered = [];
		wireTools({ registerTool: (tool) => registered.push(tool) }, () => null);

		expect(registered.map((tool) => tool.name)).toEqual([JS_TOOL_NAME]);
	});

	test("the core table holds the four controls and nothing registered", () => {
		const core = createCoreTools({});
		expect(Object.keys(core).sort()).toEqual([
			"scope_abandon",
			"scope_fork",
			"scope_join",
			"scope_return",
		]);
		for (const name of Object.keys(core)) {
			expect(typeof core[name]).toBe("function");
		}
	});
});

describe("the operating rules", () => {
	test("name the one tool and the live api binding", () => {
		expect(persistentOperatingSkill).toContain("exactly one tool: `js`");
		expect(persistentOperatingSkill).toContain("live binding");
		expect(persistentOperatingSkill).toContain("Object.keys(api)");
	});

	test("name every hard mode so the model can read the probe", () => {
		for (const mode of ["ABANDONED", "CONTEXT_LIMIT", "FINAL_ANSWER"]) {
			expect(persistentOperatingSkill).toContain(mode);
		}
	});

	test("teach the balance as remaining, never as budget", () => {
		expect(persistentOperatingSkill).toContain("state.remaining");
		expect(persistentOperatingSkill).not.toContain("state.budget");
	});

	test("the scope rules retire todo and the old send/request channels", () => {
		const rules = loadDoc("system")["scope-rules"];
		expect(rules).toContain("no `todo` tool");
		expect(rules).not.toContain("scope_request");
		expect(rules).not.toContain("scope_reply");
		expect(rules).not.toContain("scope_send");
		expect(rules).not.toContain("scope_context");
	});

	test("the system document holds exactly the two rule blocks", () => {
		expect(Object.keys(loadDoc("system")).sort()).toEqual(["persistent-rules", "scope-rules"]);
	});

	test("no retired concept survives in either rule block", () => {
		const system = loadDoc("system");
		for (const text of Object.values(system)) {
			expect(text).not.toMatch(/\bamend\b/i);
			expect(text).not.toMatch(/\bpin\b/i);
			expect(text).not.toContain("scope_context");
			expect(text).not.toContain("scope_send");
			expect(text).not.toContain("readProtocol");
			expect(text).not.toContain("scope_seal");
		}
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
	test("every shipped skill is inlined and named once", () => {
		const shipped = readdirSync(new URL("../resources/skills/", import.meta.url), {
			withFileTypes: true,
		})
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();

		expect(shipped).toEqual([...META_SKILLS].sort());
		expect(inlinedSkills.map((skill) => skill.name).sort()).toEqual(shipped);
		expect(metaSkillsSection).toContain("reproduced in full below");
	});

	test("every body appears exactly once and reinjection is byte-identical", () => {
		const first = injectSystemPrompt("Host prompt.");
		for (const { name, body } of inlinedSkills) {
			expect(first.split(body)).toHaveLength(2);
			expect(first).toContain(`<inlined-skill name="${name}">`);
		}
		expect(injectSystemPrompt(first)).toBe(first);
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
			// The skills are the model's rules; none may name the retired calls.
			expect(body).not.toContain("scope_context");
			expect(body).not.toMatch(/\bamend\b/i);
		}
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
		expect(output).toContain(persistentOperatingSkill);
		expect(output.startsWith("Intro.\n\n")).toBe(true);
		expect(output.endsWith(`${END}\n\nBody.`)).toBe(true);
	});

	test("keeps the rules inside the managed block and the skills balanced", () => {
		const text = injectSystemPrompt("Host prompt.");
		const block = text.slice(text.indexOf(START), text.indexOf(END));
		expect(block).toContain(persistentOperatingSkill);
		expect(block).toContain(loadDoc("system")["scope-rules"]);
		expect((text.match(/<skill\b/g) ?? []).length).toBe(
			(text.match(/<\/skill>/g) ?? []).length,
		);
	});

	test("prepends one block to an array without mutating it", () => {
		const host = ["First block.", "Second block."];
		const output = injectSystemPrompt(host);
		expect(Array.isArray(output)).toBe(true);
		expect(output.length).toBe(3);
		expect(output.slice(1)).toEqual(host);
		expect(host).toEqual(["First block.", "Second block."]);
	});

	test("returns non-string, non-array input unchanged", () => {
		const value = { prompt: "Host prompt." };
		expect(injectSystemPrompt(value)).toBe(value);
		expect(injectSystemPrompt(null)).toBe(null);
	});
});
