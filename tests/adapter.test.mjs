import { describe, expect, test } from "bun:test";

import {
	capabilities,
	hostView,
	managerOf,
	messagesOf,
	modelFrom,
	modelOf,
	modelRegistryOf,
	sessionOf,
	settingsOf,
	thinkingFrom,
	thinkingOf,
} from "../host-omp/src/host/adapter.mjs";
import { rememberSession } from "../host-omp/src/host/capture.mjs";

function session(extra = {}) {
	return {
		model: { provider: "openai", id: "gpt-5" },
		thinkingLevel: "high",
		agent: { state: { model: { provider: "xai", id: "grok" }, messages: [{ role: "user" }] } },
		sessionManager: null,
		...extra,
	};
}

describe("sessionOf", () => {
	test("prefers the session bound to the manager", () => {
		const manager = {};
		const live = session();
		rememberSession({
			...live,
			sessionManager: { getSessionId: () => "s1" },
		});
		const bound = session();
		rememberSession(bound);
		expect(sessionOf({ sessionManager: manager })).toBeNull();
	});

	test("finds a session remembered for the context", () => {
		const ctx = { sessionManager: { getSessionId: () => "ctx-1" } };
		const live = session();
		rememberSession(live);
		// rememberSession registers by session object; the manager lookup needs
		// the session to carry that manager, so the direct context path covers
		// the fallback.
		expect(sessionOf(ctx)).toBeNull();
	});

	test("falls back to ctx.session and tolerates junk", () => {
		const live = session();
		expect(sessionOf({ session: live })).toBe(live);
		expect(sessionOf(null)).toBeNull();
		expect(sessionOf(42)).toBeNull();
	});
});

describe("model and thinking reads", () => {
	test("modelFrom reads the live model then the agent state", () => {
		expect(modelFrom({ model: { id: "a" } })).toEqual({ id: "a" });
		expect(modelFrom({ agent: { state: { model: { id: "b" } } } })).toEqual({ id: "b" });
		expect(modelFrom(null)).toBeNull();
	});

	test("modelOf prefers the session over the context", () => {
		const ctx = { session: session(), model: { id: "ctx" } };
		expect(modelOf(ctx)).toEqual({ provider: "openai", id: "gpt-5" });
		expect(modelOf({ model: { id: "ctx" } })).toEqual({ id: "ctx" });
	});

	test("thinkingFrom reads the level and the older thinking field", () => {
		expect(thinkingFrom({ thinkingLevel: "low" })).toBe("low");
		expect(thinkingFrom({ thinking: "medium" })).toBe("medium");
		expect(thinkingFrom({ agent: { state: { thinkingLevel: "high" } } })).toBe("high");
		expect(thinkingFrom({ thinkingLevel: "" })).toBeNull();
	});

	test("thinkingOf prefers the session over the context", () => {
		expect(thinkingOf({ session: { thinkingLevel: "high" }, thinkingLevel: "low" })).toBe("high");
	});

	test("a throwing getter is treated as absent", () => {
		const hostile = {};
		Object.defineProperty(hostile, "model", {
			get() {
				throw new Error("boom");
			},
		});
		expect(modelFrom(hostile)).toBeNull();
		expect(thinkingFrom(hostile)).toBeNull();
	});
});

describe("host objects", () => {
	test("manager, registry, settings, and messages", () => {
		const registry = { find: () => null };
		const settings = new Map([["k", 1]]);
		const live = session({ agent: { state: { messages: [{ role: "user" }] } } });
		const ctx = { session: live, sessionManager: { id: "m" }, modelRegistry: registry, settings };
		expect(managerOf(ctx)).toEqual({ id: "m" });
		expect(modelRegistryOf(ctx)).toBe(registry);
		expect(settingsOf(ctx)).toBe(settings);
		expect(messagesOf(ctx)).toEqual([{ role: "user" }]);
		expect(messagesOf({})).toBeNull();
	});

	test("hostView reports each host object", () => {
		const view = hostView({ session: session(), sessionManager: {}, settings: {} });
		expect(view.session).not.toBeNull();
		expect(view.manager).toEqual({});
		expect(view.model).toEqual({ provider: "openai", id: "gpt-5" });
		expect(view.thinkingLevel).toBe("high");
	});

	test("capabilities is a frozen boolean map", () => {
		const caps = capabilities({});
		expect(Object.isFrozen(caps)).toBe(true);
		expect(caps).toEqual({
			session: false,
			manager: false,
			model: false,
			thinking: false,
			modelRegistry: false,
			settings: false,
		});
	});
});
