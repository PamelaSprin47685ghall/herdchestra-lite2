// A fork child must reach the same request-preparation hook as the root.
// Without it the host's skill receipt is committed by the default path and the
// child can fail the prefix check before producing any message.

import { describe, expect, test } from "bun:test";

import { prepareChildContext } from "../host-omp/src/host/branch-context.mjs";

function childSession({ withRunner = true, withHook = true } = {}) {
	const calls = [];
	const agent = { id: "child-a" };
	if (withHook) {
		agent.addBeforeModelCallHook = (hook) => {
			calls.push("hook");
			return () => calls.push("detach");
		};
	}
	const session = { agent };
	if (withRunner) {
		session.extensionRunner = {
			createContext: () => ({ agent: { id: "child-a" } }),
		};
	}
	return { session, calls };
}

const station = {
	state: { epoch: 0 },
	prepareRequest: () => null,
};

describe("prepareChildContext", () => {
	test("installs the child's request preparation on the real station", () => {
		const { session, calls } = childSession();
		const seen = [];
		const result = prepareChildContext(session, (ctx) => {
			seen.push(ctx.agent.id);
			return station;
		});

		expect(result.ok).toBe(true);
		expect(seen).toEqual(["child-a"]);
		expect(calls).toEqual(["hook"]);
		expect(session.agent[Symbol.for("herdchestra-lite2.context-preparation.v1")]).toBeDefined();
	});

	test("refuses when the child exposes no extension context", () => {
		const { session } = childSession({ withRunner: false });
		const result = prepareChildContext(session, () => station);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("NO_CONTEXT");
	});

	test("refuses when the child station has no prepareRequest", () => {
		const { session } = childSession();
		const result = prepareChildContext(session, () => ({}));
		expect(result.ok).toBe(false);
		expect(result.code).toBe("NO_STATION");
	});

	test("refuses when the host cannot install the model-call hook", () => {
		const { session } = childSession({ withHook: false });
		const result = prepareChildContext(session, () => station);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("INSTALL_FAILED");
	});
});
