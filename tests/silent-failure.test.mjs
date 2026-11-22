import { beforeEach, describe, expect, test } from "bun:test";
import { createTestStation } from "./helpers/station-ports.mjs";
import {
	record,
	reset as resetDiagnostics,
	snapshot as diagnosticsSnapshot,
} from "../src/host/diagnostics.mjs";
import { createStatusRuntime } from "../src/host/status.mjs";
import { SessionStation } from "../src/station/station.mjs";

function domains() {
	return diagnosticsSnapshot().map((entry) => entry.domain);
}

beforeEach(() => {
	resetDiagnostics();
});

describe("failures that used to vanish", () => {
	test("a throwing status handler is recorded, not dropped", () => {
		const handlers = new Map();
		const pi = {
			on(event, handler) {
				handlers.set(event, handler);
			},
		};
		createStatusRuntime({}).install(pi);
		const sessionStart = handlers.get("session_start");
		expect(typeof sessionStart).toBe("function");

		const ctx = {
			get agent() {
				throw new Error("agent surface moved");
			},
		};
		expect(() => sessionStart({}, ctx)).not.toThrow();
		expect(domains()).toContain("status");
	});

	test("a usage baseline that cannot be restored is recorded", () => {
		const manager = {
			getBranch() {
				throw new Error("branch moved");
			},
			appendCustomEntry() {
				return "entry-1";
			},
		};
		const station = createTestStation(SessionStation, 
		manager,
		{},
		{},
		{ host: () => ({ record }) },
		null,
	);
		expect(station.state).toBeDefined();
		// The restore path reports its own failure too.
		expect(domains()).toContain("restore");
		expect(domains()).toContain("usage");
	});
});
