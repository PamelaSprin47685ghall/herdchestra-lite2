import { describe, expect, test } from "bun:test";
import { SCOPE_ID_PATTERN, validScopeId } from "../src/scope/scope-id.mjs";
import { decideAbandonRequest } from "../src/scope/abandon.mjs";
import {
	EXEC_TOOLS,
	INSPECTOR_HOST_TOOLS,
	ROLES,
	canActOn,
	isConcreteFilePath,
	roleBudgetAllowed,
	roleOfPath,
	roleOfSegment,
	roleRank,
	roleTools,
	runningDevops,
	validEditorTargets,
	validRoleSegment,
} from "../src/scope/roles.mjs";

const running = (path, extra = {}) => ({
	path,
	status: "running",
	abandonRequested: false,
	...extra,
});

describe("role names", () => {
	test("root is a manager and a path's role is its last segment", () => {
		expect(roleOfPath("/")).toBe("manager");
		expect(roleOfPath("/manager.tom")).toBe("manager");
		expect(roleOfPath("/manager.tom/devops.alice")).toBe("devops");
		expect(roleOfPath("/manager.tom/devops.alice/editor.eve")).toBe("editor");
		expect(roleOfPath("/manager.tom/inspector.peter")).toBe("inspector");
	});

	test("a segment without a role has none", () => {
		expect(roleOfSegment("worker")).toBeNull();
		expect(roleOfSegment("editor.eve")).toBe("editor");
		expect(roleOfPath("/manager.tom/worker")).toBeNull();
		expect(validRoleSegment("devops.alice")).toBe(true);
		expect(validRoleSegment("alice")).toBe(false);
		expect(validRoleSegment("devops.")).toBe(false);
	});

	test("scope ids require a role segment", () => {
		expect(typeof SCOPE_ID_PATTERN).toBe("string");
		expect(validScopeId("editor.eve")).toBe(true);
		expect(validScopeId("manager.tom")).toBe(true);
		expect(validScopeId("inspector.peter-2")).toBe(true);
		expect(validScopeId("worker")).toBe(false);
		expect(validScopeId("editor.")).toBe(false);
		expect(validScopeId("editor eve")).toBe(false);
	});
});

describe("privilege rank", () => {
	test("rank descends manager > devops > editor > inspector", () => {
		expect(roleRank("manager")).toBe(0);
		expect(roleRank("devops")).toBe(1);
		expect(roleRank("editor")).toBe(2);
		expect(roleRank("inspector")).toBe(3);
		expect(roleRank("worker")).toBeNull();
		expect(ROLES).toEqual(["manager", "devops", "editor", "inspector"]);
	});

	test("a caller acts only on its own role or a narrower one", () => {
		for (const target of ROLES) expect(canActOn("manager", target)).toBe(true);
		expect(canActOn("devops", "manager")).toBe(false);
		expect(canActOn("devops", "devops")).toBe(true);
		expect(canActOn("devops", "editor")).toBe(true);
		expect(canActOn("editor", "devops")).toBe(false);
		expect(canActOn("editor", "editor")).toBe(true);
		expect(canActOn("editor", "inspector")).toBe(true);
		expect(canActOn("inspector", "editor")).toBe(false);
		expect(canActOn("inspector", "inspector")).toBe(true);
		expect(canActOn("manager", "worker")).toBe(false);
	});
});

describe("role tool surface", () => {
	const host = ["read", "grep", "edit", "write", "bash", "eval", "task", "glob"];

	test("manager holds no host tool", () => {
		expect(roleTools("manager", host)).toEqual([]);
		expect(roleTools(null, host)).toEqual([]);
	});

	test("inspector holds only its read-only surface", () => {
		expect(roleTools("inspector", host)).toEqual(["read", "grep", "glob"]);
		for (const name of roleTools("inspector", host)) {
			expect(INSPECTOR_HOST_TOOLS.has(name)).toBe(true);
			expect(EXEC_TOOLS.has(name)).toBe(false);
		}
	});

	test("editor loses every command runner and work spawner", () => {
		const tools = roleTools("editor", host);
		expect(tools).toEqual(["read", "grep", "edit", "write", "glob"]);
		for (const name of ["bash", "eval", "task"]) expect(tools).not.toContain(name);
	});

	test("devops keeps every host tool", () => {
		expect(roleTools("devops", host)).toEqual(host);
	});
});

describe("role budget", () => {
	test("a manager may only pass an empty budget", () => {
		expect(roleBudgetAllowed("manager", {})).toBe(true);
		expect(roleBudgetAllowed("manager", { read: 1 })).toBe(false);
		expect(roleBudgetAllowed("manager", { bash: 1 })).toBe(false);
	});

	test("an inspector may only fund its read-only surface", () => {
		expect(roleBudgetAllowed("inspector", {})).toBe(true);
		expect(roleBudgetAllowed("inspector", { read: 2, grep: 1 })).toBe(true);
		expect(roleBudgetAllowed("inspector", { bash: 1 })).toBe(false);
	});

	test("an editor may not fund a command runner", () => {
		expect(roleBudgetAllowed("editor", { edit: 2, write: 1 })).toBe(true);
		expect(roleBudgetAllowed("editor", { bash: 1 })).toBe(false);
		expect(roleBudgetAllowed("editor", { eval: 1 })).toBe(false);
		expect(roleBudgetAllowed("editor", { task: 1 })).toBe(false);
	});

	test("devops may fund any host tool", () => {
		expect(roleBudgetAllowed("devops", { bash: 3, eval: 1 })).toBe(true);
	});
});

describe("editor targets", () => {
	test("concrete files pass", () => {
		expect(validEditorTargets(["src/scope/path.mjs"])).toBe(true);
		expect(validEditorTargets(["src/a.mjs", "tests/b.test.mjs"])).toBe(true);
		expect(isConcreteFilePath("Makefile")).toBe(true);
		expect(isConcreteFilePath(".gitignore")).toBe(true);
	});

	test("prose, globs, and directories fail", () => {
		expect(validEditorTargets([])).toBe(false);
		expect(validEditorTargets(["src/"])).toBe(false);
		expect(validEditorTargets(["src/*.mjs"])).toBe(false);
		expect(validEditorTargets(["fix the bug"])).toBe(false);
		expect(validEditorTargets(["src"])).toBe(false);
		expect(isConcreteFilePath("src/**/x.mjs")).toBe(false);
	});
});

describe("devops mutex", () => {
	test("finds the one running devops only", () => {
		expect(runningDevops([])).toBeNull();
		const live = running("/manager.tom/devops.alice");
		expect(runningDevops([live])).toBe(live);
		expect(runningDevops([running("/manager.tom/devops.alice", { status: "done" })])).toBeNull();
		expect(runningDevops([running("/manager.tom/editor.eve")])).toBeNull();
		expect(runningDevops([{ path: "/x/devops.legacy", status: "running", role: "devops" }])).not.toBeNull();
	});
});

describe("abandon privilege", () => {
	test("an inspector cannot abandon a manager or a devops", () => {
		const spy = "/manager.tom/inspector.spy";
		expect(
			decideAbandonRequest({ targetPath: "/manager.tom", callerPath: spy, record: running("/manager.tom") }).code,
		).toBe("ROLE_ESCALATION");
		expect(
			decideAbandonRequest({
				targetPath: "/manager.tom/devops.alice",
				callerPath: spy,
				record: running("/manager.tom/devops.alice"),
			}).code,
		).toBe("ROLE_ESCALATION");
	});

	test("a manager may abandon a narrower role", () => {
		const decision = decideAbandonRequest({
			targetPath: "/manager.tom/editor.eve",
			callerPath: "/manager.tom",
			record: running("/manager.tom/editor.eve"),
		});
		expect(decision.ok).toBe(true);
	});

	test("root cannot be abandoned, a scope cannot abandon itself", () => {
		expect(decideAbandonRequest({ targetPath: "/", callerPath: "/manager.tom" }).code).toBe(
			"CANNOT_ABANDON_ROOT",
		);
		expect(
			decideAbandonRequest({
				targetPath: "/manager.tom/editor.eve",
				callerPath: "/manager.tom/editor.eve",
				record: running("/manager.tom/editor.eve"),
			}).code,
		).toBe("CANNOT_ABANDON_SELF");
	});

	test("a finished scope refuses, a repeated request is idempotent", () => {
		expect(
			decideAbandonRequest({
				targetPath: "/manager.tom/editor.eve",
				callerPath: "/manager.tom",
				record: running("/manager.tom/editor.eve", { status: "done" }),
			}).code,
		).toBe("SCOPE_ALREADY_DONE");
		const again = decideAbandonRequest({
			targetPath: "/manager.tom/editor.eve",
			callerPath: "/manager.tom",
			record: running("/manager.tom/editor.eve", { abandonRequested: true }),
		});
		expect(again.ok).toBe(true);
		expect(again.alreadyAbandoning).toBe(true);
	});
});

import { createBracketLedger, registerFork } from "../src/scope/forkjoin.mjs";
import { handleForkCall } from "../src/station/fork-controls.mjs";
import { BASE_TOOLS, projectCapabilities } from "../src/station/domain/capabilities.mjs";

function forkStation(ledger, { identity = null, spawned = [] } = {}) {
	return {
		state: { receipts: [], relay: { generation: 0, fullFlow: false } },
		forkLedgerPort: () => ledger,
		forkIdentityPort: () => identity,
		forkOwnerId: () => identity?.forkId ?? "root",
		contextMessages: () => [],
		currentContextTokens: () => 0,
		tokensPerCharFor: () => 1,
		childOutcomePort: () => null,
		usage: { lastUsageModelKey: null },
		childSpawnPort: () => (spec) => spawned.push(spec),
	};
}

function forkItem(overrides = {}) {
	return {
		path: "editor.eve",
		fsm: "edit the parser",
		profession: "You are a careful editor like Ada Lovelace.",
		n: 1,
		budget: { edit: 1 },
		targets: ["src/parser.mjs"],
		...overrides,
	};
}

const forkCall = (station, ...items) =>
	handleForkCall(station, { id: "call", arguments: { forks: items } });

describe("role gates at the fork handler", () => {
	test("an inspector cannot open a manager above it", () => {
		const ledger = createBracketLedger();
		registerFork(ledger, {
			forkId: "spy",
			path: "/manager.tom/inspector.spy",
			ownerId: "root",
			fsm: "look around",
			depth: 1,
		});
		const out = forkCall(forkStation(ledger, { identity: { forkId: "spy" } }), {
			path: "manager.bob",
			fsm: "plan more",
			profession: "You are a planner like Ada Lovelace.",
			n: 1,
		});
		expect(out.isError).toBe(true);
		expect(out.details.code).toBe("ROLE_ESCALATION");
		expect(ledger.order).toEqual(["spy"]);
	});

	test("a second devops is refused while one is running", () => {
		const ledger = createBracketLedger();
		registerFork(ledger, {
			forkId: "live",
			path: "/manager.tom/devops.alice",
			ownerId: "root",
			fsm: "run the gate",
			depth: 1,
		});
		const out = forkCall(
			forkStation(ledger),
			forkItem({ path: "devops.bob", budget: { bash: 1 }, targets: ["src/a.mjs"] }),
		);
		expect(out.isError).toBe(true);
		expect(out.details.code).toBe("DEVOPS_ALREADY_RUNNING");
		expect(out.details.activePath).toBe("/manager.tom/devops.alice");
	});

	test("two devops in one batch reject the whole batch", () => {
		const ledger = createBracketLedger();
		const spawned = [];
		const out = forkCall(
			forkStation(ledger, { spawned }),
			forkItem({ path: "devops.a", budget: { bash: 1 }, targets: ["src/a.mjs"] }),
			forkItem({ path: "devops.b", budget: { bash: 1 }, targets: ["src/b.mjs"] }),
		);
		expect(out.isError).toBe(true);
		expect(out.details.code).toBe("DEVOPS_ALREADY_RUNNING");
		expect(out.details.index).toBe(1);
		expect(ledger.order).toEqual([]);
		expect(spawned).toEqual([]);
	});

	test("an editor must name concrete files, not prose", () => {
		const out = forkCall(
			forkStation(createBracketLedger()),
			forkItem({ targets: ["fix the bug you find"] }),
		);
		expect(out.isError).toBe(true);
		expect(out.details.code).toBe("INVALID_EDITOR_TARGETS");
	});

	test("a manager with no budget and no targets starts", () => {
		const ledger = createBracketLedger();
		const spawned = [];
		const out = forkCall(forkStation(ledger, { spawned }), {
			path: "manager.tom",
			fsm: "plan the work",
			profession: "You are a planner like Ada Lovelace.",
			n: 2,
		});
		expect(out.isError).toBeUndefined();
		expect(spawned).toHaveLength(1);
		expect(ledger.order).toEqual(["call"]);
	});

	test("a manager may not fund a host tool", () => {
		const out = forkCall(
			forkStation(createBracketLedger()),
			forkItem({ path: "manager.tom", budget: { read: 1 } }),
		);
		expect(out.isError).toBe(true);
		expect(out.details.code).toBe("FORBIDDEN_ROLE_BUDGET");
		expect(out.details.role).toBe("manager");
	});

	test("the projection narrows host tools to the role", () => {
		const hostToolNames = ["read", "edit", "write", "bash", "eval", "task", "grep", "glob"];
		const toolsFor = (role) =>
			projectCapabilities({ isChild: true, role, selfPath: `/x/${role}.a`, hostToolNames }).tools;

		expect(toolsFor("manager")).toEqual([...BASE_TOOLS].sort());
		expect(toolsFor("inspector")).toEqual(["glob", "grep", "read", "scope_abandon", "scope_fork", "scope_join", "scope_return", "wait"]);
		expect(toolsFor("editor")).not.toContain("bash");
		expect(toolsFor("editor")).toContain("edit");
		expect(toolsFor("inspector")).not.toContain("edit");
		expect(toolsFor("devops")).toContain("bash");
		expect(projectCapabilities({ isChild: true, role: "inspector", selfPath: "/x/inspector.a", hostToolNames }).state.role).toBe("inspector");
	});
});
