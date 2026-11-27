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

const SUBSCOPE = {
	isChild: true,
	role: "devops",
	selfPath: "/api/devops.api",
	hostToolNames: ["read", "write", "bash", "ask", "todo", "wait", "js"],
};

describe("mode priority", () => {
	test("ABANDONED outranks the context limit and canStop so the subscope returns immediately", () => {
		const projection = projectCapabilities({
			...SUBSCOPE,
			abandoned: { by: "/", reason: "taking another path" },
			contextOverHalf: true,
			canStop: true,
		});
		expect(projection.mode).toBe("ABANDONED");
		expect(projection.tools).toEqual(["scope_return"]);
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

	test("a subscope ignores canStop and abandoned on root: only root can finish", () => {
		const projection = projectCapabilities({ ...SUBSCOPE, canStop: true });
		expect(projection.mode).toBe("SUBSCOPE");
		expect(projection.tools).toContain("read");

		const rootAbandoned = projectCapabilities({
			isChild: false,
			abandoned: { by: "/api", reason: "ignored" },
		});
		expect(rootAbandoned.mode).toBe("ROOT_MANUAL");
	});
});

describe("normal scope sets", () => {
	test("a subscope gets the base tools plus its host tools, minus the retired ones", () => {
		const projection = projectCapabilities(SUBSCOPE);

		expect(projection.mode).toBe("SUBSCOPE");
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
			...SUBSCOPE,
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

	test("a subscope never receives ask even when the host lists it", () => {
		expect(projectCapabilities({ ...SUBSCOPE, autopilot: false }).tools).not.toContain("ask");
	});
});

describe("the state object", () => {
	test("a subscope reports its path, balance, and scopes_delta when non-empty", () => {
		const state = projectCapabilities({
			...SUBSCOPE,
			remaining: { read: "2/3" },
			unreceived: 1,
			scopesDelta: {
				"/": "done | m1 | 10k / 200k",
				"/api": "running | m1 | 10k+ / 200k",
			},
		}).state;

		expect(state.scope).toBe("/api/devops.api");
		expect(state.remaining).toEqual({ read: "2/3" });
		expect(state.unreceived).toBe(1);
		expect(state.scopes_delta).toEqual({
			"/": "done | m1 | 10k / 200k",
			"/api": "running | m1 | 10k+ / 200k",
		});
		expect(state.scopes).toBeUndefined();
		expect(state.autopilot).toBeUndefined();
		expect(state.canStop).toBeUndefined();
	});

	test("omits scopes_delta when empty or null", () => {
		const state = projectCapabilities({
			...SUBSCOPE,
			scopesDelta: {},
		}).state;
		expect(state.scopes_delta).toBeUndefined();
	});

	test("root reports autopilot and canStop instead of a balance", () => {
		const state = projectCapabilities({ isChild: false, autopilot: true, canStop: false }).state;
		expect(state.scope).toBe("/");
		expect(state.autopilot).toBe(true);
		expect(state.canStop).toBe(false);
		expect(state.remaining).toBeUndefined();
	});

	test("an abandoned scope carries who abandoned it and optional reason", () => {
		const state = projectCapabilities({
			...SUBSCOPE,
			abandoned: { by: "/ui", reason: "superseded" },
		}).state;
		expect(state.abandoned).toEqual({ by: "/ui", reason: "superseded" });

		const noReason = projectCapabilities({
			...SUBSCOPE,
			abandoned: { by: "/" },
		}).state;
		expect(noReason.abandoned).toEqual({ by: "/" });
	});

	test("the projection is frozen so no consumer can mutate shared truth", () => {
		const projection = projectCapabilities(SUBSCOPE);
		expect(Object.isFrozen(projection)).toBe(true);
		expect(Object.isFrozen(projection.tools)).toBe(true);
		expect(Object.isFrozen(projection.state)).toBe(true);
	});
});

describe("the signature", () => {
	test("changes with the mode, abandoned info, the tools, and the stop flag", () => {
		const abandoned = projectCapabilities({
			...SUBSCOPE,
			abandoned: { by: "/", reason: "stop" },
			canStop: true,
		});
		const idle = projectCapabilities({ ...SUBSCOPE, canStop: true });

		expect(abandoned.signature).not.toBe(idle.signature);
		const otherReason = projectCapabilities({
			...SUBSCOPE,
			abandoned: { by: "/", reason: "other" },
			canStop: true,
		});
		expect(abandoned.signature).not.toBe(otherReason.signature);
	});

	test("covers every value the probe prints, not only the mode", () => {
		// The probe is the trailing message, so rewriting it costs nothing in
		// prefix cache. A signature blind to `remaining` or `scopes_delta` would let a
		// stale budget survive every turn inside one mode and print a lie.
		const variants = [
			{ remaining: { read: "3/3" } },
			{ remaining: { read: "2/3" } },
			{ remaining: { read: "2/3" }, unreceived: 1 },
			{
				remaining: { read: "2/3" },
				unreceived: 1,
				scopesDelta: { "/": "done | m1 | 10k / 200k" },
			},
		].map((variant) => projectCapabilities({ ...SUBSCOPE, ...variant }));
		for (const left of variants) {
			for (const right of variants) {
				if (renderConsoleReceipt(left) === renderConsoleReceipt(right)) continue;
				expect(left.signature).not.toBe(right.signature);
			}
		}
	});

	test("a keyword order change in host tools cannot change it", () => {
		const left = projectCapabilities({ ...SUBSCOPE, hostToolNames: ["read", "bash"] });
		const right = projectCapabilities({ ...SUBSCOPE, hostToolNames: ["bash", "read"] });
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
