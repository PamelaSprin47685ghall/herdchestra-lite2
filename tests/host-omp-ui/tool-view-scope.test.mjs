// The browser mapper mirrors `host-omp-ui/src/station/domain/tool-artistry.mjs`
// without importing it: the web bundle must stay independent of the extension
// process. Two copies means two chances to drift, and a drift here is visible
// only in the browser — a live call renders one way and the same call rebuilt
// from history renders another. These cases pin the half that only the web
// bundle can prove: the scope control plane and the `js` inner-call walk.

import { expect, test } from "bun:test";

const MODULE = "../../host-omp-ui/web/src/protocol/tool-view.ts";

async function load() {
	return import(MODULE);
}

function tool(name, args, text = "", isError = false) {
	return {
		id: `id-${name}`,
		name,
		status: isError ? "failed" : "completed",
		args,
		result: { content: [{ type: "text", text }] },
	};
}

test("the web mapper walks js inner calls into real cards", async () => {
	const { describeTool } = await load();
	const view = describeTool({
		...tool(
			"js",
			{ code: "await api.write('src/c.mjs', inputs.body)" },
			"> await AsyncFunction('api','state','inputs',code)(api,state,inputs)\nok",
		),
		details: {
			innerCalls: [
				{ id: "tc1#0", name: "write", args: { path: "src/c.mjs", content: "export const c = 3;" }, resultText: "ok" },
				{ id: "tc1#1", name: "read", args: { path: "src/d.mjs" }, resultText: "export const d = 4;" },
			],
		},
	});

	expect(view.kind).toBe("eval");
	if (view.kind !== "eval") return;
	expect(view.output).toBe("ok");
	expect(view.children?.map((child) => child.kind)).toEqual(["write", "read"]);
	expect(view.children?.[0].path).toBe("src/c.mjs");
});

test("the web mapper gives the scope control plane cards, not JSON", async () => {
	const { describeTool } = await load();

	const request = describeTool(
		tool("scope_request", { target: "/api", message: "登录字段名？", interrupt: true }, "accessToken"),
	);
	expect(request.kind).toBe("ask");
	if (request.kind !== "ask") return;
	expect(request.title).toContain("/api");
	expect(request.summary).toContain("interrupt");
	expect(request.summary).toContain("登录字段名？");
	expect(request.summary).toContain("accessToken");

	const reply = describeTool(tool("scope_reply", { text: "accessToken" }, "ok"));
	expect(reply.kind).toBe("ask");
	if (reply.kind === "ask") expect(reply.summary).toContain("accessToken");

	const fork = describeTool(
		tool(
			"scope_fork",
			{ forks: [{ scopeId: "api", fsm: "S1 read → S2 write" }, { scopeId: "ui" }] },
			"Started (2): /api, /ui",
		),
	);
	expect(fork.kind).toBe("task");
	if (fork.kind !== "task") return;
	expect(fork.agent).toBe("scope_fork");
	expect(fork.title).toBe("scope_fork (2)");
	expect(fork.prompt.split("\n")).toEqual(["api — S1 read → S2 write", "ui"]);
	expect(fork.result).toContain("/api");

	const join = describeTool(tool("scope_join", {}, "History only; do not re-execute it."));
	expect(join.kind).toBe("task");
	if (join.kind === "task") {
		expect(join.agent).toBe("scope_join");
		expect(join.prompt).toBe("");
		expect(join.result).toContain("History only");
	}

	const rewind = describeTool(tool("scope_return", { dafny: "done" }, "rewound"));
	expect(rewind.kind).toBe("task");
	if (rewind.kind === "task") expect(rewind.prompt).toBe("rewind");

	const seal = describeTool(
		tool(
			"scope_return",
			{ dafny: "done", signed_sealed_hands_off_nothing_left_on_the_table: "a_ferocious_audacious_master_would_change_nothing" },
			"sealed",
		),
	);
	expect(seal.kind).toBe("task");
	if (seal.kind === "task") expect(seal.prompt).toBe("seal");
});
