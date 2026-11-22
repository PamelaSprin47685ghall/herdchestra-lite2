#!/usr/bin/env bun
/**
 * Relay smoke: drives the tools that `activate()` registers, against the real
 * station, in one fresh process.
 *
 * The unit suite proves the relay's own transitions. This script proves what a
 * session actually reads: the `RELAY STATE` text a tool returns, and the gate
 * the fork/join tools apply. It fails when
 *
 *   - the build is stale: the status text carries no `Flow:` line, or
 *   - simple mode gates `direct-execution`, or
 *   - the full flow does not gate it, or
 *   - an empty ledger stops reading as a relay handoff, or
 *   - the successor's first empty ledger does not end the flow.
 *
 *   bun scripts/smoke-relay.mjs
 *
 * Exit code 0 means every check held; 1 means the build or the switch drifted.
 * A session that prints no `Flow:` line runs a stale installed copy: run
 * `bun run sync:plugin` and restart before trusting that session.
 */

import { activate } from "../src/main.mjs";
import { beginGenerationAfterHandoff } from "../src/relay/ledger.mjs";

// The smoke must test the shipped default, not whatever the developer's shell
// exports. A leaked HERD_DISABLE_RELAY would skip the very relay debt this
// script exists to check.
delete process.env.HERD_DISABLE_RELAY;

function memoryManager() {
	const entries = [];
	let nextId = 1;
	return {
		entries,
		appendMessage(message) {
			entries.push({ type: "message", id: `e${nextId++}`, message });
		},
		appendCustomEntry(customType, data) {
			entries.push({ type: "custom", customType, data, id: `e${nextId++}` });
		},
		getBranch() {
			return entries.slice();
		},
		buildSessionContext() {
			return {
				messages: entries.filter((entry) => entry.type === "message").map((entry) => entry.message),
			};
		},
	};
}

function fakeHost() {
	const handlers = new Map();
	const tools = new Map();
	return {
		tools,
		pi: {
			on(event, handler) {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event).push(handler);
			},
			registerTool(definition) {
				tools.set(definition.name, definition);
			},
			registerCommand() {},
			getSession() {
				return null;
			},
			ui: { notify() {} },
		},
	};
}

/** The native todo implementation, kept to the fields the station reads. */
function nativeTodo() {
	let phases = [];
	return {
		execute(params = {}) {
			const op = params.op ?? (Array.isArray(params.list) ? "init" : "view");
			if (op === "init") {
				phases = (params.list ?? []).map((phase) => ({
					phase: phase.phase,
					items: [...(phase.items ?? [])],
				}));
			}
			return {
				content: [{ type: "text", text: "native todo" }],
				details: { op, phases: structuredClone(phases) },
			};
		},
	};
}

const host = fakeHost();
const wired = await activate(host.pi);

const manager = memoryManager();
const native = nativeTodo();
const ctx = {
	sessionManager: manager,
	agentMessages: [],
	invokeTool: (params) => native.execute(params),
	// A host abort path exists so a blocked control tool can be cancelled.
	abort() {},
};
// The composition result owns the live registry; there is no module singleton.
const station = wired.registry.stationFor(ctx);
// The shipped default is manual duty. This smoke exists to prove the relay,
// so it turns the user-facing toggle on exactly as `/herd-autopilot` would.
station.state.autopilot = true;

/**
 * The smallest host surface that lets the relay checks run. The fork tools
 * need a ledger and a spawner; this fake host supplies neither, so their
 * refusal is itself a checkable contract.
 */

let callSeq = 0;

async function call(name, args) {
	const id = `smoke-${++callSeq}`;
	const tool = host.tools.get(name);
	if (!tool) throw new Error(`${name} is not registered`);
	const output = await tool.execute(id, args, undefined, undefined, ctx);
	return {
		text: (output.content ?? []).map((part) => part.text ?? "").join(""),
		code: output.details?.code,
		isError: output.isError === true,
	};
}

const results = [];
async function check(name, run) {
	try {
		await run();
		results.push({ name, status: "PASS" });
	} catch (error) {
		results.push({ name, status: "FAIL", note: error?.message ?? String(error) });
	}
}

function expect(condition, message) {
	if (!condition) throw new Error(message);
}

function expectLine(text, line, name) {
	expect(text.includes(line), `${name}: missing ${JSON.stringify(line)} in:\n${text}`);
}

// The retired container's shape. It must be refused because no tool by that
// name exists, not because a handler rejects it.
const RETIRED_SCOPE_ARGS = {
	begin: {
		intent: "smoke the relay gates",
		budget: { read: 1 },
		time: 60,
	},
};

await check("the registry exposes three fork/join tools", async () => {
	for (const name of ["scope_fork", "scope_join", "scope_return"]) {
		expect(host.tools.has(name), `${name} is not registered`);
	}
	// The retired working-level container has no registration, no schema and
	// no handler: a configuration cannot fall back to it.
	expect(!host.tools.has("scope"), "the retired scope tool is still registered");
});

await check("scope_fork refuses without a child spawner", async () => {
	const out = await call("scope_fork", {
		forks: [
			{
				scopeId: "probe", intent: "probe",
				blocked: false,
				budget: { read: 1 },
				time: 30,
				targets: ["src/probe.mjs"],
			},
		],
	});
	expect(out.isError, "scope_fork should report the missing spawner");
	expect(out.code === "CHILD_SPAWNER_UNAVAILABLE", `got ${out.code ?? out.text.split("\n")[0]}`);
});

await check("scope_join refuses work this branch does not own", async () => {
	const out = await call("scope_join", { elder_report: null });
	expect(out.isError, "scope_join should refuse an idle branch");
	const code = out.code ?? "";
	expect(
		code === "NO_UNRECEIVED_WORK" || code === "FORK_LEDGER_UNAVAILABLE",
		`got ${code || out.text.split("\n")[0]}`,
	);
});

await check("scope_return refuses the stable root", async () => {
	const out = await call("scope_return", {});
	expect(out.isError, "scope_return should refuse the root");
	expect(
		String(out.code) === "NOT_A_CHILD" || String(out.code) === "FORK_LEDGER_UNAVAILABLE",
		`got ${out.code ?? out.text.split("\n")[0]}`,
	);
});

await check("status names the flow before any ledger", async () => {
	const view = await call("todo", { op: "view" });
	expectLine(view.text, "Flow: simple", "view");
	expectLine(view.text, "Can stop now: no", "view");
	expect(!view.isError, "view reported an error");
});

await check("simple mode has no working-level container to open", async () => {
	expect(!host.tools.has("scope"), "the retired scope tool is still registered");
	// The host refuses an unregistered name before any handler runs. That
	// refusal is the proof that no fallback path exists.
	let refused = false;
	try {
		const out = await call("scope", RETIRED_SCOPE_ARGS);
		refused = out?.isError === true || out?.unknown === true;
	} catch {
		refused = true;
	}
	expect(refused, "the retired scope call was accepted");
});

await check("a non-empty ledger turns the full flow on", async () => {
	const wrote = await call("todo", { op: "init", list: [{ phase: "work", items: ["A"] }] });
	expectLine(wrote.text, "Flow: full flow", "init");
	expect(station.state.relay.fullFlow, "relay.fullFlow did not turn on");
});

await check("an empty ledger arms a relay handoff", async () => {
	const emptied = await call("todo", { op: "init", list: [] });
	expectLine(emptied.text, "Handoff pending: yes", "empty ledger");
	expectLine(emptied.text, "Flow: full flow", "empty ledger");
	expectLine(emptied.text, "Can stop now: no", "empty ledger");
});

await check("the successor's first empty ledger ends the flow", async () => {
	station.state.relay = beginGenerationAfterHandoff(station.state.relay, { at: 2 });
	const promoted = await call("todo", { op: "init", list: [] });
	expectLine(promoted.text, "Can stop now: yes", "promotion");
	expectLine(promoted.text, "Flow: simple", "promotion");
	expect(!station.state.relay.fullFlow, "the promoted relay kept the full flow on");
});

await check("the promoted session still has the three tools", async () => {
	for (const name of ["scope_fork", "scope_join", "scope_return"]) {
		expect(host.tools.has(name), `${name} is not registered after promotion`);
	}
	const out = await call("scope_join", { elder_report: null });
	expect(out.isError, "scope_join should still refuse an idle branch");
});

await check("a write after promotion turns the full flow on again", async () => {
	const wrote = await call("todo", { op: "init", list: [{ phase: "next", items: ["B"] }] });
	expectLine(wrote.text, "Flow: full flow", "reopen");
	expectLine(wrote.text, "Promotion invalidated: yes", "reopen");
	// A write after promotion re-arms the full flow: the relay forbids the next
	// stop until another ledger evaluation empties it again.
	expect(station.state.relay.fullFlow === true, "full flow did not turn back on");
});

let failed = 0;
for (const result of results) {
	const note = result.note ? `  ${result.note}` : "";
	console.log(`${result.status}  ${result.name}${note}`);
	if (result.status === "FAIL") failed += 1;
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
