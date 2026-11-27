// Capability projection: the single source of truth for what the model may
// call this turn.
//
// The projection is load-bearing in three places at once — the REPL probe
// text, the `api` object the js ticket builds, and the capSig that decides
// whether a committed probe can be reused. A wrong mode or a leaked tool name
// is visible to the user as a call that fails for no reason, so each rule is
// pinned here.

import { describe, expect, test } from "bun:test";

import {
	BASE_TOOLS,
	EXCLUDED_HOST_TOOLS,
	forkRemaining,
	projectCapabilities,
	renderConsoleReceipt,
} from "../src/station/domain/capabilities.mjs";

const CHILD = {
	isChild: true,
	selfPath: "/api",
	hostToolNames: ["read", "write", "bash", "ask", "todo", "wait", "js"],
};

describe("mode priority", () => {
	test("a queued request outranks the context limit so the caller is unblocked", () => {
		const projection = projectCapabilities({
			...CHILD,
			pendingRequest: { id: "req-1", from: "/", message: "which field?" },
			contextOverHalf: true,
			canStop: true,
		});
		expect(projection.mode).toBe("AWAITING_REPLY");
		expect(projection.tools).toEqual(["scope_reply"]);
	});

	test("the context limit outranks the final answer", () => {
		const projection = projectCapabilities({
			isChild: false,
			contextOverHalf: true,
			canStop: true,
		});
		expect(projection.mode).toBe("CONTEXT_LIMIT");
		expect(projection.tools).toEqual(["scope_return"]);
	});

	test("a root that finished its second oath has no tools at all", () => {
		const projection = projectCapabilities({ isChild: false, canStop: true });
		expect(projection.mode).toBe("FINAL_ANSWER");
		expect(projection.tools).toEqual([]);
	});

	test("a child ignores canStop: only root can finish", () => {
		const projection = projectCapabilities({ ...CHILD, canStop: true });
		expect(projection.mode).toBe("CHILD");
		expect(projection.tools).toContain("read");
	});
});

describe("normal scope sets", () => {
	test("a child gets the base tools plus its host tools, minus the retired ones", () => {
		const projection = projectCapabilities(CHILD);

		expect(projection.mode).toBe("CHILD");
		for (const name of BASE_TOOLS) expect(projection.tools).toContain(name);
		expect(projection.tools).toContain("read");
		expect(projection.tools).toContain("write");
		expect(projection.tools).toContain("bash");
		// ask is the root's user channel; todo is retired; wait is a base tool;
		// js is the executor itself.
		expect(projection.tools).not.toContain("ask");
		expect(projection.tools).not.toContain("todo");
		expect(projection.tools).not.toContain("js");
		expect(projection.tools.filter((name) => name === "wait")).toHaveLength(1);
	});

	test("the tool list is sorted and carries no duplicates", () => {
		const tools = projectCapabilities({
			...CHILD,
			hostToolNames: ["write", "read", "read"],
		}).tools;
		expect(tools).toEqual([...tools].sort());
		expect(new Set(tools).size).toBe(tools.length);
	});

	test("root in autopilot has no ask; root in manual mode does", () => {
		expect(projectCapabilities({ isChild: false, autopilot: true }).tools).not.toContain("ask");
		expect(projectCapabilities({ isChild: false, autopilot: false }).tools).toContain("ask");
		expect(projectCapabilities({ isChild: false, autopilot: true }).mode).toBe("ROOT_AUTOPILOT");
		expect(projectCapabilities({ isChild: false, autopilot: false }).mode).toBe("ROOT_MANUAL");
	});

	test("a child never receives ask even when the host lists it", () => {
		expect(projectCapabilities({ ...CHILD, autopilot: false }).tools).not.toContain("ask");
	});

	test("scope_reply exists only inside AWAITING_REPLY", () => {
		expect(projectCapabilities(CHILD).tools).not.toContain("scope_reply");
		expect(
			projectCapabilities({ ...CHILD, pendingRequest: { id: "r", from: "/", message: "m" } })
				.tools,
		).toEqual(["scope_reply"]);
	});
});

describe("the state object", () => {
	test("a child reports its path, balance, and tree", () => {
		const state = projectCapabilities({
			...CHILD,
			remaining: { read: "2/3" },
			unreceived: 1,
			activePaths: ["/", "/api", "/ui"],
		}).state;

		expect(state.scope).toBe("/api");
		expect(state.remaining).toEqual({ read: "2/3" });
		expect(state.unreceived).toBe(1);
		expect(state.scopes).toEqual(["/", "/api", "/ui"]);
		expect(state.autopilot).toBeUndefined();
		expect(state.canStop).toBeUndefined();
	});

	test("root reports autopilot and canStop instead of a balance", () => {
		const state = projectCapabilities({ isChild: false, autopilot: true, canStop: false }).state;
		expect(state.scope).toBe("/");
		expect(state.autopilot).toBe(true);
		expect(state.canStop).toBe(false);
		expect(state.remaining).toBeUndefined();
	});

	test("an awaiting scope carries who asked and what they asked", () => {
		const state = projectCapabilities({
			...CHILD,
			pendingRequest: { id: "req-9", from: "/ui", message: "field name?" },
		}).state;
		expect(state.request).toEqual({ from: "/ui", message: "field name?" });
	});

	test("the projection is frozen so no consumer can mutate shared truth", () => {
		const projection = projectCapabilities(CHILD);
		expect(Object.isFrozen(projection)).toBe(true);
		expect(Object.isFrozen(projection.tools)).toBe(true);
		expect(Object.isFrozen(projection.state)).toBe(true);
	});
});

describe("the signature", () => {
	test("changes with the mode, the queued request, the tools, and the stop flag", () => {
		const pending = projectCapabilities({
			...CHILD,
			pendingRequest: { id: "req-3", from: "/", message: "m" },
			canStop: true,
		});
		const idle = projectCapabilities({ ...CHILD, canStop: true });

		expect(pending.signature).not.toBe(idle.signature);
		// The request id stays outside the hash: a second request carrying the
		// same text still needs its own delivery turn.
		expect(pending.signature).toContain("req-3");
	});

	test("covers every value the probe prints, not only the mode", () => {
		// The probe is the trailing message, so rewriting it costs nothing in
		// prefix cache. A signature blind to `remaining` or `scopes` would let a
		// stale budget survive every turn inside one mode and print a lie.
		const variants = [
			{ remaining: { read: "3/3" } },
			{ remaining: { read: "2/3" } },
			{ remaining: { read: "2/3" }, unreceived: 1 },
			{
				remaining: { read: "2/3" },
				unreceived: 1,
				activePaths: ["/", "/api", "/ui"],
			},
		].map((variant) => projectCapabilities({ ...CHILD, ...variant }));
		for (const left of variants) {
			for (const right of variants) {
				if (renderConsoleReceipt(left) === renderConsoleReceipt(right)) continue;
				expect(left.signature).not.toBe(right.signature);
			}
		}
	});

	test("a keyword order change in host tools cannot change it", () => {
		const left = projectCapabilities({ ...CHILD, hostToolNames: ["read", "bash"] });
		const right = projectCapabilities({ ...CHILD, hostToolNames: ["bash", "read"] });
		expect(left.signature).toBe(right.signature);
	});
});

describe("forkRemaining", () => {
	test("prints what is left over what was granted, never what was used", () => {
		const remaining = forkRemaining(
			{ remaining: { read: 2, edit: 1 }, budget: { read: 3, edit: 2 } },
			0,
		);
		expect(remaining).toEqual({ read: "2/3", edit: "1/2" });
	});

	test("keeps cent precision and trims whole numbers", () => {
		const remaining = forkRemaining(
			{ remaining: { read: 1.5, edit: 2 }, budget: { read: 3, edit: 4 } },
			0,
		);
		expect(remaining.read).toBe("1.5/3");
		expect(remaining.edit).toBe("2/4");
	});

	test("reports the clock only when the branch is bounded", () => {
		const clock = { info: () => ({ bounded: true, overtime: false, leftMs: 60_000 }) };
		const bounded = forkRemaining(
			{ remaining: {}, budget: {}, timeBudgetMs: 180_000 },
			0,
			clock,
		);
		expect(bounded.time).toBe("1:00 left of 3:00");

		const unbounded = forkRemaining(
			{ remaining: {}, budget: {} },
			0,
			{ info: () => ({ bounded: false, overtime: false, leftMs: 0 }) },
		);
		expect(unbounded.time).toBeUndefined();
	});

	test("collapses an overrun to OVERTIME instead of a negative clock", () => {
		const remaining = forkRemaining(
			{ remaining: {}, budget: {}, timeBudgetMs: 180_000 },
			0,
			{ info: () => ({ bounded: true, overtime: true, leftMs: -5 }) },
		);
		expect(remaining.time).toBe("OVERTIME");
	});

	test("mentions panhandles only when there were any", () => {
		expect(forkRemaining({ remaining: {}, budget: {}, panhandleTotal: 2 }, 0).panhandled).toBe(2);
		expect(forkRemaining({ remaining: {}, budget: {}, panhandles: ["read"] }, 0).panhandled).toBe(1);
		expect(forkRemaining({ remaining: {}, budget: {}, panhandleTotal: 0 }, 0).panhandled).toBeUndefined();
	});

	test("degrades to an empty object without a record", () => {
		expect(forkRemaining(null)).toEqual({});
		expect(forkRemaining({})).toEqual({});
	});

	test("skips a tool whose grant was never recorded", () => {
		expect(forkRemaining({ remaining: { read: 1 }, budget: {} }, 0)).toEqual({});
	});

	test("excluded host tools stay excluded from every child set", () => {
		for (const name of ["ask", "todo", "wait", "js"]) {
			expect(EXCLUDED_HOST_TOOLS.has(name)).toBe(true);
		}
	});
});
