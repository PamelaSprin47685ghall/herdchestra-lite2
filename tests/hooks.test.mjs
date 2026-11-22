import { beforeEach, describe, expect, test } from "bun:test";
import {
	reset as resetDiagnostics,
	snapshot as diagnosticsSnapshot,
} from "../host-omp/src/host/diagnostics.mjs";
import { wireHostDiagnosis } from "../host-omp/src/activation/diagnosis.mjs";
import { wireHooks } from "../host-omp/src/activation/hooks.mjs";

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

function fakePi(throwFor = []) {
	const handlers = new Map();
	return {
		handlers,
		on(event, handler) {
			if (throwFor.includes(event)) {
				throw new Error(`no event: ${event}`);
			}
			handlers.set(event, handler);
		},
	};
}

function fakeRegistry() {
	return { stationFor: () => STATION, stationForStop: () => STATION };
}

function hooksRecords() {
	return diagnosticsSnapshot().filter((entry) => entry.domain === "hooks");
}

beforeEach(() => {
	resetDiagnostics();
});

describe("hook wiring", () => {
	test("records a fatal diagnostic when neither message event binds", () => {
		const pi = fakePi(["assistant_message", "message_end"]);
		const diagnosis = wireHooks(pi, fakeRegistry());

		expect(diagnosis.ok).toBe(false);
		expect(diagnosis.missing).toEqual(["assistant_message", "message_end"]);
		expect(hooksRecords()).toHaveLength(1);
		expect(hooksRecords()[0].detail).toEqual({
			missing: ["assistant_message", "message_end"],
		});
		// The remaining events still bind, so the rest of the surfaces work.
		for (const event of [
			"tool_call",
			"context",
			"before_agent_start",
			"session_stop",
			"session_switch",
			"session_compact",
		]) {
			expect(pi.handlers.has(event)).toBe(true);
		}
	});

	test("falls back to message_end when assistant_message is unavailable", () => {
		const pi = fakePi(["assistant_message"]);
		const diagnosis = wireHooks(pi, fakeRegistry());

		expect(diagnosis.ok).toBe(true);
		expect(diagnosis.missing).toEqual([]);
		expect(typeof pi.handlers.get("message_end")).toBe("function");
		expect(hooksRecords()).toHaveLength(0);
	});

	test("session_stop forwards abort and error evidence to the station", () => {
		const seen = [];
		const station = {
			...STATION,
			onSessionStop: (_ctx, evidence) => {
				seen.push(evidence);
				return "station-answer";
			},
		};
		const pi = fakePi();
		wireHooks(pi, { stationFor: () => station, stationForStop: () => station });
		const handler = pi.handlers.get("session_stop");
		const signal = { aborted: false };

		const result = handler(
			{ last_assistant_message: { stopReason: "aborted" }, signal },
			{},
		);
		expect(result).toBe("station-answer");
		expect(seen).toEqual([{ signal, reason: "aborted" }]);

		handler({ last_assistant_message: { stopReason: "error" } }, {});
		expect(seen[1]).toEqual({ signal: null, reason: "error" });
	});

	test("is ok when both message events register", () => {
		const pi = fakePi();
		const diagnosis = wireHooks(pi, fakeRegistry());

		expect(diagnosis.ok).toBe(true);
		expect(diagnosis.error).toBeNull();
		expect(pi.handlers.has("assistant_message")).toBe(true);
		expect(pi.handlers.has("message_end")).toBe(true);
		expect(hooksRecords()).toHaveLength(0);
	});

	test("forwards the shared first turn to the context gatekeeper", () => {
		const seen = [];
		const station = {
			...STATION,
			onContext(messages, _ctx, firstTurn) {
				seen.push({ messages, firstTurn });
				return { messages };
			},
		};
		const pi = fakePi();
		wireHooks(pi, { stationFor: () => station }, "shared snapshot");
		const messages = [{ role: "user", content: "hello", timestamp: 2 }];

		const result = pi.handlers.get("context")({ messages }, {});

		expect(seen).toEqual([{ messages, firstTurn: "shared snapshot" }]);
		expect(result).toEqual({ messages });
	});
});

describe("host diagnosis announcement", () => {
	test("announces a dead message event once per session", () => {
		const pi = fakePi();
		wireHostDiagnosis(pi, null, {
			ok: false,
			missing: ["assistant_message", "message_end"],
			error: null,
		});
		const handler = pi.handlers.get("session_start");
		expect(typeof handler).toBe("function");

		const notices = [];
		const ctx = {
			sessionManager: {},
			ui: { notify: (text, level) => notices.push([text, level]) },
		};
		handler({}, ctx);
		expect(notices).toHaveLength(1);
		expect(notices[0][0]).toContain("host event missing");
		expect(notices[0][0]).toContain("assistant_message");
		expect(notices[0][1]).toBe("error");

		handler({}, ctx);
		expect(notices).toHaveLength(1);
	});

	test("keeps the capture-seam wording when only a seam is missing", () => {
		const pi = fakePi();
		wireHostDiagnosis(pi, {
			ok: false,
			missing: ["extensionRunner"],
			error: null,
		});
		const notices = [];
		pi.handlers.get("session_start")({}, {
			sessionManager: {},
			ui: { notify: (text, level) => notices.push([text, level]) },
		});
		expect(notices[0][0]).toBe(
			"Herdchestra: host seam missing — extensionRunner; the relay is disabled",
		);
	});
});
