import { describe, expect, test } from "bun:test";
import { wireHostDiagnosis } from "../host-omp/src/activation/diagnosis.mjs";

function makeHost() {
	const handlers = new Map();
	const pi = {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
	};
	const emit = (event, payload, ctx) => {
		for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
	};
	return { pi, emit };
}

function makeCtx() {
	const notices = [];
	const manager = {};
	return {
		notices,
		ctx: {
			sessionManager: manager,
			ui: {
				notify(text, level) {
					notices.push({ text, level });
				},
			},
		},
	};
}

describe("host seam announcement", () => {
	test("names the missing seam on session_start", () => {
		const { pi, emit } = makeHost();
		wireHostDiagnosis(pi, {
			ok: false,
			missing: ["extensionRunner"],
			error: "getter unavailable",
		});
		const { ctx, notices } = makeCtx();
		emit("session_start", {}, ctx);
		expect(notices).toHaveLength(1);
		expect(notices[0].level).toBe("error");
		expect(notices[0].text).toContain("host seam missing");
		expect(notices[0].text).toContain("extensionRunner");
		expect(notices[0].text).toContain("the relay is disabled");
	});

	test("names every missing seam", () => {
		const { pi, emit } = makeHost();
		wireHostDiagnosis(pi, {
			ok: false,
			missing: ["activateVibeTools", "agent.state.messages"],
			error: null,
		});
		const { ctx, notices } = makeCtx();
		emit("session_start", {}, ctx);
		expect(notices[0].text).toContain("activateVibeTools");
		expect(notices[0].text).toContain("agent.state.messages");
	});

	test("falls back to the recorded error when no seam is listed", () => {
		const { pi, emit } = makeHost();
		wireHostDiagnosis(pi, {
			ok: false,
			missing: [],
			error: "AgentSession is unavailable",
		});
		const { ctx, notices } = makeCtx();
		emit("session_start", {}, ctx);
		expect(notices[0].text).toContain("AgentSession is unavailable");
	});

	test("announces once per session", () => {
		const { pi, emit } = makeHost();
		wireHostDiagnosis(pi, { ok: false, missing: ["extensionRunner"], error: null });
		const { ctx, notices } = makeCtx();
		emit("session_start", {}, ctx);
		emit("session_start", {}, ctx);
		expect(notices).toHaveLength(1);
	});

	test("announces again for a different session", () => {
		const { pi, emit } = makeHost();
		wireHostDiagnosis(pi, { ok: false, missing: ["extensionRunner"], error: null });
		const first = makeCtx();
		const second = makeCtx();
		emit("session_start", {}, first.ctx);
		emit("session_start", {}, second.ctx);
		expect(first.notices).toHaveLength(1);
		expect(second.notices).toHaveLength(1);
	});

	test("a healthy diagnosis registers nothing", () => {
		const { pi, emit } = makeHost();
		wireHostDiagnosis(pi, { ok: true, missing: [], error: null });
		const { ctx, notices } = makeCtx();
		emit("session_start", {}, ctx);
		expect(notices).toEqual([]);
	});

	test("a throwing notify does not escape the handler", () => {
		const { pi, emit } = makeHost();
		wireHostDiagnosis(pi, { ok: false, missing: ["extensionRunner"], error: null });
		const ctx = {
			sessionManager: {},
			ui: {
				notify() {
					throw new Error("headless");
				},
			},
		};
		expect(() => emit("session_start", {}, ctx)).not.toThrow();
	});
});
