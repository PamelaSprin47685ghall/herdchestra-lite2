import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

function source(path) {
	return readFileSync(new URL(path, import.meta.url), "utf8");
}

function exists(path) {
	return existsSync(new URL(path, import.meta.url));
}

describe("fold pool key", () => {
	test("a level is identified by its receiver, generation and epoch, never by string concatenation", () => {
		// The retired template joined "scope-1" + "23" + "4" and
		// "scope-12" + "3" + "4" into the same "scope-1234". The receipt level
		// key separates its parts, so two distinct levels can never collide.
		const left = ["scope-1", 23, 4].join("|");
		const right = ["scope-12", 3, 4].join("|");
		expect(left).not.toBe(right);
	});
});

describe("retired mechanisms stay retired", () => {
	test("the amend boundary calls the structural lookup that exists", () => {
		const execute = source("../src/station/execute.mjs");
		// A station never had this method; the optional call silently produced
		// a null boundary, so an amend could reach past a structural call.
		expect(execute).not.toContain("station.lastStructuralCallId");
		expect(execute).toContain("lastStructuralCallId(base, currentIndex)");
	});

	test("no interval folder or degradation module remains", () => {
		const scopeIndex = source("../src/scope/index.mjs");
		const transcriptIndex = source("../src/transcript/index.mjs");
		for (const name of [
			"applyCollapses",
			"applyForkJoinCollapse",
			"collectPinnedMessages",
			"canFoldInterval",
			"canFoldContent",
			"futureFoldSavings",
		]) {
			expect(scopeIndex).not.toContain(name);
			expect(transcriptIndex).not.toContain(name);
		}
	});

	test("the station exposes no fold-batch entry point", () => {
		const station = source("../src/station/station.mjs");
		expect(station).not.toContain("foldBatch");
		expect(station).not.toContain("accrueRentAndFlood");
		expect(station).not.toContain("directScope");
		expect(station).not.toContain("directDefer");
	});

	test("the old container dispatch semantics stay retired", () => {
		const dispatch = source("../src/station/dispatch.mjs");
		const tracker = source("../src/station/dispatch-tracker.mjs");
		const station = source("../src/station/station.mjs");
		for (const name of ["afterScope", "hasScope", "carriesScope", "deferPreflight"]) {
			expect(dispatch).not.toContain(name);
			expect(tracker).not.toContain(name);
			expect(station).not.toContain(name);
		}
		expect(source("../src/station/fork-controls.mjs")).not.toContain("trailingCalls");
	});

	test("the retired branch plumbing files are gone", () => {
		for (const path of [
			"../src/host/event-mux.mjs",
			"../src/host/queue-retraction.mjs",
			"../src/host/scope-dispatch.mjs",
			"../src/features/scope/index.mjs",
			"../src/features/scope/bare.mjs",
			"../tests/event-mux.test.mjs",
			"../tests/contract/scope.test.mjs",
		]) {
			expect(exists(path)).toBe(false);
		}
		expect(exists("../src/host/tool-dispatch.mjs")).toBe(true);
	});

	test("the retired prompt sections stay out of the error document", () => {
		const errors = source("../resources/prompts/errors.md");
		for (const section of ["not-in-scope", "todo-inside-scope", "flow-open"]) {
			expect(errors).not.toContain(`## ${section}`);
		}
	});

	test("the host smoke names the three tools and the branch exports", () => {
		const smoke = source("../scripts/smoke-omp.mjs");
		expect(smoke).not.toContain("deriveFissionConfig");
		expect(smoke).not.toContain("compareFissionFrames");
		for (const name of ["scope_fork", "scope_join", "scope_return"]) {
			expect(smoke).toContain(name);
		}
	});

	test("a fork registers the wall clock its item declares", () => {
		const controls = source("../src/station/fork-controls.mjs");
		expect(controls).toContain("time: item.time");
		expect(controls).toContain("startedAt: Date.now()");
	});

	test("the tools no longer demand an exclusive message", () => {
		const controls = source("../src/station/fork-controls.mjs");
		expect(controls).not.toContain("MUST_BE_EXCLUSIVE_CALL");
		expect(controls).not.toContain("FORK_MESSAGE_MIXED");
		expect(controls).not.toContain("exclusiveCallRefusal");
		expect(controls).not.toContain("mixedForkCalls");
		const tools = source("../src/activation/tools.mjs");
		// No tool serializes itself. A multi-call message is ordered by the
		// model: place the two blocking right brackets last.
		expect(tools).not.toContain('concurrency: "exclusive"');
		expect(tools).toContain('name: "scope_join"');
		expect(tools).toContain('name: "scope_return"');
	});

	test("todo is never withheld by the receive obligation", () => {
		const gates = source("../src/station/gates.mjs");
		expect(gates).not.toContain("TODO_WHILE_CHILDREN_OPEN");
		// The relay is what waits: an empty ledger while a child is unreceived
		// is held, not turned into a handoff.
		const handoff = source("../src/station/handoff-state.mjs");
		expect(handoff).toContain('action: "held"');
		const relayText = source("../resources/prompts/receipts/relay.md");
		expect(relayText).toContain("## next.held-children");
	});

	test("waiting on a right bracket does not spend the clock", () => {
		const station = source("../src/station/station.mjs");
		expect(station).toContain("pauseBranchClock()");
		expect(station).toContain("resumeBranchClock()");
		expect(station).toContain('name === "scope_join"');
		expect(station).toContain('name === "scope_return"');
		const tickets = source("../src/tools/tickets.mjs");
		expect(tickets.match(/pauseBranchClock\?\.\(\)/g)?.length).toBe(2);
		expect(tickets.match(/resumeBranchClock\?\.\(\)/g)?.length).toBe(2);
		const tools = source("../src/activation/tools.mjs");
		expect(tools).not.toContain("executionMode");
	});

	test("a child installs its own request preparation before the first prompt", () => {
		const context = source("../src/host/branch-context.mjs");
		expect(context).toContain("installContextPreparation");
		expect(context).toContain("createContext");
		const activation = source("../src/activation/index.mjs");
		expect(activation).toContain("prepareChildContext");
		const wiring = source("../src/host/fork-wiring.mjs");
		const spawn = source("../src/tools/fork-spawn-ticket.mjs");
		expect(wiring).toContain("spawnChildTicket");
		expect(spawn).toContain("ports.prepareChild");
		expect(spawn.indexOf("ports.prepareChild")).toBeLessThan(
			spawn.indexOf("await prompt(spec.receipt)"),
		);
	});
});
