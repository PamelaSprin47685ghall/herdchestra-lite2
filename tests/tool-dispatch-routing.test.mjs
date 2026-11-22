// A parent and its children share one SessionManager. The tool gate must
// therefore route by the caller's agent id first: a manager-keyed table alone
// lets whichever station registered last answer for every child.

import { describe, expect, test } from "bun:test";

import { installToolDispatch } from "../host-omp/src/host/tool-dispatch.mjs";

function makeTool() {
	const ran = [];
	const tool = {
		name: "scope",
		async execute(toolCallId) {
			ran.push(toolCallId);
			return "ran";
		},
	};
	return { tool, ran };
}

function makeSession(id, manager) {
	return {
		agent: {
			id,
			beforeToolCall(input) {
				return input;
			},
		},
		sessionManager: manager,
	};
}

function install(session, admit) {
	installToolDispatch(session, () => true, admit);
	session.agent.beforeToolCall({
		assistantMessage: {},
		toolCall: { id: "call", name: "scope" },
		tool: session.tool,
	});
}

function dispatch(session, ctx) {
	return session.tool.execute("call", {}, null, null, ctx);
}

describe("tool dispatch routing", () => {
	test("each agent id keeps its own admission gate on a shared manager", async () => {
		const manager = {};
		const { tool } = makeTool();
		const seen = [];

		const owner = makeSession("owner-1", manager);
		owner.tool = tool;
		install(owner, (toolCallId) => {
			seen.push(["owner", toolCallId]);
			return null;
		});

		const flow = makeSession("flow-1", manager);
		flow.tool = tool;
		install(flow, (toolCallId) => {
			seen.push(["flow", toolCallId]);
			return null;
		});

		// The manager is identical, so only the agent id can tell them apart.
		await dispatch(owner, { agent: { id: "owner-1" }, sessionManager: manager });
		await dispatch(flow, { agent: { id: "flow-1" }, sessionManager: manager });

		expect(seen).toEqual([
			["owner", "call"],
			["flow", "call"],
		]);
	});

	test("a caller without an agent id falls back to the manager key", async () => {
		const manager = {};
		const { tool } = makeTool();
		const seen = [];

		const session = makeSession("flow-2", manager);
		session.tool = tool;
		install(session, (toolCallId) => {
			seen.push(toolCallId);
			return null;
		});

		await dispatch(session, { sessionManager: manager });
		expect(seen).toEqual(["call"]);
	});

	test("a blocking verdict from the routed gate stops the call", async () => {
		const manager = {};
		const { tool, ran } = makeTool();
		const session = makeSession("flow-3", manager);
		session.tool = tool;
		install(session, () => ({ block: true, reason: "OUTSIDE_SCOPE" }));

		await expect(dispatch(session, { agent: { id: "flow-3" }, sessionManager: manager })).rejects.toThrow(
			"OUTSIDE_SCOPE",
		);
		expect(ran).toEqual([]);
	});
});
