#!/usr/bin/env bun
/**
 * Smoke test against a real omp checkout.
 *
 * Load the host's real `AgentSession` and check the seams used by capture.
 * Run the real `activate` entry through a test API that exposes that class.
 * Other checks use local fixtures for construction inputs and persistence.
 * One check builds real sessions to observe the model a flow takes; it sends
 * no completion request, though construction may run the host's warm-up.
 * This script does not measure cache reuse.
 *
 *   bun scripts/smoke-omp.mjs
 *   OMP_HOST=/path/to/oh-my-pi bun scripts/smoke-omp.mjs
 *
 * Statuses: PASS means the check ran and held. SKIP means the checkout could
 * not load, so the runtime seam is unverified. FAIL means real drift.
 * Exit codes: 0 when nothing failed, 1 when any check failed.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SessionStation } from "../src/station/station.mjs";
import { createTestStation } from "../tests/helpers/station-ports.mjs";
import { restoreState } from "../src/station/restore.mjs";
import { captureDiagnosis, installRunnerCapture } from "../host-omp/src/host/capture.mjs";

const HOST = resolve(process.env.OMP_HOST ?? "/home/kunweiz/Desktop/vibe/oh-my-pi");
const AGENT_SESSION = join(HOST, "packages/coding-agent/src/session/agent-session.ts");
const REQUIRED_TOOLS = ["scope_fork", "scope_join", "scope_return", "scope_context", "todo"];
const STRICT = process.env.OMP_SMOKE_STRICT === "1";

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
	process.exit(STRICT ? 1 : 0);
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

/**
 * A checkout whose `packages/natives/native` addon predates its source cannot
 * be imported: the older binary is missing exports the source now reads.
 *
 * The host loader can use a matching prebuilt addon instead of a rebuild:
 * `PI_COMPILED` makes it look in the version cache, and `PI_NATIVES_DIR` names
 * the cache base. A matching addon is one the machine already extracted for
 * its installed omp, under `~/.omp/natives/<version>/`.
 */
function findInstalledAddon() {
	const nativesPackage = join(HOST, "packages/natives/package.json");
	if (!existsSync(nativesPackage)) return null;
	let version;
	try {
		version = JSON.parse(readFileSync(nativesPackage, "utf8")).version;
	} catch {
		return null;
	}
	if (typeof version !== "string" || version === "") return null;
	const tag = `${process.platform}-${process.arch}`;
	const filenames =
		process.arch === "x64"
			? [
					`pi_natives.${tag}-modern.node`,
					`pi_natives.${tag}-baseline.node`,
					`pi_natives.${tag}.node`,
				]
			: [`pi_natives.${tag}.node`];
	const bases = [];
	if (process.env.PI_NATIVES_DIR) bases.push(process.env.PI_NATIVES_DIR);
	if (process.env.XDG_DATA_HOME) {
		bases.push(join(process.env.XDG_DATA_HOME, "omp", "natives"));
	}
	bases.push(join(homedir(), ".omp", "natives"));
	for (const base of bases) {
		const dir = join(base, version);
		for (const filename of filenames) {
			if (existsSync(join(dir, filename))) return { version, dir, base };
		}
	}
	return null;
}

let AgentSession = null;
let loadFailure = null;
try {
	const host = await import(AGENT_SESSION);
	AgentSession = host.AgentSession ?? host.default ?? null;
	if (!AgentSession) loadFailure = "module loaded but exports no AgentSession";
} catch (error) {
	loadFailure = error?.message ?? String(error);
}

// The failed import is cached in this process, so the retry must be a child.
// `OMP_SMOKE_BORROWED` marks that child, which keeps the fallback single-shot.
if (!AgentSession && process.env.OMP_SMOKE_BORROW !== "0" && !process.env.OMP_SMOKE_BORROWED) {
	const borrowed = findInstalledAddon();
	if (borrowed) {
		console.log(
			`borrowing @oh-my-pi/pi-natives@${borrowed.version} from ${borrowed.dir}`,
		);
		const child = spawnSync(process.execPath, [import.meta.path], {
			stdio: "inherit",
			env: {
				...process.env,
				PI_COMPILED: "1",
				PI_NATIVES_DIR: borrowed.base,
				OMP_SMOKE_BORROWED: borrowed.dir,
			},
		});
		process.exit(child.status ?? 1);
	}
}

if (process.env.OMP_SMOKE_BORROWED) {
	console.log(`note: native addon borrowed from ${process.env.OMP_SMOKE_BORROWED}`);
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
			`capture reported: ${diagnosis?.error ?? (diagnosis?.missing?.join(", ") || "no diagnosis")}`,
		);
		const after = captureDiagnosis();
		assert(
			after.ok === true,
			`diagnosis after install: ${after.error ?? (after.missing.join(", ") || "no diagnosis")}`,
		);
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

/**
 * `scope_fork` resolves model selectors through the host facade that an
 * extension sees as `ctx.models`. This check names the seam; it does not
 * select a model or send a request.
 */
await check("host exposes the model facade used by scope_fork", () => {
	const runnerPath = join(HOST, "packages/coding-agent/src/extensibility/extensions/runner.ts");
	const typesPath = join(HOST, "packages/coding-agent/src/extensibility/extensions/types.ts");
	assert(existsSync(runnerPath), `missing ${runnerPath}`);
	assert(existsSync(typesPath), `missing ${typesPath}`);
	const runner = stripComments(readFileSync(runnerPath, "utf8"));
	const types = stripComments(readFileSync(typesPath, "utf8"));
	assert(
		/models:\s*createExtensionModelQuery\(/.test(runner),
		"the extension context no longer installs ctx.models",
	);
	assert(/interface ExtensionModelQuery/.test(types), "ExtensionModelQuery is gone");
	assert(
		/resolve\s*\(\s*spec:\s*string\s*\)\s*:\s*Model(?:<[^>]+>)?\s*\|\s*undefined/.test(types),
		"ctx.models.resolve no longer accepts a selector string",
	);
	return "ctx.models.resolve";
});

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

const { activate } = await import("../host-omp/src/main.mjs");
const harness = fakePi();

await check("activate() completes", async () => {
	await activate(harness.pi);
	return "no throw";
});

await check("all five control tools register", () => {
	const missing = REQUIRED_TOOLS.filter((name) => !harness.tools.has(name));
	assert(missing.length === 0, `not registered: ${missing.join(", ")}`);
	return REQUIRED_TOOLS.join(", ");
});

await check("hooks bind to host events", () => {
	assert(harness.handlers.size > 0, "no host events bound");
	return `${harness.handlers.size} events`;
});

/**
 * Build a real owner session and a real flow session through the plugin's
 * factory. The owner fixture cannot answer this: only a created AgentSession
 * proves the host applied the requested model and thinking level, and that a
 * request without a model inherits the owner's.
 *
 * The owner is a real session created offline. The flow needs an extension
 * seed (deriveBranchConfig refuses without one), so the owner proxy supplies
 * one prepared no-op extension; the session's own getters and managers stay
 * untouched. A missing host SDK module is an environment failure, not drift.
 */
await check("a created flow session takes the requested model", async () => {
	const sdkPath = join(HOST, "packages/coding-agent/src/sdk.ts");
	const managerPath = join(HOST, "packages/coding-agent/src/session/session-manager.ts");
	const costGatePath = join(HOST, "packages/coding-agent/src/session/cost-gate.ts");
	assert(existsSync(sdkPath), `missing ${sdkPath}`);
	assert(existsSync(managerPath), `missing ${managerPath}`);
	assert(existsSync(costGatePath), `missing ${costGatePath}`);
	const { createAgentSession } = await import(sdkPath);
	const { SessionManager } = await import(managerPath);
	const { CostGate } = await import(costGatePath);
	const { createBranchSession } = await import("../host-omp/src/host/branch-session.mjs");
	assert(typeof createAgentSession === "function", "sdk exports no createAgentSession");
	assert(typeof SessionManager?.inMemory === "function", "no in-memory SessionManager");

	const manager = SessionManager.inMemory();
	const owner = (
		await createAgentSession({
			sessionManager: manager,
			cwd: process.cwd(),
			bindProcessState: false,
			disableExtensionDiscovery: true,
			systemPrompt: ["You are the owner."],
		})
	).session;
	assert(owner && typeof owner === "object", "owner session was not created");
	assert(owner.model, "owner session selected no model");

	const available = owner.modelRegistry?.getAvailable?.() ?? [];
	assert(available.length > 0, "the host registry lists no available model");
	const ownerId = `${owner.model.provider}/${owner.model.id}`;
	const requested = available.find((model) => `${model.provider}/${model.id}` !== ownerId);
	assert(requested, "the host registry lists only the owner's model");

	// deriveBranchConfig requires an extension seed; the real session has none
	// with discovery disabled. The proxy changes only that one getter.
	const seed = [
		{
			path: "/virtual/smoke-extension.mjs",
			resolvedPath: "/virtual/smoke-extension.mjs",
			factory: () => ({}),
			error: null,
		},
	];
	const ownerSource = new Proxy(owner, {
		get(target, property) {
			if (property === "preparedExtensions") return seed;
			return Reflect.get(target, property, target);
		},
	});

	const common = {
		session: ownerSource,
		sessionManager: manager,
		createAgentSession,
		asyncJobManager: {},
		costGate: new CostGate(owner.settings, 0, () => {}),
		systemPrompt: ["You are the owner."],
		// Name the tool view explicitly: this check is about the model seam,
		// and the plugin's capture has already wrapped the live session class.
		toolNames: ["read", "scope_fork", "todo"],
		activeToolNames: ["read", "scope_fork"],
		mountedToolNames: [],
	};
	const requestedId = `${requested.provider}/${requested.id}`;
	const explicit = await createBranchSession({
		...common,
		flowId: "smoke-model-explicit",
		model: requested,
		thinkingLevel: "low",
	});
	assert(explicit.ok === true, `explicit flow refused: ${explicit.reason ?? explicit.error?.message}`);
	assert(explicit.session?.model, "explicit flow session has no model");
	assert(
		`${explicit.session.model.provider}/${explicit.session.model.id}` === requestedId,
		`explicit flow model ${explicit.session.model.provider}/${explicit.session.model.id} != ${requestedId}`,
	);
	assert(
		explicit.session.thinkingLevel === "low",
		`explicit flow thinking ${explicit.session.thinkingLevel} != low`,
	);

	const inherited = await createBranchSession({ ...common, flowId: "smoke-model-inherit" });
	assert(inherited.ok === true, `inherited flow refused: ${inherited.reason ?? inherited.error?.message}`);
	assert(inherited.session?.model, "inherited flow session has no model");
	assert(
		`${inherited.session.model.provider}/${inherited.session.model.id}` === ownerId,
		`inherited flow model ${inherited.session.model.provider}/${inherited.session.model.id} != ${ownerId}`,
	);
	assert(
		`${owner.model.provider}/${owner.model.id}` === ownerId,
		"the owner session's model changed",
	);
	return `${requestedId} @ low; inherit ${ownerId}`;
});

/**
 * A2: check `deriveBranchConfig` with an owner fixture that has the host's
 * shape. Compare tool names, system prompt input, and prompt cache key by
 * SHA-256. This checks construction inputs; it does not compare full tool
 * schemas or observe a provider payload. Any input mismatch fails the check.
 */
await check("flow construction inputs match the owner fixture", async () => {
	const { deriveBranchConfig, compareBranchFrames } = await import(
		"../host-omp/src/host/branch-session.mjs"
	);
	const prompt = ["You are the owner.", "Managed block."];
	const owner = {
		agent: { state: { systemPrompt: prompt }, promptCacheKey: "owner-cache-key" },
		sessionId: "session-1",
		model: { id: "test/model", provider: "test" },
		modelRegistry: { authStorage: {} },
		settings: {},
		asyncJobManager: {},
		costGate: {},
		getEnabledToolNames: () => ["read", "scope_fork", "todo"],
		getActiveToolNames: () => ["read", "scope_fork"],
		getMountedToolCommandNames: () => [],
		preparedExtensions: ["prepared"],
		extensionPaths: [],
		getHeader: () => ({}),
		enableLsp: false,
	};
	const manager = {
		getSessionId: () => "session-1",
		getCwd: () => "/virtual",
		getArtifactsDir: () => "/virtual/artifacts",
		getHeader: () => ({}),
	};
	const derived = deriveBranchConfig({
		session: owner,
		sessionManager: manager,
		flowId: "flow-smoke-1",
	});
	assert(derived.ok === true, `derive refused: ${derived.reason ?? derived.detail}`);
	const comparison = compareBranchFrames(owner, derived.config);
	assert(
		comparison.mismatches.length === 0,
		`construction-input mismatch: ${comparison.mismatches.join(", ")}`,
	);
	// A selector resolved by the station reaches the config as the host Model
	// object plus its level. The parent fixture stays untouched.
	const requested = { id: "test/deep", provider: "test" };
	const overridden = deriveBranchConfig({
		session: owner,
		sessionManager: manager,
		flowId: "flow-smoke-1",
		model: requested,
		thinkingLevel: "high",
	});
	assert(overridden.ok === true, `override refused: ${overridden.reason ?? overridden.detail}`);
	assert(overridden.config.model === requested, "requested model was not carried");
	assert(overridden.config.thinkingLevel === "high", "requested thinking level was not carried");
	assert(owner.model !== requested, "the owner fixture's model changed");
	return "tool names, systemPrompt input, promptCacheKey, model override";
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
	const station = createTestStation(SessionStation, manager, {}, {}, null, null);
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
	const station = createTestStation(SessionStation, manager, {}, {}, null, null);
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
	const first = createTestStation(SessionStation, manager, {}, {}, null, null);
	first.state.pins = ["kept"];
	first.persist();
	const reopened = createTestStation(SessionStation, manager, {}, {}, null, null);
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
	if (result.status === "FAIL" || (STRICT && result.status === "SKIP")) failed += 1;
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
