// A forked scope projects the parent's transcript. If the parent had retired a
// beat with `scope_context({ amend })` before the fork, the child must drop the
// same beat: otherwise its outbound list re-includes it, the request prefix
// stops matching the parent's, and the provider cache misses on the child's
// first request. The keys travel as data on the child identity, and each side
// keeps its own array afterwards.

import { describe, expect, test } from "bun:test";

import { inheritedAmends, buildChildIdentity } from "../src/station/domain/identity.mjs";
import { projectContext } from "../src/station/domain/context.mjs";
import {
	createForkRegistry,
	identityForAgent,
	setIdentity,
} from "../src/scope/fork-registry.mjs";
import { beatKey } from "../src/transcript/messages.mjs";

function assistant(text, timestamp) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp,
	};
}

/** The seed `bindForkPorts` runs, without a Station: same loop, same order. */
function seed(state, identity) {
	if (state && Array.isArray(identity?.amends)) {
		for (const key of identity.amends) {
			if (typeof key !== "string" || key === "") continue;
			if (!state.amends.includes(key)) state.amends.push(key);
		}
	}
	return state;
}

describe("a forked scope inherits its parent's amended beats", () => {
	test("the identity carries the parent's keys and copies them", () => {
		const parentKeys = ["msg:1:aaa"];
		const identity = buildChildIdentity(
			{ forkId: "fork_a", parentOwnerId: "root" },
			{ agentId: "agent-1", amends: parentKeys },
		);

		expect(identity.amends).toEqual(["msg:1:aaa"]);
		expect(identity.amends).not.toBe(parentKeys);
	});

	test("the registry keeps a string-only copy of the keys", () => {
		const registry = createForkRegistry();
		setIdentity(
			registry,
			"fork_a",
			buildChildIdentity(
				{ forkId: "fork_a" },
				{ agentId: "agent-1", amends: ["msg:1:aaa", 7, null] },
			),
		);

		const identity = identityForAgent(registry, "agent-1");
		expect(identity.amends).toEqual(["msg:1:aaa"]);
	});

	test("the child station seeds its own array from the identity", () => {
		const state = { amends: [] };

		seed(state, { forkId: "fork_a", amends: ["msg:1:aaa"] });

		expect(state.amends).toEqual(["msg:1:aaa"]);
		// A second attach is a refresh, not a second copy.
		seed(state, { forkId: "fork_a", amends: ["msg:1:aaa"] });
		expect(state.amends).toEqual(["msg:1:aaa"]);
	});

	test("parent and child project the same beats away", () => {
		const retired = assistant("retired beat", 1);
		const kept = assistant("kept beat", 2);
		const messages = [retired, kept];
		const parentKeys = [beatKey(retired)];

		const parent = projectContext({ amends: parentKeys }, { original: messages });
		const child = projectContext(
			{ amends: inheritedAmends(parentKeys) },
			{ original: messages },
		);

		expect(parent.messages).toEqual([kept]);
		expect(child.messages).toEqual(parent.messages);
	});

	test("an amend after the fork stays on the side that made it", () => {
		const parentAmends = ["msg:1:aaa"];
		const state = seed({ amends: [] }, { forkId: "fork_a", amends: parentAmends });

		state.amends.push("msg:2:bbb");
		parentAmends.push("msg:3:ccc");

		expect(state.amends).toEqual(["msg:1:aaa", "msg:2:bbb"]);
		expect(parentAmends).toEqual(["msg:1:aaa", "msg:3:ccc"]);
	});

	test("a root station inherits nothing", () => {
		const state = seed({ amends: [] }, null);

		expect(state.amends).toEqual([]);
	});
});
