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
	renderConsoleReceipt,
} from "../src/station/domain/capabilities.mjs";
import { SessionStation } from "../src/station/station.mjs";
import { PROBE_COMMAND, probeOf } from "./helpers/probe-view.mjs";

function projection(overrides = {}) {
	return {
		mode: "CHILD",
		tools: ["read", "scope_fork", "scope_request"],
		state: {
			mode: "CHILD",
			scope: "/api",
			remaining: { read: "2/3" },
			unreceived: 0,
			scopes: ["/", "/api"],
		},
		signature: "CHILD::read,scope_fork,scope_request|stop=false",
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
		expect(text).toContain("mode: CHILD");
		const view = probeOf(text);
		expect(view.api).toEqual(["read", "scope_fork", "scope_request"]);
		expect(view.scope).toBe("/api");
		expect(view.remaining).toEqual({ read: "2/3" });
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

	test("renders an AWAITING_REPLY projection with the queued request", () => {
		const text = renderConsoleReceipt(
			projection({
				mode: "AWAITING_REPLY",
				tools: ["scope_reply"],
				state: {
					mode: "AWAITING_REPLY",
					scope: "/api",
					request: { from: "/", message: "token or accessToken?" },
					remaining: {},
					unreceived: 0,
					scopes: ["/", "/api"],
				},
			}),
		);
		const view = probeOf(text);

		expect(view.api).toEqual(["scope_reply"]);
		expect(view.request).toEqual({ from: "/", message: "token or accessToken?" });
	});
});

describe("skillReceipt envelope", () => {
	function stubStation(overrides = {}) {
		return {
			projectionFor: () => projection(),
			lastCapKeys: [],
			forkRegistry: () => null,
			state: { features: { autopilot: "off", chinese: "on" }, relay: { canStop: false } },
			forkOwnerId: () => null,
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
		const message = receipt(stubStation());
		expect(message.capSig).toBe(projection().signature);
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
		const message = receipt(stubStation({ lastCapKeys: ["ask", "read", "scope_fork", "scope_request"] }));
		expect(message.content[0].text).toContain("> delete api.ask\ntrue");
	});
});

describe("capSig distinguishes what the model can see", () => {
	const base = {
		isChild: true,
		selfPath: "/api",
		hostToolNames: ["read"],
	};

	test("is stable for an unchanged projection", async () => {
		const { projectCapabilities } = await import("../src/station/domain/capabilities.mjs");
		expect(projectCapabilities(base).signature).toBe(projectCapabilities({ ...base }).signature);
	});

	test("changes when a tool leaves the set", async () => {
		const { projectCapabilities } = await import("../src/station/domain/capabilities.mjs");
		const wide = projectCapabilities({ ...base, hostToolNames: ["read", "bash"] });
		const narrow = projectCapabilities({ ...base, hostToolNames: ["read"] });
		expect(wide.signature).not.toBe(narrow.signature);
	});

	test("changes when the mode changes without a tool changing", async () => {
		const { projectCapabilities } = await import("../src/station/domain/capabilities.mjs");
		const normal = projectCapabilities(base);
		const limited = projectCapabilities({ ...base, contextOverHalf: true });
		expect(normal.mode).toBe("CHILD");
		expect(limited.mode).toBe("CONTEXT_LIMIT");
		expect(normal.signature).not.toBe(limited.signature);
	});

	test("changes when the queued request changes", async () => {
		const { projectCapabilities } = await import("../src/station/domain/capabilities.mjs");
		const first = projectCapabilities({
			...base,
			pendingRequest: { id: "req-1", from: "/", message: "a" },
		});
		const second = projectCapabilities({
			...base,
			pendingRequest: { id: "req-2", from: "/", message: "b" },
		});
		expect(first.mode).toBe("AWAITING_REPLY");
		expect(first.signature).not.toBe(second.signature);
	});
});
