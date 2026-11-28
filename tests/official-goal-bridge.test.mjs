// Official /goal bridge: the whole consumer-visible contract.
//
// Root's `api.goal` is static, herd owns Phase 1, and Phase 2 hands the work
// to omp's official goal without changing the prompt prefix. The tests drive
// the real command/station surface; the host's mode facade and goal runtime are
// recording doubles because they belong to omp, not to this package.

import { describe, expect, test } from "bun:test";

import { confiscateContext } from "../host-omp/src/host/tool-confiscation.mjs";
import {
	activatePrintGoalFromPrompt,
	executeWrappedGoalTool,
	goalSessionTicket,
	handleGoalInput,
	needsGoalPreload,
	preloadOfficialGoalTool,
	shouldActivatePrintGoal,
} from "../host-omp/src/host/tickets/goal.mjs";
import { decideGoalToolCall } from "../src/station/domain/goal-fallback.mjs";
import { onSessionStop } from "../src/station/gates.mjs";
import { SessionStation } from "../src/station/station.mjs";
import { createTestStation } from "./helpers/station-ports.mjs";

function station(prompts = []) {
	return createTestStation(
		SessionStation,
		{ getSessionId: () => "s1" },
		{},
		{ canPrompt: true, prompt: (text) => prompts.push(text) },
		{ ports: () => ({ herd: "on" }) },
		null,
	);
}

/** Build a station whose host ticket is bound the way the composition root binds it. */
function goalStation(pi = {}) {
	let owner = null;
	const tickets = {
		canPrompt: true,
		prompt: () => {},
		goalSession: (ctx, spec) => goalSessionTicket(pi, ctx, spec, owner),
	};
	owner = createTestStation(
		SessionStation,
		{ getSessionId: () => "s1" },
		{},
		tickets,
		{ ports: () => ({ herd: "on" }) },
		null,
	);
	return owner;
}

/** A recording goal runtime, the surface `api.goal` delegates to. */
function runtime(initial = "active") {
	const calls = [];
	let status = initial;
	const state = () => ({
		enabled: status !== "complete" && status !== "dropped",
		goal: status === "none" ? null : { id: "g1", objective: "ship it", status },
	});
	return {
		calls,
		getState: () => state(),
		createGoal: async (spec) => {
			calls.push(["create", spec.objective]);
			status = "active";
		},
		replaceGoal: async (spec) => {
			calls.push(["replace", spec.objective]);
			status = "active";
		},
		dropGoal: async () => {
			calls.push(["drop"]);
			status = "none";
		},
		pauseGoal: async () => {
			calls.push(["pause"]);
			status = "paused";
		},
		resumeGoal: async () => {
			calls.push(["resume"]);
			status = "active";
		},
		completeGoalFromTool: async () => {
			calls.push(["complete"]);
			status = "complete";
			return { goal: { id: "g1", status: "complete" } };
		},
		setTokenBudget: async (budget) => calls.push(["budget", budget]),
		buildContinuationPrompt: () => "Continue active goal.",
	};
}

function runtimeContext(goalRuntime) {
	const session = {
		goalRuntime,
		setGoalModeState: () => {},
		prompt: async () => {},
		getGoalModeState: () => goalRuntime.getState(),
	};
	return { session };
}

function modeContext(goal = "inactive") {
	const calls = [];
	let current = goal;
	return {
		calls,
		sessionModes: {
			getState: () => ({ plan: "inactive", goal: current, vibe: "inactive", loop: "inactive" }),
			set: async (request) => {
				calls.push(request);
				if (request.action === "drop") current = "inactive";
				if (request.action === "enter") current = "active";
				return { ok: true, changed: true };
			},
		},
	};
}

describe("C1 — zero prefix-cache bust", () => {
	test("session_start preloads goal before turn 1 and re-hides it", async () => {
		const enabled = ["js", "read"];
		const jsTool = { name: "js", execute: async () => ({}) };
		const agent = { state: { tools: [jsTool, { name: "goal", execute: async () => ({}) }] } };
		const session = {
			getEnabledToolNames: () => enabled,
			setActiveToolsByName: async (names) => {
				enabled.splice(0, enabled.length, ...names);
			},
		};
		const ctx = { session, agent };

		expect(needsGoalPreload(ctx)).toBe(true);
		expect(await preloadOfficialGoalTool(ctx)).toBe(true);
		expect(enabled).toContain("goal");

		confiscateContext(() => ({ isReadOnlySubagent: () => false }), ctx);
		expect(agent.state.tools).toEqual([jsTool]);
	});
});

describe("W1 — the wrapped api.goal", () => {
	test("phase 1 and unreceived work block completion", () => {
		expect(
			decideGoalToolCall({ op: "complete", relayGoal: true, goalFallback: false }),
		).toMatchObject({ allowed: false, phase: "herd_priority" });
		expect(
			decideGoalToolCall({ op: "complete", unreceived: 1, relayGoal: true, goalFallback: true }),
		).toMatchObject({ allowed: false, phase: "official_fallback" });
		expect(
			decideGoalToolCall({ op: "complete", relayGoal: true, goalFallback: true }),
		).toEqual({ allowed: true, phase: "official_fallback", reason: null });
	});

	test("completion is refused in Phase 1 and ends the herd session in Phase 2", async () => {
		const owner = station();
		const goalRuntime = runtime();
		const ctx = runtimeContext(goalRuntime);
		owner.state.relay.goal = true;
		owner.state.relay.goalFallback = false;

		const blocked = await executeWrappedGoalTool({ op: "complete" }, ctx, owner);
		expect(blocked.details).toMatchObject({ blocked: true, herdPhase: "herd_priority" });
		expect(goalRuntime.calls).not.toContainEqual(["complete"]);

		owner.enterGoalFallback({ selfDriven: false });
		await executeWrappedGoalTool({ op: "complete" }, ctx, owner);
		expect(goalRuntime.calls).toContainEqual(["complete"]);
		expect(owner.state.relay.goal).toBe(false);
		expect(owner.state.relay.goalFallback).toBe(false);
	});

	test("create arms Phase 1, get reports the phase, drop exits", async () => {
		const owner = station();
		const goalRuntime = runtime("none");
		const ctx = runtimeContext(goalRuntime);

		await executeWrappedGoalTool({ op: "create", objective: "ship it" }, ctx, owner);
		expect(goalRuntime.calls).toContainEqual(["create", "ship it"]);
		expect(owner.state.relay.goal).toBe(true);
		expect(owner.state.relay.goalFallback).toBe(false);
		expect(owner.checkGoalToolCall("get")).toMatchObject({ phase: "herd_priority" });

		await executeWrappedGoalTool({ op: "drop" }, ctx, owner);
		expect(goalRuntime.calls).toContainEqual(["drop"]);
		expect(owner.state.relay.goal).toBe(false);
	});
});

describe("I1 — /goal is primary, /herd-goal is the alias", () => {
	test("a TUI herd-goal rewrites to the official grammar", async () => {
		const owner = station();
		const ctx = modeContext("inactive");

		const rewritten = await handleGoalInput({ text: "/herd-goal ship x" }, ctx, owner, {});
		expect(rewritten).toEqual({ text: "/goal set ship x" });
		expect(ctx.calls).toEqual([]);
	});

	test("a paused official goal is dropped before the rewrite", async () => {
		const owner = station();
		const ctx = modeContext({ status: "paused" });

		const rewritten = await handleGoalInput({ text: "/herd-goal ship x" }, ctx, owner, {});
		expect(rewritten).toEqual({ text: "/goal set ship x" });
		expect(ctx.calls.map((call) => call.action)).toEqual(["drop"]);
	});

	test("native /goal and /goal show pass through untouched", async () => {
		const owner = station();
		const ctx = modeContext("inactive");
		expect(await handleGoalInput({ text: "/goal ship x" }, ctx, owner, {})).toBeUndefined();
		expect(await handleGoalInput({ text: "/goal show" }, ctx, owner, {})).toBeUndefined();
		expect(ctx.calls).toEqual([]);
	});

	test("goal_updated arms Phase 1, survives a same-id heartbeat, and re-arms on a new id", () => {
		const owner = station();
		owner.onOfficialGoalUpdated({ status: "active", id: "g1" }, { enabled: true, goal: { status: "active", id: "g1" } });
		expect(owner.state.relay.goal).toBe(true);
		expect(owner.state.relay.goalFallback).toBe(false);

		owner.enterGoalFallback({ selfDriven: false });
		owner.onOfficialGoalUpdated({ status: "active", id: "g1" }, { enabled: true, goal: { status: "active", id: "g1" } });
		expect(owner.state.relay.goalFallback).toBe(true);

		owner.onOfficialGoalUpdated({ status: "active", id: "g2" }, { enabled: true, goal: { status: "active", id: "g2" } });
		expect(owner.state.relay.goalFallback).toBe(false);
	});

	test("paused keeps Phase 1 and ends Phase 2; dropped ends both", () => {
		const first = station();
		first.onOfficialGoalUpdated({ status: "active", id: "g1" }, { enabled: true, goal: { status: "active", id: "g1" } });
		first.onOfficialGoalUpdated({ status: "paused", id: "g1" }, { enabled: false, goal: { status: "paused", id: "g1" } });
		expect(first.state.relay.goal).toBe(true);

		first.enterGoalFallback({ selfDriven: false });
		first.onOfficialGoalUpdated({ status: "paused", id: "g1" }, { enabled: false, goal: { status: "paused", id: "g1" } });
		expect(first.state.relay.goal).toBe(false);

		const second = station();
		second.onOfficialGoalUpdated({ status: "active", id: "g1" }, { enabled: true, goal: { status: "active", id: "g1" } });
		second.onOfficialGoalUpdated({ status: "dropped" }, { enabled: false, goal: { status: "dropped" } });
		expect(second.state.relay.goal).toBe(false);
	});

	test("a bare /herd-goal closes herd and drops the official goal", async () => {
		const owner = goalStation();
		const ctx = modeContext("active");
		owner.state.relay.goal = true;
		owner.state.relay.goalFallback = true;

		const result = await handleGoalInput({ text: "/herd-goal" }, ctx, owner, {});

		expect(result).toEqual({ handled: true });
		expect(ctx.calls.map((call) => call.action)).toEqual(["drop"]);
		expect(owner.state.relay.goal).toBe(false);
		expect(owner.state.relay.goalFallback).toBe(false);
	});
});

describe("N1 — print, RPC, and headless", () => {
	test("an RPC goal input drives the runtime and commits herd", async () => {
		const goalRuntime = runtime("none");
		const ctx = runtimeContext(goalRuntime);
		const owner = goalStation();

		const result = await handleGoalInput({ text: "/goal do y" }, ctx, owner, {});

		expect(result).toEqual({ handled: true });
		expect(goalRuntime.calls).toContainEqual(["create", "do y"]);
		expect(owner.state.relay.goal).toBe(true);
		expect(owner.state.relay.goalFallback).toBe(false);
	});

	test("RPC budget, pause, resume, and drop reach the runtime", async () => {
		const goalRuntime = runtime();
		const ctx = runtimeContext(goalRuntime);
		const owner = goalStation();
		owner.onOfficialGoalUpdated({ status: "active", id: "g1" }, { enabled: true, goal: { status: "active", id: "g1" } });

		const shown = await handleGoalInput({ text: "/goal show" }, ctx, owner, {});
		expect(shown).toEqual({ handled: true });

		await handleGoalInput({ text: "/goal budget 5000" }, ctx, owner, {});
		await handleGoalInput({ text: "/goal pause" }, ctx, owner, {});
		await handleGoalInput({ text: "/goal resume" }, ctx, owner, {});
		await handleGoalInput({ text: "/goal drop" }, ctx, owner, {});

		expect(goalRuntime.calls).toContainEqual(["budget", 5000]);
		expect(goalRuntime.calls).toContainEqual(["pause"]);
		expect(goalRuntime.calls).toContainEqual(["resume"]);
		expect(goalRuntime.calls).toContainEqual(["drop"]);
		expect(owner.state.relay.goal).toBe(false);
	});

	test("print mode arms the goal from the first prompt without re-prompting", async () => {
		const owner = station();
		const goalRuntime = runtime("none");
		const ctx = runtimeContext(goalRuntime);

		const parsed = shouldActivatePrintGoal({ prompt: "/goal set do z" }, ctx, owner);
		expect(parsed).toMatchObject({ action: "set", text: "do z" });
		expect(await activatePrintGoalFromPrompt(parsed, ctx, owner)).toBe(true);
		expect(goalRuntime.calls).toContainEqual(["create", "do z"]);
		expect(owner.state.relay.goal).toBe(true);
	});

	test("Phase 2 blocks session_stop and releases on an empty beat", () => {
		const owner = station();
		const ctx = { session: { goalRuntime: runtime() } };
		owner.state.relay.goal = true;
		owner.state.relay.canStop = true;

		const first = onSessionStop(owner, ctx, {
			officialGoalActive: true,
			officialContinuationPrompt: "Continue active goal.",
			messages: [],
		});
		expect(first).toBeDefined();
		expect(JSON.stringify(first)).toContain("Continue active goal.");
		expect(owner.state.relay.goal).toBe(true);
		expect(owner.state.relay.goalFallback).toBe(true);

		const withWork = [
			{
				role: "assistant",
				content: [{ type: "toolCall", name: "read", arguments: { path: "a" } }],
			},
		];
		const second = onSessionStop(owner, ctx, {
			officialGoalActive: true,
			officialContinuationPrompt: "Continue active goal.",
			messages: withWork,
		});
		expect(second).toBeDefined();
		expect(owner.state.relay.goal).toBe(true);

		const third = onSessionStop(owner, ctx, {
			officialGoalActive: true,
			officialContinuationPrompt: "Continue active goal.",
			messages: withWork,
		});
		expect(third).toBeUndefined();
		expect(owner.state.relay.goal).toBe(false);
		expect(owner.state.relay.goalFallback).toBe(false);
	});

	test("a host with neither modes nor a runtime stays herd-only and exits on the seal", async () => {
		const prompts = [];
		const pi = { sendUserMessage: async (text) => prompts.push(text) };
		const owner = goalStation(pi);

		await handleGoalInput({ text: "/herd-goal do w" }, {}, owner, pi);
		expect(prompts).toEqual(["do w"]);
		expect(owner.state.relay.goal).toBe(true);

		owner.state.relay.canStop = true;
		expect(onSessionStop(owner, {}, null)).toBeUndefined();
		expect(owner.state.relay.goal).toBe(false);
	});
});
