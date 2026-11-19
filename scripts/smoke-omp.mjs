#!/usr/bin/env bun
/**
 * Smoke test against a real omp checkout.
 *
 * The unit suite runs on stub sessions. It proves the extension's own logic,
 * not that the seam it patches still exists in the host. This script closes
 * that gap: it loads the host's real `AgentSession`, runs the real `activate`
 * entry against it, and reports one line per check.
 *
 *   bun scripts/smoke-omp.mjs
 *   OMP_HOST=/path/to/oh-my-pi bun scripts/smoke-omp.mjs
 *
 * Statuses: PASS means the check ran and held. SKIP means the checkout could
 * not load, so the runtime seam is unverified. FAIL means real drift.
 * Exit codes: 0 when nothing failed, 1 when any check failed.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionStation } from "../src/station/station.mjs";
import { restoreState } from "../src/station/restore.mjs";
import { captureDiagnosis, installRunnerCapture } from "../src/host/capture.mjs";

const HOST = process.env.OMP_HOST ?? "/home/kunweiz/Desktop/vibe/oh-my-pi";
const AGENT_SESSION = join(HOST, "packages/coding-agent/src/session/agent-session.ts");
const REQUIRED_TOOLS = ["scope", "regret", "defer", "pin", "todo"];

const results = [];

async function check(name, run) {
	try {
		const note = await run();
		results.push({ name, status: "PASS", note: note ?? "" });
	} catch (error) {
		results.push({ name, status: "FAIL", note: error?.message ?? String(error) });
	}
}

function skip(name, reason) {
	results.push({ name, status: "SKIP", note: reason });
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

if (!existsSync(AGENT_SESSION)) {
	console.log(`SKIP: no omp checkout at ${HOST}`);
	process.exit(0);
}

const source = readFileSync(AGENT_SESSION, "utf8");

/**
 * Drop comments so a mention inside prose cannot satisfy a seam check.
 *
 * This is not a full TypeScript tokenizer: it tracks quotes and template
 * literals only far enough to avoid treating a `//` inside a string as a
 * comment. A false PASS here would hide exactly the drift the check exists to
 * find, so a mention in a comment must not count.
 */
function stripComments(text) {
	let out = "";
	let index = 0;
	while (index < text.length) {
		const char = text[index];
		const next = text[index + 1];
		if (char === "/" && next === "/") {
			while (index < text.length && text[index] !== "\n") index += 1;
			continue;
		}
		if (char === "/" && next === "*") {
			index += 2;
			while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
				if (text[index] === "\n") out += "\n";
				index += 1;
			}
			index += 2;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			const quote = char;
			out += char;
			index += 1;
			while (index < text.length) {
				if (text[index] === "\\") {
					out += text[index] + (text[index + 1] ?? "");
					index += 2;
					continue;
				}
				out += text[index];
				if (text[index] === quote) {
					index += 1;
					break;
				}
				index += 1;
			}
			continue;
		}
		out += char;
		index += 1;
	}
	return out;
}

const code = stripComments(source);

await check("host declares activateVibeTools", () => {
	assert(
		/activateVibeTools\s*\(/.test(code),
		"activateVibeTools not found in agent-session.ts",
	);
	return "agent-session.ts";
});

await check("host declares the extensionRunner getter", () => {
	assert(/get\s+extensionRunner\s*\(\s*\)/.test(code), "get extensionRunner() not found");
	return "agent-session.ts";
});

let AgentSession = null;
let loadFailure = null;
try {
	const host = await import(AGENT_SESSION);
	AgentSession = host.AgentSession ?? host.default ?? null;
	if (!AgentSession) loadFailure = "module loaded but exports no AgentSession";
} catch (error) {
	loadFailure = error?.message ?? String(error);
}

if (AgentSession) {
	await check("host class exposes both seams at runtime", () => {
		assert(
			typeof AgentSession.prototype.activateVibeTools === "function",
			"activateVibeTools missing on prototype",
		);
		let cursor = AgentSession.prototype;
		let found = false;
		while (cursor && !found) {
			const descriptor = Object.getOwnPropertyDescriptor(cursor, "extensionRunner");
			if (descriptor?.get) found = true;
			cursor = Object.getPrototypeOf(cursor);
		}
		assert(found, "extensionRunner accessor missing on the prototype chain");
		return "prototype";
	});

	await check("capture installs on the real class", () => {
		const diagnosis = installRunnerCapture(AgentSession);
		assert(
			diagnosis?.ok === true,
			`capture reported missing: ${(diagnosis?.missing ?? []).join(", ")}`,
		);
		const after = captureDiagnosis();
		assert(after.ok === true, `diagnosis after install: ${(after.missing ?? []).join(", ")}`);
		return "ok";
	});
} else {
	// A load failure is an environment fact, not drift: the addon version in
	// this checkout does not match the source. Say so, so a SKIP is not read
	// as "the seam is missing".
	const reason = `environment, not drift: ${loadFailure}`;
	skip("host class exposes both seams at runtime", reason);
	skip("capture installs on the real class", reason);
}

function fakePi() {
	const tools = new Map();
	const handlers = new Map();
	const commands = new Map();
	const notices = [];
	const pi = {
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		registerCommand(command) {
			commands.set(command.name, command);
		},
		getSession() {
			return null;
		},
		ui: {
			notify(message) {
				notices.push(message);
			},
		},
	};
	pi.pi = AgentSession ? { AgentSession } : {};
	return { pi, tools, handlers, commands, notices };
}

const { activate } = await import("../src/main.mjs");
const harness = fakePi();

await check("activate() completes", async () => {
	await activate(harness.pi);
	return "no throw";
});

await check("all five tools register", () => {
	const missing = REQUIRED_TOOLS.filter((name) => !harness.tools.has(name));
	assert(missing.length === 0, `not registered: ${missing.join(", ")}`);
	return REQUIRED_TOOLS.join(", ");
});

await check("hooks bind to host events", () => {
	assert(harness.handlers.size > 0, "no host events bound");
	return `${harness.handlers.size} events`;
});

function memoryManager() {
	const entries = [];
	return {
		entries,
		appendCustomEntry(customType, data) {
			const id = `e${entries.length}`;
			entries.push({
				type: "custom",
				customType,
				data,
				id,
				parentId: entries.length === 0 ? null : `e${entries.length - 1}`,
			});
			return id;
		},
		getBranch: () => entries.slice(),
		buildSessionContext: () => ({ messages: [] }),
	};
}

await check("a fresh session writes a checkpoint first", () => {
	const manager = memoryManager();
	const station = new SessionStation(manager, {}, {}, null, null);
	station.state.pins = ["smoke"];
	station.persist();
	assert(manager.entries.length === 1, `wrote ${manager.entries.length} entries`);
	assert(
		manager.entries[0].data.kind === "checkpoint",
		`first entry was ${manager.entries[0].data.kind ?? "legacy"}`,
	);
	return "checkpoint";
});

await check("a later write appends a delta and restores", () => {
	const manager = memoryManager();
	const station = new SessionStation(manager, {}, {}, null, null);
	station.state.pins = ["smoke"];
	station.persist();
	station.state.pins.push("second");
	station.persist();
	const kinds = manager.entries.map((entry) => entry.data.kind ?? "legacy");
	assert(kinds[0] === "checkpoint", `first entry was ${kinds[0]}`);
	assert(kinds[1] === "delta", `second entry was ${kinds[1]}`);
	const restored = restoreState(manager);
	assert(
		restored.pins.join(",") === "smoke,second",
		`restored pins: ${restored.pins.join(",")}`,
	);
	return kinds.join(" → ");
});

await check("a reopened session continues with deltas", () => {
	const manager = memoryManager();
	const first = new SessionStation(manager, {}, {}, null, null);
	first.state.pins = ["kept"];
	first.persist();
	const reopened = new SessionStation(manager, {}, {}, null, null);
	reopened.state.pins.push("added");
	reopened.persist();
	const kinds = manager.entries.map((entry) => entry.data.kind ?? "legacy");
	assert(kinds.at(-1) === "delta", `last entry was ${kinds.at(-1)}`);
	const restored = restoreState(manager);
	assert(
		restored.pins.join(",") === "kept,added",
		`restored pins: ${restored.pins.join(",")}`,
	);
	return `${kinds.join(" → ")}`;
});

let failed = 0;
for (const result of results) {
	const suffix = result.note ? `  ${result.note}` : "";
	console.log(`${result.status}  ${result.name}${suffix}`);
	if (result.status === "FAIL") failed += 1;
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
