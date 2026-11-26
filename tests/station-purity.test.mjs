// Station purity contracts: every detached ticket consumes its own rejection,
// policy() is side-effect free, and port tables are frozen once at composition.

import { readdirSync, readFileSync } from "node:fs";

import { beforeEach, expect, test } from "bun:test";
import { createTestStation } from "./helpers/station-ports.mjs";

import { buildPorts } from "../src/core/ports/build.mjs";

import {
	record,
	reset as resetDiagnostics,
	snapshot as diagnosticsSnapshot,
} from "../host-omp/src/host/diagnostics.mjs";
import { activate } from "../host-omp/src/main.mjs";
import { SessionStation } from "../src/station/station.mjs";

function rwContext() {
	const branch = [
		{
			type: "session_init",
			agent: "worker",
			readOnly: false,
			tools: ["read", "write"],
		},
	];
	return {
		sessionManager: {
			getSessionId: () => "s1",
			getBranch: () => branch,
		},
	};
}

function stationWith(tickets, host = {}) {
	return createTestStation(SessionStation,
		{ getSessionId: () => "s1", getBranch: () => [] },
		host,
		tickets,
		{ ports: () => ({}), host: () => ({ record }) },
		null,
	);
}

function compositionHost() {
	const handlers = new Map();
	return {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		registerTool() {},
		registerCommand() {},
		sendUserMessage() {
			return Promise.resolve();
		},
	};
}

beforeEach(() => resetDiagnostics());

test("policy() is a pure query without side effects", () => {
	const station = stationWith({ steer: () => Promise.resolve(), prompt: () => Promise.resolve() });
	expect(() => station.policy(rwContext())).not.toThrow();
});

test("a rejecting steer and prompt ticket is recorded, not left unhandled", async () => {
	const station = stationWith({
		canSteer: true,
		canPrompt: true,
		steer: () => Promise.reject(new Error("steer moved")),
		prompt: () => Promise.reject(new Error("prompt moved")),
	});

	expect(station.deliverSteer("steer")).toBe(true);
	expect(station.deliverUserMessage("prompt")).toBe(true);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(
		diagnosticsSnapshot()
			.filter((entry) => entry.domain === "tickets")
			.map((entry) => entry.message),
	).toEqual(["steer moved", "prompt moved"]);
});

test("a synchronously throwing steer and prompt capability is recorded, not thrown", () => {
	const station = stationWith({
		canSteer: true,
		canPrompt: true,
		steer: () => {
			throw new Error("steer is not installed");
		},
		prompt: () => {
			throw new Error("prompt is not installed");
		},
	});

	expect(() => station.deliverSteer("steer")).not.toThrow();
	expect(() => station.deliverUserMessage("prompt")).not.toThrow();
	expect(
		diagnosticsSnapshot()
			.filter((entry) => entry.domain === "tickets")
			.map((entry) => entry.message),
	).toEqual(["steer is not installed", "prompt is not installed"]);
});

test("a refused scoped model switch is recorded through the station", () => {
	const station = stationWith({});

	station.noteScopedModelFailure(
		{ command: "/model fast" },
		{ reason: "host refused" },
	);
	expect(station.lastError).toBe("/model fast: host refused");
	expect(diagnosticsSnapshot().some((entry) => entry.domain === "model")).toBe(
		true,
	);
});

test("the production entry injects the off port implementations", async () => {
	const wired = await activate(compositionHost(), {
		HERD_CLOCK: "off",
	});
	expect(wired.engine.registry.ports().clock).toBe("off");
	const { clock } = wired.engine.registry.implementations();
	expect(clock.name).toBe("off");
});

test("the production entry injects the on port implementations by default", async () => {
	const wired = await activate(compositionHost(), {});
	expect(wired.engine.registry.ports().clock).toBe("on");
	const { clock } = wired.engine.registry.implementations();
	expect(clock.name).toBe("on");
});

test("a station captures the port table once and freezes it", () => {
	const station = stationWith({});
	expect(Object.isFrozen(station.portTable)).toBe(true);
	expect(station.portTable).toBe(station.registry.ports());
});

test("a station without a complete port table refuses to start", () => {
	const built = buildPorts({});
	let error;
	try {
		new SessionStation(
			{ getSessionId: () => "s1", getBranch: () => [] },
			{},
			{},
			{
				ports: () => ({}),
				implementations: () => built.implementations,
			},
			null,
		);
	} catch (caught) {
		error = caught;
	}
	expect(error?.code).toBe("MISSING_PORTS");
	expect(error?.missing).toContain("clock");
});

const PORT_TABLE_READ = /\.\s*ports\s*(?:\?\.)?\s*\(/;
const PRE_RATCHET_READ = /registry\?*\.ports\?*\(/;

function portTableReads(source) {
	return [...source.matchAll(new RegExp(PORT_TABLE_READ.source, "g"))];
}

test("the port-table detector catches every call spelling", () => {
	for (const sample of [
		"registry.ports(",
		"registry?.ports(",
		"registry?.ports?.(",
		'station["registry"].ports()',
		"wired.ports()",
	]) {
		expect(portTableReads(sample)).toHaveLength(1);
	}
	expect(portTableReads("const table = station.portTable;")).toHaveLength(0);
	expect(portTableReads("options.ports?.status")).toHaveLength(0);

	const perEventRead = "const ports = registry?.ports?.();";
	expect(portTableReads(perEventRead)).toHaveLength(1);
	expect(perEventRead).not.toMatch(PRE_RATCHET_READ);
	expect('station["registry"].ports()').not.toMatch(PRE_RATCHET_READ);
});

function readsUnder(relative) {
	const root = new URL(relative, import.meta.url);
	const files = readdirSync(root, { recursive: true })
		.map(String)
		.filter((file) => file.endsWith(".mjs"))
		.sort();
	const reads = [];
	for (const file of files) {
		const source = readFileSync(new URL(file, root), "utf8");
		for (const match of portTableReads(source)) {
			reads.push({ file, match: match[0] });
		}
	}
	return reads;
}

test("the extension reads the port table only at composition time", () => {
	expect(readsUnder("../host-omp/src/host/")).toEqual([
		{ file: "provider-observer.mjs", match: ".ports(" },
	]);

	const stationSource = readFileSync(
		new URL("../src/station/station.mjs", import.meta.url),
		"utf8",
	);
	expect(stationSource).toContain("const portTable = registry?.ports?.();");
	const observerSource = readFileSync(
		new URL("../host-omp/src/host/provider-observer.mjs", import.meta.url),
		"utf8",
	);
	expect(observerSource).toContain(
		'if (ports?.observer === "off") return { installed: false };',
	);
});

test("the composition root never substitutes an empty port table", () => {
	const source = readFileSync(
		new URL("../host-omp/src/main.mjs", import.meta.url),
		"utf8",
	);
	expect(source).not.toMatch(/\bwired\.ports\s*\?\?/);
});
