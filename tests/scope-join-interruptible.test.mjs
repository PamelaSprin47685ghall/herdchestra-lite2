// The host only ends a running tool on a queued user message when the tool
// declares itself interruptible. `js` is the only tool left, and it is the one
// that parks inside `await api.scope_join()` / `await api.scope_abandon(...)`,
// so the declaration belongs to it: dropping it would silently turn a join back
// into a wait the user cannot break into.

import { describe, expect, test } from "bun:test";

import { wireTools } from "../src/tools/catalog.mjs";

function fakeHost() {
	const tools = new Map();
	return {
		tools,
		registerTool(definition) {
			tools.set(definition.name, definition);
		},
	};
}

describe("the js tool registration", () => {
	test("declares a wait the host may interrupt for user input", () => {
		const pi = fakeHost();
		wireTools(pi, {});

		const js = pi.tools.get("js");
		expect(js.interruptible).toBe(true);
		// A queued interrupt lets the call run so the elder report is settled
		// instead of skipped.
		expect(js.handlesToolInterrupt).toBe(true);
	});
});
