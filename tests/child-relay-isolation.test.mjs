// Child/Root isolation and Root natural-stop / autopilot / prompt contracts.

import { describe, expect, test } from "bun:test";

import { createRelay } from "../src/relay/index.mjs";
import { onAgentEnd, onBeforeAgentStart, onSessionStop, prepareRequest } from "../src/station/gates.mjs";
import { commitRootRewind } from "../src/station/handoff-state.mjs";
import { rootReturnNudge } from "../src/station/texts.mjs";
import {
	projectCapabilities,
	renderConsoleReceipt,
} from "../src/station/domain/capabilities.mjs";
import { unreceivedChildren } from "../src/scope/index.mjs";
import { probeOf } from "./helpers/probe-view.mjs";
import { childReturnNudge } from "../src/scope/return-nudge.mjs";
import { injectSystemPrompt } from "../src/prompts/inject.mjs";
import { READ_ONLY_SUBAGENT, READ_WRITE_SUBAGENT } from "../src/core/policy.mjs";

function relayState(overrides = {}) {
	return { autopilot: true, relay: { ...createRelay(), ...overrides } };
}

function stopStation(ownerId, overrides = {}) {
	const station = {
		state: relayState(overrides.relay),
		forkOwnerId: () => ownerId,
		forkLedgerPort: () => overrides.ledger ?? null,
	};
	// The stop gate reads two facts from the projection — the mode and the
	// pending count — so the stub answers both from the live state it is given.
	// A stub that answered neither would make every test below look like a
	// root with nothing outstanding.
	station.projectionFor = () => {
		const ledger = station.forkLedgerPort();
		return {
			mode:
				ownerId !== null
					? "CHILD"
					: station.state.autopilot === true
						? "ROOT_AUTOPILOT"
						: "ROOT_MANUAL",
			state: {
				unreceived: ledger ? unreceivedChildren(ledger, ownerId ?? "root").length : 0,
			},
		};
	};
	return station;
}

describe("a root's natural stop with unreceived work", () => {
	test("continues with the join steer before any return nudge", () => {
		const child = { forkId: "fork_a", status: "running", ownerId: "root" };
		const station = stopStation(null, {
			ledger: { order: ["fork_a"], forks: { fork_a: child } },
		});

		const out = onSessionStop(station, {});

		expect(out?.continue).toBe(true);
		expect(out.additionalContext).toContain("1 unreceived result(s) from forked scopes");
		expect(out.additionalContext).toContain("scope_join");
	});

	test("holds even when autopilot is off", () => {
		const child = { forkId: "fork_a", status: "ready", ownerId: "root" };
		const station = stopStation(null, {
			ledger: { order: ["fork_a"], forks: { fork_a: child } },
		});
		station.state.autopilot = false;

		const out = onSessionStop(station, {});

		expect(out?.continue).toBe(true);
		expect(out.additionalContext).toContain("scope_join");
	});
});

describe("root vs child natural stop", () => {
	test("root under autopilot without canStop is nudged to call scope_return", () => {
		const station = stopStation(null);
		const out = onSessionStop(station, {});
		expect(out).toEqual({ continue: true, additionalContext: rootReturnNudge() });
	});

	test("root under autopilot with canStop is allowed to stop", () => {
		const station = stopStation(null, { relay: { bigStreak: 2, canStop: true } });
		expect(onSessionStop(station, {})).toBeUndefined();
	});

	test("root in manual duty is allowed to stop naturally", () => {
		const station = stopStation(null);
		station.state.autopilot = false;
		expect(onSessionStop(station, {})).toBeUndefined();
	});

	test("a running child is nudged with childReturnNudge, never rootReturnNudge", () => {
		const child = { forkId: "fork_a", status: "running", ownerId: "root", returnNudges: 0 };
		const station = stopStation("fork_a", {
			ledger: { order: ["fork_a"], forks: { fork_a: child } },
		});
		const out = onSessionStop(station, {});
		expect(out).toEqual({ continue: true, additionalContext: childReturnNudge() });
	});

	test("a child still receives join nudge first when it owns an unreceived grandchild", () => {
		const grandchild = { forkId: "grand", status: "running", ownerId: "fork_a" };
		const station = stopStation("fork_a", {
			ledger: { order: ["grand"], forks: { grand: grandchild } },
		});
		const out = onSessionStop(station, {});
		expect(out?.continue).toBe(true);
		expect(out.additionalContext).toContain("scope_join");
	});
});

describe("child isolation from root rewind", () => {
	test("commitRootRewind is a no-op on a child station", () => {
		const relay = {
			...createRelay(),
			generation: 1,
			pendingRewind: { report: "root pending", big: false, generation: 1 },
		};
		const station = {
			state: { autopilot: true, relay, pins: [] },
			forkOwnerId: () => "fork_a",
		};
		expect(commitRootRewind(station, {})).toBe(false);
		expect(station.state.relay.pendingRewind).not.toBeNull();
	});

	test("onAgentEnd on a child never dispatches a root rewind", () => {
		const dispatched = [];
		const station = {
			state: {
				autopilot: true,
				relay: { ...createRelay(), pendingRewind: { report: "x", big: false, generation: 1 } },
			},
			forkOwnerId: () => "fork_a",
			tickets: { rewindRoot: () => dispatched.push("rewind") },
			dispatchFireAndForget: (_d, fn) => fn(),
		};
		onAgentEnd(station, {}, { willContinue: false });
		expect(dispatched).toEqual([]);
	});
});

function promptStation(ownerId, autopilot = true) {
	return {
		state: { autopilot },
		forkOwnerId: () => ownerId,
		policy: () => READ_ONLY_SUBAGENT,
		portTable: {},
	};
}

function promptText(station) {
	const out = onBeforeAgentStart(station, { systemPrompt: "Host instructions" }, {});
	const prompt = out?.systemPrompt;
	return Array.isArray(prompt) ? prompt.join("\n") : prompt ?? "";
}

describe("a child's model-facing prompt", () => {
	for (const autopilot of [true, false]) {
		test(`matches the root prompt byte for byte when autopilot is ${autopilot}`, () => {
			const child = promptText(promptStation("fork_a", autopilot));
			const root = promptText(promptStation(null, autopilot));

			expect(child).toBe(root);
			expect(child).toContain("### Scope duties");
			expect(child).toContain("Forked scope duty");
			expect(child).toContain("scope_return");
			expect(child).toContain("### Close the work");
			expect(child).toContain("Only the user toggles autopilot");
		});
	}
});

describe("the prompt gate on an inherited prompt", () => {
	for (const autopilot of [true, false]) {
		test(`is a no-op for a child when autopilot is ${autopilot}`, () => {
			const station = promptStation("fork_a", autopilot);
			const inherited = injectSystemPrompt(["Host instructions"]);

			const out = onBeforeAgentStart(station, { systemPrompt: inherited }, {});

			expect(out).toBeUndefined();
			expect(injectSystemPrompt(inherited)).toBe(inherited);
		});
	}
});

// The probe body is parsed by tests/helpers/probe-view.mjs.

const childBranch = {
	fsm: "child work",
	remaining: { read: 1 },
	budget: { read: 2 },
	clockPausedAt: 0,
	deadlineAt: 1000,
	timeBudgetMs: 1000,
};

function requestStation(ownerId) {
	const state = {
		autopilot: true,
		relay: createRelay(),
		hostBoundaryKey: null,
	};
	const branch = ownerId ? childBranch : null;
	return {
		state,
		forkOwnerId: () => ownerId,
		policy: () => READ_WRITE_SUBAGENT,
		contextMessages: () => [],
		observeActualModel() {},
		tickets: {},
		persist() {},
		resetUsageWatermark() {},
		skillReceipt() {
			// The probe is the receipt: same projection source as the runtime.
			const projection = projectCapabilities({
				isChild: ownerId !== null,
				autopilot: state.autopilot,
				canStop: false,
				unreceived: 0,
				selfPath: ownerId ? "/fork_a" : "/",
				remaining: branch ? { read: "1/2" } : null,
				activePaths: ["/"],
			});
			return {
				herdSkill: true,
				content: [{ type: "text", text: renderConsoleReceipt(projection) }],
			};
		},
	};
}

describe("a child's skill receipt", () => {
	test("carries the child's own turns instead of root autopilot/return status", () => {
		const text = requestStation("fork_a").skillReceipt().content[0].text;
		const view = probeOf(text);
		expect(view.remaining).toEqual({ read: "1/2" });
		expect(view).not.toHaveProperty("autopilot");
		expect(view).not.toHaveProperty("canStop");
	});

	test("prepareRequest keeps that child receipt", () => {
		const message = prepareRequest(
			requestStation("fork_a"),
			{},
			null,
			{ pending: [], prefix: [] },
		);
		const text = message.content.map((part) => part.text ?? "").join("\n");

		expect(message.herdSkill).toBe(true);
		expect(text).toContain("remaining:");
		expect(text).not.toContain("autopilot:");
	});

	test("the root receipt carries autopilot mode and scope_return obligation", () => {
		const text = requestStation(null).skillReceipt().content[0].text;
		const view = probeOf(text);

		expect(view.autopilot).toBe(true);
		expect(view.api).toContain("scope_return");
	});
});
