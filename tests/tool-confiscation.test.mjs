// Tool confiscation: the host hides every native and MCP tool and leaves only
// the core's `js` tool, keeping the rest in a snapshot that feeds two
// consumers — the static `.d.ts` compiler and the vm's inner dispatch.
//
// Two failure modes are worth pinning:
//   - hiding too much: an agent the core does not own (no `js` tool) or a
//     read-only subagent must keep its tools, or the host loses its own
//     capabilities;
//   - hiding too little: the host rebuilds its tool list every turn, so the
//     guard must run on each request boundary, not once at start.

import { describe, expect, test } from "bun:test";

import {
	createToolGateway,
	installToolConfiscation,
} from "../host-omp/src/host/tool-confiscation.mjs";

const JS_TOOL = { name: "js", execute: () => ({}) };

function tool(name, extra = {}) {
	return {
		name,
		description: `${name} tool`,
		parameters: { type: "object", properties: { path: { type: "string" } } },
		execute: () => ({ content: [{ type: "text", text: name }] }),
		...extra,
	};
}

function agentWith(tools) {
	return { state: { tools } };
}

/** A pi stand-in that records every event handler it is handed. */
function fakePi() {
	const handlers = new Map();
	return {
		handlers,
		on(event, fn) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(fn);
		},
		fire(event, ctx) {
			for (const fn of handlers.get(event) ?? []) fn({}, ctx);
		},
	};
}

function engineFor(station = { policy: () => "interactive" }) {
	const readOnly = () => station.policy({}) === "read-only-subagent";
	return {
		hasStation: () => true,
		station: () => station,
		peekStation: () => station,
		isReadOnlySubagent: readOnly,
		coreTools: {},
	};
}

const ADMIN_STATION = { policy: () => "interactive" };

describe("installToolConfiscation", () => {
	test("registers on every request boundary", () => {
		const pi = fakePi();
		installToolConfiscation(pi, () => engineFor(ADMIN_STATION));
		for (const event of ["session_start", "before_agent_start", "context"]) {
			expect(pi.handlers.get(event)).toHaveLength(1);
		}
	});

	test("leaves exactly the js tool and hides the rest", () => {
		const read = tool("read");
		const bash = tool("bash");
		const agent = agentWith([JS_TOOL, read, bash]);
		const pi = fakePi();
		installToolConfiscation(pi, () => engineFor(ADMIN_STATION));

		pi.fire("before_agent_start", { agent });

		expect(agent.state.tools).toEqual([JS_TOOL]);
	});

	test("hides again after the host rebuilds its list", () => {
		const read = tool("read");
		const agent = agentWith([JS_TOOL, read]);
		const pi = fakePi();
		installToolConfiscation(pi, () => engineFor(ADMIN_STATION));

		pi.fire("before_agent_start", { agent });
		// A later turn rebuilds the native list; the guard must still hold.
		agent.state.tools = [JS_TOOL, read];
		pi.fire("context", { agent });

		expect(agent.state.tools).toEqual([JS_TOOL]);
	});

	test("does nothing to an agent that carries no js tool", () => {
		const read = tool("read");
		const agent = agentWith([read]);
		const pi = fakePi();
		installToolConfiscation(pi, () => engineFor(ADMIN_STATION));

		pi.fire("before_agent_start", { agent });

		expect(agent.state.tools).toEqual([read]);
	});

	test("does not disarm a read-only subagent", () => {
		const read = tool("read");
		const js = tool("js");
		const agent = agentWith([js, read]);
		const pi = fakePi();
		installToolConfiscation(pi, () => engineFor({ policy: () => "read-only-subagent" }));

		pi.fire("before_agent_start", { agent });

		expect(agent.state.tools).toEqual([js, read]);
	});

	test("a host without a station is treated as unguided, not foreign", () => {
		const read = tool("read");
		const js = tool("js");
		const agent = agentWith([js, read]);
		const pi = fakePi();
		const engine = { hasStation: () => false, station: () => null, coreTools: {} };
		installToolConfiscation(pi, () => engine);

		pi.fire("before_agent_start", { agent });

		expect(agent.state.tools).toEqual([js]);
	});
});

describe("listSpecs", () => {
	test("lists the hidden tools, never the js tool", () => {
		const gateway = createToolGateway(() => engineFor(ADMIN_STATION));
		const agent = agentWith([JS_TOOL, tool("read"), tool("bash")]);

		const specs = gateway.listSpecs({ agent });

		expect(specs.map((spec) => spec.name)).toEqual(["bash", "read"]);
		expect(specs.every((spec) => spec.name !== "js")).toBe(true);
	});

	test("converts an ArkType-like parameters factory to JSON Schema", () => {
		// An ArkType type is callable and carries `toJsonSchema`; only that
		// shape is converted, so the stub must be a function too.
		const parameters = function parameters() {};
		parameters.toJsonSchema = ({ target }) => ({ type: "object", title: target });
		const arkType = tool("read", { parameters });
		const gateway = createToolGateway(() => engineFor(ADMIN_STATION));
		const specs = gateway.listSpecs({ agent: agentWith([JS_TOOL, arkType]) });

		expect(specs[0].parameters).toEqual({ type: "object", title: "draft-2020-12" });
	});

	test("degrades to an empty list when nothing is hidden yet", () => {
		const gateway = createToolGateway(() => engineFor(ADMIN_STATION));
		expect(gateway.listSpecs({ agent: agentWith([tool("read")]) })).toEqual([]);
	});
});

describe("execute", () => {
	test("routes a scope control to the core table, not the snapshot", () => {
		const seen = [];
		const engine = {
			hasStation: () => true,
			station: () => ADMIN_STATION,
			coreTools: {
				scope_fork: {
					execute: (id, args, signal, onUpdate, ctx) => {
						seen.push({ id, args, ctx });
						return { content: [{ type: "text", text: "forked" }] };
					},
				},
			},
		};
		const gateway = createToolGateway(() => engine);
		const ctx = { agent: agentWith([JS_TOOL]) };

		gateway.execute("scope_fork", "c1", { forks: [] }, null, undefined, ctx);

		expect(seen).toHaveLength(1);
		expect(seen[0].id).toBe("c1");
		expect(seen[0].args).toEqual({ forks: [] });
	});

	test("passes the live ctx to a host tool untouched", () => {
		let received = null;
		const read = tool("read", {
			execute: (id, args, signal, onUpdate, ctx) => {
				received = { id, args, ctx };
				return { content: [{ type: "text", text: "ok" }] };
			},
		});
		const ctx = { agent: agentWith([JS_TOOL, read]), ui: { approve: () => true } };
		const gateway = createToolGateway(() => engineFor(ADMIN_STATION));

		gateway.execute("read", "c2", { path: "a" }, null, undefined, ctx);

		// Identity, not shape: the host's UI fences are bound to this object.
		expect(received.ctx).toBe(ctx);
		expect(received.args).toEqual({ path: "a" });
	});

	test("refuses a name that is bound this turn neither way", () => {
		const gateway = createToolGateway(() => engineFor(ADMIN_STATION));
		const ctx = { agent: agentWith([JS_TOOL]) };
		expect(() => gateway.execute("nope", "c3", {}, null, undefined, ctx)).toThrow(
			/not available/,
		);
	});
});
