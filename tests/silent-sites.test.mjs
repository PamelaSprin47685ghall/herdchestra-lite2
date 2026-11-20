// Every site here used to swallow a failure that changes what the user lives
// through: a nudge that never arrives, a `/herd <text>` message that vanishes,
// a handoff transcript that is never rebuilt, a usage baseline that silently
// starts at zero, and a diagnostic whose evidence is never printed.
//
// Each test fails against the previous implementation, which recorded nothing.

import { beforeEach, describe, expect, test } from "bun:test";
import {
	record,
	reset as resetDiagnostics,
	snapshot as diagnosticsSnapshot,
} from "../src/host/diagnostics.mjs";
import {
	sendSteerTicket,
	sendUserMessageTicket,
} from "../src/tools/tickets.mjs";
import { createStatusRuntime } from "../src/host/status.mjs";
import { wireHooks } from "../src/activation/hooks.mjs";
import { wireCommands } from "../src/activation/commands.mjs";
import { commitSelfHandoff } from "../src/station/handoff-state.mjs";
import { createState } from "../src/scope/index.mjs";
import { createRelay } from "../src/relay/state.mjs";

function entries(domain) {
	return diagnosticsSnapshot().filter((entry) => entry.domain === domain);
}

const STATION = {
	onAssistantMessage() {},
	onMessageEnd() {},
	onUsageMessage() {},
	onToolCall() {},
	onBeforeAgentStart() {},
	onSessionStop() {},
	onSessionSwitch() {},
	onSessionCompact() {},
};

beforeEach(() => {
	resetDiagnostics();
});

describe("delivery tickets", () => {
	test("a refused steer leaves a diagnostic and never rejects", async () => {
		const pi = {
			sendUserMessage: async () => {
				throw new Error("steer channel closed");
			},
		};
		await expect(sendSteerTicket(pi, "keep going")).resolves.toBeUndefined();

		const records = entries("tickets");
		expect(records).toHaveLength(1);
		expect(records[0].message).toBe("steer channel closed");
		expect(records[0].detail).toEqual({ kind: "steer", chars: 10 });
	});

	test("a refused user message leaves a diagnostic and never rejects", async () => {
		const pi = {
			sendUserMessage: async () => {
				throw new Error("no turn could start");
			},
		};
		await expect(sendUserMessageTicket(pi, "do the thing")).resolves.toBeUndefined();

		const records = entries("tickets");
		expect(records).toHaveLength(1);
		expect(records[0].detail).toEqual({ kind: "prompt", chars: 12 });
	});
});

describe("status branch usage", () => {
	test("an unreadable branch is recorded instead of silently zeroing", () => {
		const handlers = new Map();
		createStatusRuntime({}).install({
			on(event, handler) {
				handlers.set(event, handler);
			},
		});
		const ctx = {
			sessionManager: {
				getBranch() {
					throw new Error("branch moved");
				},
			},
			hasUI: false,
		};
		handlers.get("session_start")({}, ctx);

		const records = entries("status");
		expect(records).toHaveLength(1);
		expect(records[0].message).toBe("branch moved");
		expect(records[0].detail).toEqual({ stage: "branch-usage" });
	});
});

describe("hook wiring", () => {
	test("a refused message_end usage listener is recorded, not commented away", () => {
		const handlers = new Map();
		const pi = {
			on(event, handler) {
				if (event === "message_end") throw new Error("message_end refused");
				handlers.set(event, handler);
			},
		};
		const diagnosis = wireHooks(pi, {
			stationFor: () => STATION,
			stationForStop: () => STATION,
		});

		// Transitions still bind through assistant_message.
		expect(diagnosis.ok).toBe(true);
		expect(handlers.has("assistant_message")).toBe(true);

		const records = entries("hooks");
		expect(records).toHaveLength(1);
		expect(records[0].message).toBe("message_end refused");
		expect(records[0].detail).toEqual({
			missing: ["message_end"],
			optional: true,
		});
	});
});

describe("herd-diag rendering", () => {
	test("prints the evidence stored beside a message", async () => {
		record("hooks", new Error("no event"), {
			missing: ["assistant_message", "message_end"],
		});
		const commands = new Map();
		wireCommands(
			{
				registerCommand(name, spec) {
					commands.set(name, spec);
				},
			},
			{ stationFor: () => STATION },
		);

		const text = await commands.get("herd-diag").handler(null, {
			ui: { notify() {} },
		});
		expect(text).toContain("[hooks] no event");
		expect(text).toContain("assistant_message");
		expect(text).toContain("message_end");
	});
});

describe("self handoff", () => {
	test("a failed context rebuild is recorded while the handoff still commits", () => {
		const state = createState();
		state.relay = { ...createRelay(), handoffPending: true, canStop: false };
		const manager = {
			appendCompaction() {},
			buildSessionContext() {
				throw new Error("context builder moved");
			},
		};
		const station = {
			state,
			manager,
			usage: { lastTotalInput: 0 },
			persist() {},
			resetUsageWatermark() {},
			registry: { clearPending() {} },
		};

		const result = commitSelfHandoff(station, {}, "carry on");

		expect(result.ok).toBe(true);
		expect(entries("handoff")).toHaveLength(1);
		expect(entries("handoff")[0].detail).toEqual({ stage: "rebuild-context" });
	});
});
