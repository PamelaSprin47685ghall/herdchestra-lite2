// The relay is a root protocol. A fork child shares the root's relay object so
// a reload can see it, but it never evaluates it: a child's natural stop is the
// host's return gate, not an empty-ledger submission. These cases pin that
// boundary at the two entry points a child can hit — the stop gate and the
// tool gate — plus the stop transition itself.

import { describe, expect, test } from "bun:test";

import { createRelay } from "../src/relay/index.mjs";
import { onBeforeAgentStart, onSessionStop, onToolCall, prepareRequest } from "../src/station/gates.mjs";
import {
	advanceRelayForHandoff,
	armHandoff,
	captureHandoffReport,
	commitSelfHandoff,
	recordNaturalStop,
} from "../src/station/handoff-state.mjs";
import { skillReceiptText } from "../src/station/texts.mjs";
import { READ_ONLY_SUBAGENT, READ_WRITE_SUBAGENT } from "../src/host/policy.mjs";

function relayState(overrides = {}) {
	return { autopilot: true, relay: { ...createRelay(), ...overrides } };
}

function stopStation(ownerId, overrides = {}) {
	const recorded = [];
	return {
		recorded,
		state: relayState(overrides.relay),
		handoffReport: overrides.handoffReport ?? null,
		forkOwnerId: () => ownerId,
		relayOn: () => true,
		recordNaturalStop: () => {
			recorded.push("stop");
		},
		commitSelfHandoff: () => {
			recorded.push("commit");
			return { ok: true, relay: {} };
		},
	};
}

describe("a child's natural stop", () => {
	test("does not record a relay evaluation", () => {
		const station = stopStation("fork_a");

		const out = onSessionStop(station, {});

		expect(out).toBeUndefined();
		expect(station.recorded).toEqual([]);
	});

	test("does not commit a handoff it inherited as pending", () => {
		const station = stopStation("fork_a", {
			relay: { handoffPending: true },
			handoffReport: "the child's own prose",
		});

		const out = onSessionStop(station, {});

		expect(out).toBeUndefined();
		expect(station.recorded).toEqual([]);
	});

	test("still steers when the child itself owns an unreceived grandchild", () => {
		const grandchild = { forkId: "grand", status: "running", ownerId: "fork_a" };
		const station = stopStation("fork_a");
		station.forkLedgerPort = () => ({
			order: ["grand"],
			forks: { grand: grandchild },
		});

		const out = onSessionStop(station, {});

		expect(out?.continue).toBe(true);
		expect(out.additionalContext).toContain("1 unreceived child result");
		expect(station.recorded).toEqual([]);
	});
});

describe("the natural-stop transition", () => {
	test("leaves the shared relay untouched when the station is a child", () => {
		const delivered = [];
		const station = {
			state: relayState(),
			forkOwnerId: () => "fork_a",
			persist() {},
			deliverUserMessage: (text) => {
				delivered.push(text);
				return true;
			},
			registry: { ports: () => ({ relay: "handoff" }), markPending() {} },
		};
		const before = JSON.stringify(station.state.relay);

		const applied = recordNaturalStop(station, {});

		expect(applied).toBeNull();
		expect(JSON.stringify(station.state.relay)).toBe(before);
		expect(delivered).toEqual([]);
	});

	test("still arms the handoff for the root", () => {
		const delivered = [];
		const station = {
			state: relayState(),
			forkOwnerId: () => null,
			persist() {},
			deliverUserMessage: (text) => {
				delivered.push(text);
				return true;
			},
			registry: { ports: () => ({ relay: "handoff" }), markPending() {} },
		};

		const applied = recordNaturalStop(station, {});

		expect(applied?.action).toBe("handoff");
		expect(station.state.relay.handoffPending).toBe(true);
		expect(delivered).toHaveLength(1);
	});
});

describe("the pending-handoff tool gate", () => {
	function toolStation(ownerId) {
		return {
			state: { ...relayState({ handoffPending: true }), scopes: [] },
			processed: { hasHandled: () => true, markCall() {} },
			processControlsForTool() {},
			forkOwnerId: () => ownerId,
			policy: () => "main",
			persist() {},
		};
	}

	const todoEvent = {
		toolName: "todo",
		toolCallId: "call_todo",
		input: { op: "view" },
	};

	test("refuses the root", () => {
		const verdict = onToolCall(toolStation(null), todoEvent, {});

		expect(verdict?.block).toBe(true);
		expect(verdict.reason).toContain("RELAY_HANDOFF_PENDING");
	});

	test("does not refuse a child", () => {
		const verdict = onToolCall(toolStation("fork_a"), todoEvent, {});

		expect(verdict).toBeUndefined();
	});
});

function promptStation(ownerId, autopilot = true) {
	return {
		state: { autopilot },
		forkOwnerId: () => ownerId,
		policy: () => READ_ONLY_SUBAGENT,
		registry: { ports: () => ({}) },
	};
}

function promptText(station) {
	const out = onBeforeAgentStart(station, { systemPrompt: "Host instructions" }, {});
	const prompt = out?.systemPrompt;
	return Array.isArray(prompt) ? prompt.join("\n") : prompt ?? "";
}

describe("a child's model-facing prompt", () => {
	for (const autopilot of [true, false]) {
		test(`does not advertise the root relay when autopilot is ${autopilot}`, () => {
			const text = promptText(promptStation("fork_a", autopilot));

			expect(text).toContain("### Child duties");
			expect(text).toContain("Fork child duty");
			expect(text).toContain("scope_return");
			expect(text).not.toContain("### Close the work");
			expect(text).not.toContain("Only the user toggles autopilot");
			expect(text).not.toContain("Autopilot is off by default");
			expect(text).not.toContain("Any successful `todo` write");
			expect(text).not.toContain("RELAY_HANDOFF_PENDING");
			expect(text).not.toContain("natural stop is a ledger submission");
		});
	}

	test("still gives the root the autopilot mode rules", () => {
		const text = promptText(promptStation(null, true));

		expect(text).toContain("### Close the work");
		expect(text).toContain("Only the user toggles autopilot");
		expect(text).toContain("Any successful `todo` write");
		expect(text).not.toContain("### Child duties");
	});
});

const childBranch = {
	intent: "child work",
	remaining: { read: 1 },
	budget: { read: 2 },
	clockPausedAt: 0,
	deadlineAt: 1000,
	timeBudgetMs: 1000,
};

function requestStation(ownerId) {
	const state = {
		autopilot: true,
		relay: { ...createRelay(), fullFlow: true },
		hostBoundaryKey: null,
	};
	const branch = ownerId ? childBranch : null;
	const ledger = ownerId ? { forks: { [ownerId]: childBranch } } : null;
	return {
		state,
		forkOwnerId: () => ownerId,
		forkLedgerPort: () => ledger,
		policy: () => READ_WRITE_SUBAGENT,
		ensureTools() {},
		contextMessages: () => [],
		observeActualModel() {},
		tickets: {},
		persist() {},
		resetUsageWatermark() {},
		relayOn: () => true,
		skillReceipt(ctx, demandVisible) {
			return {
				herdSkill: true,
				content: [{
					type: "text",
					text: skillReceiptText(this.state, true, branch, 0, demandVisible),
				}],
			};
		},
	};
}

describe("a child's skill receipt", () => {
	test("describes child duty instead of the relay mode", () => {
		const text = skillReceiptText(
			{ autopilot: true, relay: { ...createRelay(), fullFlow: true } },
			true,
			childBranch,
			0,
			false,
		);

		expect(text).toContain("Scope budget:");
		expect(text).not.toContain("Fork child duty");
		expect(text).not.toContain("scope_return");
		expect(text).not.toContain("Autopilot on");
		expect(text).not.toContain("Autopilot off");
		expect(text).not.toContain("Until the first `todo` write");
		expect(text).not.toContain("Write the handoff report");
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
		expect(text).toContain("Scope budget:");
		expect(text).not.toContain("Fork child duty");
		expect(text).not.toContain("Autopilot on");
	});

	test("the root receipt still carries the mode line", () => {
		const text = skillReceiptText(
			{ autopilot: true, relay: { ...createRelay(), fullFlow: true } },
			true,
			null,
			0,
			false,
		);

		expect(text).toContain("Autopilot on");
		expect(text).toContain("Until the first `todo` write");
		expect(text).not.toContain("Fork child duty");
	});
});

describe("a child's handoff transitions", () => {
	test("captures nothing when called directly on a child", () => {
		const station = {
			state: { autopilot: true, relay: { ...createRelay(), handoffPending: true } },
			forkOwnerId: () => "fork_a",
			handoffReport: null,
		};

		expect(captureHandoffReport(station, "child prose")).toBe(false);
		expect(station.handoffReport).toBeNull();
	});

	test("does not arm a handoff from a child", () => {
		const station = {
			state: { autopilot: true, relay: { ...createRelay() } },
			forkOwnerId: () => "fork_a",
			handoffReport: null,
			persist() {},
			registry: {
				ports: () => ({ relay: "handoff" }),
				markPending() {},
			},
		};

		expect(armHandoff(station, {})).toBe(false);
		expect(station.state.relay.handoffPending).toBeFalsy();
	});

	test("does not commit a handoff from a child", () => {
		const relay = { ...createRelay(), handoffPending: true };
		const station = {
			state: { autopilot: true, relay, pins: [], usage: { lastTotalInput: 0 } },
			forkOwnerId: () => "fork_a",
			handoffReport: "child prose",
			contextMessages: () => [],
			manager: null,
			persist() {},
			resetUsageWatermark() {},
			registry: {
				ports: () => ({ relay: "handoff" }),
				clearPending() {},
			},
		};
		const before = JSON.stringify(relay);

		expect(commitSelfHandoff(station, {}, "child prose")).toEqual({ ok: false });
		expect(JSON.stringify(station.state.relay)).toBe(before);
		expect(station.handoffReport).toBe("child prose");
	});

	test("cannot advance the relay directly", () => {
		const relay = { ...createRelay(), handoffPending: true };
		const station = {
			state: { autopilot: true, relay },
			forkOwnerId: () => "fork_a",
			persist() {},
			registry: { ports: () => ({ relay: "handoff" }) },
		};
		const before = JSON.stringify(relay);

		expect(advanceRelayForHandoff(station)).toBe(false);
		expect(JSON.stringify(station.state.relay)).toBe(before);
		expect(station.state.relay.handoffPending).toBe(true);
	});

	test("the root still advances the relay", () => {
		const relay = { ...createRelay(), handoffPending: true };
		const station = {
			state: { autopilot: true, relay },
			forkOwnerId: () => null,
			persist() {},
			registry: { ports: () => ({ relay: "handoff" }) },
		};

		expect(advanceRelayForHandoff(station)).toBe(true);
		expect(station.state.relay.handoffPending).toBe(false);
		expect(station.state.relay.generation).toBe(relay.generation + 1);
	});
});
