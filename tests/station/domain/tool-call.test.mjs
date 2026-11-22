// Phase 4b red contracts: the tool-call decision is a pure function over
// plain snapshots. No station, no mutation. The station commits the result.
//
// The module does not exist yet; these tests are the contract the 4b
// implementation must satisfy. `charge` is an intent: the station executes
// `chargeBranch` and turns a refusal into a block. The accounting refusal
// itself stays covered by `tests/branch-charge.test.mjs`.

import { describe, expect, test } from "bun:test";

import {
	MAIN_AGENT,
	READ_ONLY_SUBAGENT,
	READ_WRITE_SUBAGENT,
} from "../../../src/host/policy.mjs";
import { decideToolCall } from "../../../src/station/domain/tool-call.mjs";

const NORMAL_CALL = {
	toolName: "read",
	toolCallId: "call-1",
	input: { path: "a.mjs" },
};

function decide(overrides = {}) {
	const base = {
		state: { autopilot: true, relay: { handoffPending: false }, charges: {} },
		processed: { handled: false, hasCall: false },
		dispatch: { found: false, groupKey: undefined, beatTools: [] },
		call: NORMAL_CALL,
		policy: MAIN_AGENT,
		relay: { ownerId: "fork_1", handoffPending: false, owesLedger: true },
	};
	return decideToolCall({
		...base,
		...overrides,
		state: { ...base.state, ...(overrides.state ?? {}) },
		processed: { ...base.processed, ...(overrides.processed ?? {}) },
		dispatch: { ...base.dispatch, ...(overrides.dispatch ?? {}) },
		call: { ...base.call, ...(overrides.call ?? {}) },
		relay: { ...base.relay, ...(overrides.relay ?? {}) },
	});
}

function expectAllow(decision, { charge = true } = {}) {
	expect(decision.verdict).toBe("allow");
	expect(decision.block).toBeNull();
	expect(decision.controls.process).toBe(true);
	if (charge) {
		expect(decision.charge).not.toBeNull();
		expect(decision.charge.request).toBeTruthy();
	} else {
		expect(decision.charge).toBeNull();
	}
}

describe("normal tools", () => {
	test("a branch tool returns an allow verdict and a charge request", () => {
		const decision = decide({
			dispatch: {
				found: true,
				groupKey: "beat-1",
				beatTools: [{ name: "read", free: false }],
			},
		});

		expectAllow(decision);
		expect(decision.charge.request).toEqual({
			ownerId: "fork_1",
			toolCallId: "call-1",
			toolName: "read",
			groupKey: "beat-1",
			beatTools: [{ name: "read", free: false }],
			input: { path: "a.mjs" },
		});
		expect(decision.charge.alreadyCharged).toBe(false);
		expect(decision.persist).toBe(true);
		expect(decision.todo).toBeNull();
		expect(decision.controls.directAmend).toBeNull();
	});

	test("a normal tool without a carrying message still returns a charge request", () => {
		const decision = decide();

		expectAllow(decision);
		expect(decision.charge.request.groupKey).toBeUndefined();
		expect(decision.charge.request.beatTools).toEqual([]);
		expect(decision.persist).toBe(true);
	});

	test("an already charged tool call is marked but stays allowed", () => {
		const decision = decide({
			state: {
				charges: { "call-1": { ownerId: "fork_1", tool: "read", amount: 1 } },
			},
		});

		expectAllow(decision);
		expect(decision.charge.alreadyCharged).toBe(true);
		expect(decision.persist).toBe(true);
	});

	test("the decision never mutates its inputs", () => {
		const input = {
			state: { autopilot: true, relay: { handoffPending: false }, charges: {} },
			processed: { handled: false, hasCall: false },
			dispatch: { found: true, groupKey: "beat-1", beatTools: [] },
			call: { toolName: "read", toolCallId: "call-1", input: { path: "a.mjs" } },
			policy: MAIN_AGENT,
			relay: { ownerId: "fork_1", handoffPending: false, owesLedger: true },
		};
		const before = structuredClone(input);

		decideToolCall(input);

		expect(input).toEqual(before);
	});
});

describe("policy", () => {
	test("a read-only subagent bypasses station routing; the host owns denial", () => {
		const decision = decide({
			policy: READ_ONLY_SUBAGENT,
			call: { toolName: "write", toolCallId: "call-w", input: { path: "a.mjs" } },
		});

		expect(decision.verdict).toBe("readonly");
		expect(decision.block).toBeNull();
		expect(decision.controls).toEqual({ process: false, directAmend: null });
		expect(decision.charge).toBeNull();
		expect(decision.persist).toBe(false);
		expect(decision.todo).toBeNull();
	});
});

describe("todo", () => {
	test("todo is free and persists, but the gate does not grant it", () => {
		const decision = decide({
			policy: READ_WRITE_SUBAGENT,
			call: {
				toolName: "todo",
				toolCallId: "call-todo",
				input: { op: "init", list: [] },
			},
		});

		expect(decision.verdict).toBe("allow");
		expect(decision.block).toBeNull();
		expect(decision.controls.process).toBe(true);
		expect(decision.todo).toEqual({ free: true, persist: true, grant: false });
		expect(decision.charge).toBeNull();
		expect(decision.persist).toBe(true);
	});
});

describe("control tools", () => {
	for (const name of ["pin", "scope_fork", "scope_join", "scope_return"]) {
		test(`${name} is a free control tool`, () => {
			const decision = decide({
				call: { toolName: name, toolCallId: `call-${name}`, input: {} },
			});

			expectAllow(decision, { charge: false });
			expect(decision.controls.directAmend).toBeNull();
			expect(decision.persist).toBe(false);
			expect(decision.todo).toBeNull();
		});
	}

	test("amend is routed to directAmend only when the call is not handled", () => {
		const unhandled = decide({
			call: {
				toolName: "amend",
				toolCallId: "call-amend",
				input: { rationale: "the lexer owns the token" },
			},
		});

		expect(unhandled.verdict).toBe("allow");
		expect(unhandled.controls.process).toBe(true);
		expect(unhandled.controls.directAmend).toEqual({
			args: { rationale: "the lexer owns the token" },
		});
		expect(unhandled.charge).toBeNull();
		expect(unhandled.persist).toBe(false);

		const handled = decide({
			call: {
				toolName: "amend",
				toolCallId: "call-amend",
				input: { rationale: "the lexer owns the token" },
			},
			processed: { handled: true, hasCall: true },
		});

		expect(handled.verdict).toBe("allow");
		expect(handled.controls.directAmend).toBeNull();
		expect(handled.charge).toBeNull();
		expect(handled.persist).toBe(false);
	});

	test("amend accepts a JSON string input", () => {
		const decision = decide({
			call: {
				toolName: "amend",
				toolCallId: "call-amend",
				input: '{"rationale":"the lexer owns the token"}',
			},
		});

		expect(decision.controls.directAmend).toEqual({
			args: { rationale: "the lexer owns the token" },
		});
	});

	test("steer is not a control tool; it is charged like a normal tool", () => {
		const decision = decide({
			call: {
				toolName: "steer",
				toolCallId: "call-steer",
				input: { text: "keep going" },
			},
		});

		expectAllow(decision);
		expect(decision.charge.request.toolName).toBe("steer");
		expect(decision.persist).toBe(true);
	});
});

describe("ask and wait", () => {
	test("ask is blocked under autopilot and free otherwise", () => {
		const blocked = decide({
			call: { toolName: "ask", toolCallId: "call-ask", input: { content: "?" } },
		});

		expect(blocked.verdict).toBe("block");
		expect(blocked.block).toEqual({ reason: expect.any(String) });
		expect(blocked.controls.process).toBe(true);
		expect(blocked.charge).toBeNull();
		expect(blocked.persist).toBe(false);

		const allowed = decide({
			state: { autopilot: false },
			call: { toolName: "ask", toolCallId: "call-ask", input: { content: "?" } },
		});

		expect(allowed.verdict).toBe("allow");
		expect(allowed.block).toBeNull();
		expect(allowed.charge).toBeNull();
		expect(allowed.persist).toBe(false);
	});

	test("wait is free and never charged", () => {
		const decision = decide({
			call: { toolName: "wait", toolCallId: "call-wait", input: {} },
		});

		expect(decision.verdict).toBe("wait");
		expect(decision.block).toBeNull();
		expect(decision.controls.process).toBe(true);
		expect(decision.charge).toBeNull();
		expect(decision.persist).toBe(false);
	});

	test("scope_join and scope_return are free and never time-gated by the decision", () => {
		for (const name of ["scope_join", "scope_return"]) {
			const decision = decide({
				call: { toolName: name, toolCallId: `call-${name}`, input: {} },
				relay: { ownerId: "fork_1", timeLimitMs: 1_000 },
			});

			expect(decision.verdict).toBe("allow");
			expect(decision.charge).toBeNull();
			expect(decision.persist).toBe(false);
			expect(decision.controls.directAmend).toBeNull();
		}
	});
});

describe("relay handoff", () => {
	test("the root blocks every tool while a handoff is pending", () => {
		const decision = decide({
			state: { autopilot: true, relay: { handoffPending: true } },
			relay: { ownerId: null, handoffPending: true },
		});

		expect(decision.verdict).toBe("block");
		expect(decision.block.reason).toContain("RELAY_HANDOFF_PENDING");
		expect(decision.controls.process).toBe(false);
		expect(decision.charge).toBeNull();
		expect(decision.persist).toBe(false);
	});

	test("a child is not blocked by the root's pending handoff", () => {
		const decision = decide({
			state: { autopilot: true, relay: { handoffPending: true } },
			relay: { ownerId: "fork_a", handoffPending: true },
		});

		expect(decision.verdict).toBe("allow");
		expect(decision.block).toBeNull();
		expect(decision.charge.request.ownerId).toBe("fork_a");
	});
});
