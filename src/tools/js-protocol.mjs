// The js tool's wire schema and the static `.d.ts` compiler.
//
// `js` is the only tool the model ever sees. Everything else -- host tools,
// MCP tools, and the scope control plane -- is reachable as async methods on
// the `api` object inside the vm. Their documentation is compiled once from
// the tools' own JSON schemas into a deterministic TypeScript declaration
// block embedded in the managed system prompt. One source, zero drift:
// schemas are never described twice, and a host adding a tool updates the
// declarations for free.
//
// Pure functions only: no Station import, no host import, no mutation, no I/O.

/** The wire schema of the one registered tool. */
export const jsParameters = Object.freeze({
	type: "object",
	additionalProperties: false,
	required: ["code"],
	properties: {
		inputs: {
			type: "object",
			additionalProperties: true,
			description:
				"MANDATORY payload bay for every non-trivial text value: file bodies (`write` `content`), diffs/patches (`edit` `old_string`/`new_string`), `scope_return` `dafny`, `scope_fork` `fsm`, `ask` `html`, heredocs, or ANY string with two lines, quotes, backticks, or `${`. Write `inputs` BEFORE `code` every time (`inputs: { body: \"...\" }` -> `inputs.body`). Values here cross ONE JSON layer only — never parsed as JS source, never double-escaped, arriving verbatim as a runtime object. Skipping `inputs` because you think \"I will escape this string carefully inside `code`\" is the #1 self-inflicted `SyntaxError` failure mode: nothing executes, the burned turn stays on the ledger forever, and you re-emit the whole payload anyway. Omit `inputs` ONLY when `code` contains nothing longer than short paths or identifiers.",
		},
		code: {
			type: "string",
			minLength: 1,
			description:
				"SHORT async JS glue ONLY (`api`, `state`, `inputs` in scope; bare expression returns implicitly, statement body needs `return`; always `await` api calls). NEVER embed multiline text, file bodies, patches, `dafny`, `fsm`, `html`, or heredocs here. STOP-TRIGGER: if you catch yourself typing `\\n`, a backtick, `${`, or escaped quotes inside `code`, STOP IMMEDIATELY — you are walking straight into a two-layer escaping `SyntaxError` that kills the call before any api method runs and burns the turn for nothing. Put the payload in `inputs.<key>` and pass `inputs.<key>` here instead.",
		},
	},
});

/** A comment closing sequence would end the JSDoc block early. */
function escapeComment(text) {
	return String(text).replace(/\*\//g, "*\\/");
}

function docLines(description) {
	if (typeof description !== "string" || description.trim() === "") return [];
	return escapeComment(description.trim())
		.split("\n")
		.map((line) => ` * ${line}`.trimEnd());
}

function indentBlock(lines, indent) {
	return lines.map((line) => (line === "" ? line : indent + line));
}

/**
 * Compile one JSON schema fragment into TypeScript. Covers the subset the
 * host schemas actually use; anything outside it degrades to `unknown`
 * rather than guessing wrong.
 */
export function jsonSchemaToTs(schema) {
	if (schema === true || schema === undefined || schema === null) return "unknown";
	if (schema === false) return "never";
	if (typeof schema !== "object") return "unknown";
	if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
		return schema.anyOf.map((part) => jsonSchemaToTs(part)).join(" | ");
	}
	if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
		return schema.oneOf.map((part) => jsonSchemaToTs(part)).join(" | ");
	}
	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		return schema.enum
			.map((value) => (typeof value === "string" ? JSON.stringify(value) : String(value)))
			.join(" | ");
	}
	const types = Array.isArray(schema.type) ? schema.type : schema.type !== undefined ? [schema.type] : [];
	if (types.length > 1) {
		return types.map((type) => jsonSchemaToTs({ ...schema, type })).join(" | ");
	}
	const type = types[0];
	switch (type) {
		case "string":
			return "string";
		case "integer":
		case "number":
			return "number";
		case "boolean":
			return "boolean";
		case "null":
			return "null";
		case "array":
			return `Array<${jsonSchemaToTs(schema.items)}>`;
		case "object": {
			const properties = schema.properties;
			if (properties && typeof properties === "object" && Object.keys(properties).length > 0) {
				return inlineObjectType(schema);
			}
			const additional = schema.additionalProperties;
			if (additional && typeof additional === "object" && additional.type !== undefined) {
				return `Record<string, ${jsonSchemaToTs(additional)}>`;
			}
			return "Record<string, unknown>";
		}
		default:
			return "unknown";
	}
}

/** Property keys are always quoted: tool schemas use dashes and dots freely. */
function propertyKey(key) {
	return JSON.stringify(key);
}

/**
 * Nested object schemas print as one compact single-line type literal.
 * Multi-line inline indentation inside an interface is fragile for zero
 * benefit; only the top-level interface body gets real line structure.
 */
function inlineObjectType(schema) {
	const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	const parts = Object.keys(properties)
		.sort()
		.map((key) => {
			const sub = properties[key] && typeof properties[key] === "object" ? properties[key] : {};
			const optional = required.has(key) ? "" : "?";
			return `${propertyKey(key)}${optional}: ${jsonSchemaToTs(sub)}`;
		});
	if (schema.additionalProperties === true) parts.push("[key: string]: unknown");
	return `{ ${parts.join("; ")}${parts.length > 0 ? ";" : ""} }`;
}

function renderObjectType(schema, indent) {
	const lines = ["{"];
	const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	for (const key of Object.keys(properties).sort()) {
		const sub = properties[key] && typeof properties[key] === "object" ? properties[key] : {};
		const doc = docLines(sub.description);
		if (doc.length > 0) lines.push(...indentBlock(["/**", ...doc, " */"], indent));
		const optional = required.has(key) ? "" : "?";
		lines.push(`${indent}${propertyKey(key)}${optional}: ${jsonSchemaToTs(sub)};`);
	}
	const additional = schema.additionalProperties;
	if (additional === true) {
		lines.push(`${indent}[key: string]: unknown;`);
	}
	lines.push(`${indent.slice(0, -1)}}`);
	return lines.join("\n");
}

/** `scope_fork` -> `ScopeForkArgs`; non-alphanumerics are word separators. */
function argsTypeName(toolName) {
	const words = String(toolName)
		.split(/[^A-Za-z0-9]+/)
		.filter((word) => word !== "");
	const pascal = words
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join("");
	return `${pascal === "" ? "Tool" : pascal}Args`;
}

// The scope control plane's result shapes are fixed by the protocol itself,
// so they are declared inline once instead of being derived from anywhere.
const CONTROL_PLANE_BLOCK = `/**
 * The scope control plane. These four primitives always exist in the type
 * space; whether one is callable this turn is decided by the live binding
 * printed in the REPL probe, never by this declaration.
 */
type ScopeRole = "manager" | "devops" | "editor" | "inspector";

interface ScopeForkItem {
	/**
	 * New subscope path ending in "<role>.<name>" (manager | devops | editor | inspector).
	 * Bare name ("editor.eve") is relative to state.scope; "../inspector.peter/editor.eve"
	 * or "/manager.tom/devops.alice" inherits that upscope's last-turn context snapshot
	 * while delivering scope_return back to you (the caller). A segment without a role,
	 * a wider role than yours, a duplicate path, an unknown or unready upscope, and a
	 * second running devops all fail closed.
	 */
	path: string;
	fsm: string;
	profession: string;
	n: number;
	/** Allowed tool turn budgets for the target role. Omit or {} for a manager and a pure-reasoning inspector. */
	budget?: Record<string, number>;
	/** Required concrete file paths for editor; optional descriptive or exploratory targets for other roles. */
	targets?: string[];
	/** Optional override; omit or null to inherit upscope's model + thinking level (reuses prompt prefix cache). */
	model?: string | null;
}

interface ScopeForkArgs {
	forks: ScopeForkItem[];
}

  interface ScopeForkResult {
  	/** Child depth, present only when at least one fork started. */
  	depth?: number;
  	/** Successful items, named by their position in ScopeForkArgs.forks. */
  	started: number[];
  	/** index shares the forks coordinate of started, so a failure maps back to the caller's own item. */
  	failed: Array<{ index: number; error?: string }>;
  	unreceived: string[];
  }

  interface ScopeJoinResult {
  	scope: string;
  	role?: ScopeRole;
	failed: boolean;
	abandoned?: boolean;
	abandonedBy?: string | null;
	abandonReason?: string | null;
	reason: string | null;
	/** History only; do not re-execute it. */
	record: string;
	note: string;
	unreceived: string[];
	persisted: boolean;
}

interface ScopeAbandonArgs {
	/** Exact path of one running scope (never "/", never state.scope, never a wider role than yours). Interrupts it and forces scope_return on its next turn. */
	target: string;
	/** Optional reason shown to the target (to guide its final dafny) and to its caller on scope_join. */
	reason?: string;
}

  interface ScopeAbandonResult {
  	ok: boolean;
  	alreadyAbandoning?: boolean;
  	/** Present only when the resolved target differs from the target you supplied. */
  	resolvedTarget?: string;
  }

interface ScopeReturnArgs {
	dafny: string;
	/** Required in normal mode: "unfinished" rewinds; the seal value publishes. Ignored in ABANDONED mode (always publishes without rewinding). */
	signed_sealed_hands_off_nothing_left_on_the_table?:
		| "a_ferocious_audacious_master_would_change_nothing"
		| "unfinished";
}

interface ScopeState {
	mode: "SUBSCOPE" | "ROOT_MANUAL" | "ROOT_AUTOPILOT" | "FINAL_ANSWER" | "CONTEXT_LIMIT" | "ABANDONED";
	role: ScopeRole;
	scope: string;
	autopilot?: boolean;
	canStop?: boolean;
	/** Subscope only: what is left, never what is used. Tools as "remaining/budget"; time as "<left> left of <budget>" or "OVERTIME"; panhandled only when nonzero. */
	remaining?: Record<string, string | number>;
	unreceived: number;
	/** Global directory delta since your previous turn (overwrite semantics per path): "running | model | base+ / window" or "done | model | ctx / window". Omitted when unchanged. */
	scopes_delta?: Record<string, string>;
	/** Manager only when the active scope feature is hard: idle capacity by role, phrased as a nudge. Omitted otherwise. */
	scopes_summary?: string;
	/** Present only in ABANDONED mode. */
	abandoned?: { by: string; reason?: string };
}`;

/**
 * Compile every tool spec into the deterministic TypeScript declaration block
 * for the managed system prompt.
 *
 * @param {Array<{ name: string, description?: string, parameters?: object }>} toolSpecs
 *   Host tools (built-in + MCP) with their JSON schemas. The scope control
 *   plane is not an input: its declarations are protocol-fixed inline text.
 * @returns {string} Stable bytes: tools sorted by name, so a reordering of
 *   the host's tool list never invalidates the prompt prefix cache.
 */
export function renderCapabilitiesDts(toolSpecs = []) {
	const specs = (Array.isArray(toolSpecs) ? toolSpecs : [])
		.filter((spec) => spec && typeof spec.name === "string" && spec.name !== "")
		.filter((spec) => spec.name !== "js" && spec.name !== "todo")
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

	const sections = [
		"// Auto-generated from the host tools' JSON schemas. Do not edit by hand.",
		CONTROL_PLANE_BLOCK,
	];

	const methods = [];
	for (const spec of specs) {
		const parameters =
			spec.parameters && typeof spec.parameters === "object" ? spec.parameters : { type: "object" };
		const typeName = argsTypeName(spec.name);
		const doc = docLines(spec.description);
		const argsLines = [];
		if (doc.length > 0) argsLines.push("/**", ...doc, " */");
		argsLines.push(`interface ${typeName} ${renderObjectType(parameters, "\t")}`);
		sections.push(argsLines.join("\n"));
		const methodDoc = doc.length > 0 ? `\n\t/**\n${indentBlock(doc, "\t * ").join("\n")}\n\t */` : "";
		methods.push(`${methodDoc}\n\t${JSON.stringify(spec.name)}(args: ${typeName}): Promise<unknown>;`);
	}

	const controlMethods = [
		`\t"scope_fork"(args: ScopeForkArgs): Promise<ScopeForkResult>;`,
		`\t"scope_join"(): Promise<ScopeJoinResult>;`,
		`\t"scope_return"(args: ScopeReturnArgs): Promise<never>;`,
		`\t"scope_abandon"(args: ScopeAbandonArgs): Promise<ScopeAbandonResult>;`,
	];

	sections.push(`/**
 * Host-managed live capability binding. It behaves like a DevTools host
 * object or an ES module live binding: the host state machine rebinds it
 * between turns, and the set of present keys can shrink or grow without any
 * action of yours. Methods absent from the current REPL probe do not exist
 * at runtime — calling them throws. Trust the probe, not memory of earlier
 * turns: the probe is reprinted every single turn.
 *
 * Type-wise every method is declared here, but at runtime only the keys
 * printed in the probe exist on the object.
 */
declare interface Api {${[...controlMethods, ...methods].join("\n")}
}

/**
 * Read-only snapshot of the session state machine, passed fresh into every
 * evaluation. Use it instead of hardcoding sibling paths or budgets.
 */
declare const state: ScopeState;`);

	return sections.join("\n\n");
}
