import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// Set this directory to run the same checks against a previous source tree.
const source = process.env.SESSION_ROUTING_SOURCE
	? pathToFileURL(`${resolve(process.env.SESSION_ROUTING_SOURCE)}/`)
	: new URL("../src/host/", import.meta.url);
const { rememberSession, sessionFor, setAgentMessages } = await import(
	new URL("capture.mjs", source)
);
const { contextHeaderOf, messagesOf, modelOf, sessionOf } = await import(
	new URL("adapter.mjs", source)
);

function makeSession(manager, id, { legacy = false, agentId = false } = {}) {
	const session = {
		sessionManager: manager,
		agent: { state: { messages: [{ role: "user", content: id }] } },
		model: { id: `model-${id}` },
	};
	if (!legacy) session.getAgentId = () => id;
	if (agentId) session.agent.id = id;
	return session;
}

function contextFor(manager, id, session) {
	return { sessionManager: manager, agent: { id }, ...(session ? { session } : {}) };
}

test("request headers retain callable schemas and omit execution functions", () => {
	const session = makeSession({}, "header");
	const parameters = () => {};
	parameters.toJsonSchema = (options) => {
		assert.equal(options.target, "draft-2020-12");
		return { type: "object", properties: { value: { type: "number" } } };
	};
	session.agent.state.systemPrompt = ["Use the tools."];
	session.agent.state.tools = [{ name: "step", description: "Step", parameters, execute() {} }];
	rememberSession(session);
	const header = contextHeaderOf(session);
	assert.equal(header.tools[0].parameters.properties.value.type, "number");
	assert.equal(Object.hasOwn(header.tools[0], "execute"), false);
	header.tools[0].parameters.properties.value.type = "string";
	assert.equal(contextHeaderOf(session).tools[0].parameters.properties.value.type, "number");
});

test("unavailable request schemas stay unknown rather than becoming an empty header", () => {
	const session = makeSession({}, "unknown-header");
	rememberSession(session);
	session.agent.state.systemPrompt = "system";
	session.agent.state.tools = [{ name: "opaque", parameters() {} }];
	assert.equal(contextHeaderOf(session), null);
	session.agent.state.tools = [];
	assert.deepEqual(contextHeaderOf(session), { systemPrompt: "system", tools: [] });
});

test("an explicit session keeps its own messages when its manager is shared", () => {
	const manager = {};
	const owner = makeSession(manager, "Main");
	const first = makeSession(manager, "flow-a");
	const second = makeSession(manager, "flow-b");
	for (const session of [owner, first, second]) rememberSession(session);
	for (const session of [owner, first, second]) {
		assert.equal(sessionFor(session), session);
		assert.equal(sessionOf(session), session);
		assert.equal(messagesOf(session), session.agent.state.messages);
	}
});

test("each context selects its agent after any capture order", () => {
	const manager = {};
	const sessions = ["Main", "flow-a", "flow-b"].map((id) => makeSession(manager, id));
	for (const order of [sessions, [...sessions].reverse(), [sessions[1], sessions[2], sessions[0]]]) {
		for (const session of order) rememberSession(session);
		for (const session of sessions) {
			const ctx = contextFor(manager, session.getAgentId());
			assert.equal(sessionFor(ctx), session);
			assert.equal(sessionOf(ctx), session);
			assert.equal(modelOf(ctx), session.model);
		}
	}
});

test("an explicit raw manager alias resolves flow sessions that use proxies", () => {
	const shared = {};
	const firstProxy = {};
	const secondProxy = {};
	const owner = makeSession(shared, "Main");
	const first = makeSession(firstProxy, "flow-a");
	const second = makeSession(secondProxy, "flow-b");
	rememberSession(owner);
	rememberSession(first, shared);
	rememberSession(second, shared);
	rememberSession(first);
	for (const session of [owner, first, second]) {
		assert.equal(sessionFor(contextFor(shared, session.getAgentId())), session);
		assert.equal(sessionOf(contextFor(session.sessionManager, session.getAgentId())), session);
	}
	assert.equal(sessionFor({ sessionManager: shared }), null);
});

test("raw manager aliases expire when a session changes its own manager", () => {
	const shared = {};
	const session = makeSession({}, "flow-a");
	rememberSession(session, shared);
	session.sessionManager = {};
	rememberSession(session);
	assert.equal(sessionFor(contextFor(shared, "flow-a")), null);
	assert.equal(sessionFor(contextFor(session.sessionManager, "flow-a")), session);
});

test("a flow context changes only that flow's live message list", () => {
	const manager = {};
	const owner = makeSession(manager, "Main");
	const first = makeSession(manager, "flow-a");
	const second = makeSession(manager, "flow-b");
	for (const session of [owner, first, second]) rememberSession(session);
	const ownerMessages = owner.agent.state.messages;
	const secondMessages = second.agent.state.messages;
	const replacement = [{ role: "developer", content: "flow-a state", herdSkill: true }];
	assert.equal(setAgentMessages(contextFor(manager, "flow-a"), replacement), true);
	assert.deepEqual(first.agent.state.messages, replacement);
	assert.notEqual(first.agent.state.messages, replacement);
	assert.equal(owner.agent.state.messages, ownerMessages);
	assert.equal(second.agent.state.messages, secondMessages);
});

test("ctx.session takes precedence over an unrelated manager binding", () => {
	const manager = {};
	const owner = makeSession(manager, "Main");
	const flow = makeSession(manager, "flow-a");
	rememberSession(owner);
	rememberSession(flow);
	const ctx = { sessionManager: manager, session: owner };
	assert.equal(sessionFor(ctx), owner);
	assert.equal(sessionOf(ctx), owner);
});

test("a stale ctx.session cannot bypass an agent identity mismatch", () => {
	const owner = makeSession({}, "Main");
	const ctx = contextFor({}, "flow-a", owner);
	assert.equal(sessionFor(ctx), null);
	assert.equal(sessionOf(ctx), null);
	assert.equal(setAgentMessages(ctx, []), false);
	assert.equal(owner.agent.state.messages.length, 1);
});

test("a valid manager binding can replace a stale explicit session", () => {
	const manager = {};
	const owner = makeSession(manager, "Main");
	const flow = makeSession(manager, "flow-a");
	rememberSession(owner);
	rememberSession(flow);
	const ctx = contextFor(manager, "flow-a", owner);
	assert.equal(sessionFor(ctx), flow);
	assert.equal(sessionOf(ctx), flow);
});

test("a shared manager without a usable identity is not guessed", () => {
	const manager = {};
	rememberSession(makeSession(manager, "Main"));
	rememberSession(makeSession(manager, "flow-a"));
	assert.equal(sessionFor({ sessionManager: manager }), null);
	assert.equal(sessionOf({ sessionManager: manager }), null);
	assert.equal(sessionFor(contextFor(manager, "missing-flow")), null);
});

test("one legacy host session still works without getAgentId", () => {
	const manager = {};
	const session = makeSession(manager, "legacy", { legacy: true });
	rememberSession(session);
	rememberSession(session);
	const ctx = contextFor(manager, "Main");
	assert.equal(sessionFor(ctx), session);
	assert.equal(sessionOf(ctx), session);
	assert.equal(sessionFor(manager), session);
	assert.equal(messagesOf(ctx), session.agent.state.messages);
});

test("explicit legacy sessions remain distinct when their manager is shared", () => {
	const manager = {};
	const owner = makeSession(manager, "owner", { legacy: true });
	const flow = makeSession(manager, "flow", { legacy: true });
	rememberSession(owner);
	rememberSession(flow);
	assert.equal(sessionFor(owner), owner);
	assert.equal(sessionFor(flow), flow);
	assert.equal(sessionOf({ session: owner }), owner);
	assert.equal(sessionFor(contextFor(manager, "unknown")), null);
});

test("agent.id validates legacy ctx.session when getAgentId is absent", () => {
	const owner = makeSession({}, "Main", { legacy: true, agentId: true });
	assert.equal(sessionOf({ agent: { id: "flow-a" }, session: owner }), null);
	assert.equal(sessionOf({ agent: { id: "Main" }, session: owner }), owner);
});

test("a throwing host identity getter can use the agent identity", () => {
	const manager = {};
	const owner = makeSession(manager, "Main", { agentId: true });
	const flow = makeSession(manager, "flow-a", { agentId: true });
	flow.getAgentId = () => { throw new Error("Host identity getter failed"); };
	rememberSession(owner);
	rememberSession(flow);
	assert.equal(sessionFor(contextFor(manager, "Main")), owner);
	assert.equal(sessionFor(contextFor(manager, "flow-a")), flow);
	assert.equal(sessionOf({ agent: { id: "Main" }, session: flow }), null);
});

test("a manager change removes the stale route without losing the session", () => {
	const oldManager = {};
	const nextManager = {};
	const session = makeSession(oldManager, "Main");
	rememberSession(session);
	session.sessionManager = nextManager;
	rememberSession(session);
	assert.equal(sessionFor(contextFor(oldManager, "Main")), null);
	assert.equal(sessionFor(contextFor(nextManager, "Main")), session);
	assert.equal(sessionFor(session), session);
});
