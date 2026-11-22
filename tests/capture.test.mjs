import { beforeEach, describe, expect, test } from "bun:test";
import {
	captureDiagnosis,
	installRunnerCapture,
	installVibeTools,
	rememberSession,
	setAgentMessages,
} from "../host-omp/src/host/capture.mjs";

// capture.mjs keeps its install state on globalThis so a second extension copy
// cannot double-patch. Each test starts from a clean capture record.
const STATE_KEY = Symbol.for("herdchestra-lite2.session-capture.v2");

beforeEach(() => {
	delete globalThis[STATE_KEY];
});

function agentSessionWith({ getter = true, vibeTools = true } = {}) {
	class FakeAgentSession {}
	if (vibeTools) {
		FakeAgentSession.prototype.activateVibeTools = function activate(
			names,
		) {
			return names;
		};
	}
	if (getter) {
		let runner = null;
		Object.defineProperty(FakeAgentSession.prototype, "extensionRunner", {
			configurable: true,
			get() {
				return runner;
			},
		});
	}
	return FakeAgentSession;
}

describe("capture diagnosis", () => {
	test("reports a missing extensionRunner getter", () => {
		const Session = agentSessionWith({ getter: false });
		installRunnerCapture(Session);
		const diagnosis = captureDiagnosis();
		expect(diagnosis.ok).toBe(false);
		expect(diagnosis.missing).toContain("extensionRunner");
	});

	test("reports missing activateVibeTools", () => {
		const Session = agentSessionWith({ vibeTools: false });
		installRunnerCapture(Session);
		const diagnosis = captureDiagnosis();
		expect(diagnosis.ok).toBe(false);
		expect(diagnosis.missing).toContain("activateVibeTools");
	});

	test("is ok when the host exposes both seams", () => {
		const Session = agentSessionWith();
		installRunnerCapture(Session);
		const diagnosis = captureDiagnosis();
		expect(diagnosis.ok).toBe(true);
		expect(diagnosis.missing).toEqual([]);
	});

	test("returns the diagnosis shape, not the internal record", () => {
		const diagnosis = installRunnerCapture(agentSessionWith());
		expect(diagnosis.ok).toBe(true);
		expect(diagnosis.missing).toEqual([]);
		expect(diagnosis.error).toBeNull();
	});

	test("the returned diagnosis names a missing seam", () => {
		const diagnosis = installRunnerCapture(agentSessionWith({ getter: false }));
		expect(diagnosis.ok).toBe(false);
		expect(diagnosis.missing).toContain("extensionRunner");
	});

	test("stays ok before any message array is written", () => {
		installRunnerCapture(agentSessionWith());
		expect(captureDiagnosis().missing).not.toContain("agent.state.messages");
	});

	test("marks agent.state.messages after a failed write", () => {
		const Session = agentSessionWith();
		installRunnerCapture(Session);
		const session = {
			get agent() {
				throw new Error("host moved the agent state");
			},
		};
		rememberSession(session);
		expect(setAgentMessages(session, [])).toBe(false);
		expect(captureDiagnosis().missing).toContain("agent.state.messages");
	});

	test("marks agent.state.messages after a successful write", () => {
		installRunnerCapture(agentSessionWith());
		const session = { agent: { state: { messages: [] } } };
		rememberSession(session);
		expect(setAgentMessages(session, [{ role: "user" }])).toBe(true);
		expect(session.agent.state.messages).toEqual([{ role: "user" }]);
		expect(captureDiagnosis().missing).not.toContain("agent.state.messages");
	});

	test("a second vibe-tools install keeps the seam recorded", () => {
		const Session = agentSessionWith();
		expect(installVibeTools(Session)).toBe(true);
		expect(installVibeTools(Session)).toBe(true);
		expect(captureDiagnosis().missing).not.toContain("activateVibeTools");
	});
});
