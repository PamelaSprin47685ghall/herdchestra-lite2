// The per-turn REPL probe: the one user message that tells the model what it
// may call right now.
//
// Two contracts matter to a consumer:
//   1. The probe is level-triggered — it reprints the whole projection every
//      turn, so a lost transition cannot hide the truth; the only edge signal
//      is the `> delete api.<k>` line on the turn a key disappears.
//   2. The receipt's `capSig` must change exactly when the projection changes,
//      because the host reuses a committed receipt whose capSig still matches.
//      A capSig that survives a mode change would leave the model reading a
//      stale capability list.

import { describe, expect, test } from "bun:test";

import {
	projectCapabilities,
	renderConsoleReceipt,
} from "../src/station/domain/capabilities.mjs";
import { SessionStation } from "../src/station/station.mjs";
import { PROBE_COMMAND, probeOf } from "./helpers/probe-view.mjs";

function projection(overrides = {}) {
	return {
		mode: "SUBSCOPE",
		tools: ["read", "scope_abandon", "scope_fork", "scope_join", "scope_return"],
		state: {
			mode: "SUBSCOPE",
			scope: "/api",
			remaining: { read: "2/3" },
			unreceived: 0,
			scopes_delta: {
				"/": "done | m1 | 10k / 200k",
				"/api": "running | m1 | 10k+ / 200k",
			},
		},
		signature: "SUBSCOPE::read,scope_abandon,scope_fork,scope_join,scope_return|stop=false",
		...overrides,
	};
}

// The probe body is parsed by tests/helpers/probe-view.mjs.

describe("renderConsoleReceipt", () => {
	test("prints the REPL command, then a block YAML document", () => {
		const text = renderConsoleReceipt(projection());

		expect(text).toContain(PROBE_COMMAND);
		// Block YAML: the tool list is a sequence, not one flow line.
		expect(text).toContain("api:");
		expect(text).toContain("mode: SUBSCOPE");
		const view = probeOf(text);
		expect(view.api).toEqual(["read", "scope_abandon", "scope_fork", "scope_join", "scope_return"]);
		expect(view.scope).toBe("/api");
		expect(view.remaining).toEqual({ read: "2/3" });
		expect(view.scopes_delta).toEqual({
			"/": "done | m1 | 10k / 200k",
			"/api": "running | m1 | 10k+ / 200k",
		});
	});

	test("shows an edge highlight only for keys that just disappeared", () => {
		const withEdge = renderConsoleReceipt(projection(), { removedKeys: ["ask"] });
		const lines = withEdge.split("\n");

		expect(lines[0]).toBe("> delete api.ask");
		expect(lines[1]).toBe("true");
		expect(lines[2]).toBe(PROBE_COMMAND);

		const withoutEdge = renderConsoleReceipt(projection());
		expect(withoutEdge).not.toContain("> delete api.");
	});

	test("skips empty and non-string removed keys instead of printing junk", () => {
		const text = renderConsoleReceipt(projection(), { removedKeys: ["", null, "read"] });
		expect(text).toContain("> delete api.read");
		expect(text).not.toContain("> delete api.\n");
	});

	test("carries the language requirement by default and drops it on 'off'", () => {
		expect(renderConsoleReceipt(projection())).toContain("强制以简体中文思考");
		expect(renderConsoleReceipt(projection(), { chinese: "off" })).not.toContain(
			"强制以简体中文思考",
		);
	});

	test("carries no context-pressure line; the hard mode is the signal", () => {
		expect(renderConsoleReceipt(projection())).not.toContain("Context Pressure");
		expect(
			renderConsoleReceipt(projection({ mode: "CONTEXT_LIMIT", tools: ["scope_return"] })),
		).not.toContain("Context Pressure");
	});

	test("renders an ABANDONED projection with state.abandoned", () => {
		const text = renderConsoleReceipt(
			projection({
				mode: "ABANDONED",
				tools: ["scope_return"],
				state: {
					mode: "ABANDONED",
					scope: "/api",
					abandoned: { by: "/", reason: "taking another path" },
					remaining: {},
					unreceived: 0,
				},
			}),
		);
		const view = probeOf(text);

		expect(view.api).toEqual(["scope_return"]);
		expect(view.abandoned).toEqual({ by: "/", reason: "taking another path" });
	});
});

describe("skillReceipt envelope", () => {
	function defaultSnapshot(overrides = {}) {
		return {
			isChild: true,
			autopilot: false,
			chinese: "on",
			unreceived: 0,
			canStop: false,
			contextOverHalf: false,
			abandoned: null,
			remaining: { read: "2/3" },
			selfPath: "/api",
			scopesDelta: null,
			_currentDir: {},
			_dirSeq: 0,
			hostToolNames: ["read"],
			...overrides,
		};
	}

	function stubStation(overrides = {}) {
		const snapshot = overrides.snapshot ?? defaultSnapshot();
		return {
			capabilitySnapshot: () => snapshot,
			lastCapKeys: [],
			forkRegistry: () => null,
			state: { features: { autopilot: "off", chinese: "on" }, relay: { canStop: false } },
			forkOwnerId: () => null,
			projectionFor(ctx) {
				return SessionStation.prototype.projectionFor.call(this, ctx);
			},
			...overrides,
		};
	}

	function receipt(station) {
		return SessionStation.prototype.skillReceipt.call(station, {});
	}

	test("keeps the three fields the web transcript reads", () => {
		const message = receipt(stubStation());

		expect(message.role).toBe("user");
		expect(message.attribution).toBe("agent");
		expect(message.herdSkill).toBe(true);
		expect(message.content).toHaveLength(1);
		expect(message.content[0].type).toBe("text");
		expect(message.content[0].text).toContain(PROBE_COMMAND);
	});

	test("stamps the projection's signature as the cache key", () => {
		const station = stubStation();
		const message = receipt(station);
		expect(message.capSig).toBe(projectCapabilities(station.capabilitySnapshot()).signature);
	});

	test("reports the branch flags the host folds on", () => {
		const child = receipt(
			stubStation({ forkOwnerId: () => "api", state: { features: { autopilot: "on", chinese: "on" }, relay: {} } }),
		);
		expect(child.branch).toBe(true);
		expect(child.autopilot).toBe(true);
		expect(child.canStop).toBe(false);

		const root = receipt(
			stubStation({ state: { features: { autopilot: "on", chinese: "on" }, relay: { canStop: true } } }),
		);
		expect(root.branch).toBe(false);
		expect(root.canStop).toBe(true);
	});

	test("highlights a key withdrawn since the previous turn", () => {
		const message = receipt(stubStation({ lastCapKeys: ["ask", "read", "scope_fork", "scope_join"] }));
		expect(message.content[0].text).toContain("> delete api.ask\ntrue");
	});
});

describe("capSig distinguishes what the model can see", () => {
	const base = {
		isChild: true,
		selfPath: "/api",
		hostToolNames: ["read"],
	};

	test("is stable for an unchanged projection", () => {
		expect(projectCapabilities(base).signature).toBe(projectCapabilities({ ...base }).signature);
	});

	test("changes when a tool leaves the set", () => {
		const wide = projectCapabilities({ ...base, hostToolNames: ["read", "bash"] });
		const narrow = projectCapabilities({ ...base, hostToolNames: ["read"] });
		expect(wide.signature).not.toBe(narrow.signature);
	});

	test("changes when the mode changes without a tool changing", () => {
		const normal = projectCapabilities(base);
		const limited = projectCapabilities({ ...base, contextOverHalf: true });
		expect(normal.mode).toBe("SUBSCOPE");
		expect(limited.mode).toBe("CONTEXT_LIMIT");
		expect(normal.signature).not.toBe(limited.signature);
	});

	test("changes when abandoned reason changes", () => {
		const first = projectCapabilities({
			...base,
			abandoned: { by: "/", reason: "a" },
		});
		const second = projectCapabilities({
			...base,
			abandoned: { by: "/", reason: "b" },
		});
		expect(first.mode).toBe("ABANDONED");
		expect(first.signature).not.toBe(second.signature);
	});
});
