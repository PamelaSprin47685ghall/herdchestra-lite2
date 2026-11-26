// Tool cards are where a chat UI either feels native or feels like a JSON
// viewer. The mapper owns the difference: it turns an omp tool call plus its
// result into the small set of shapes the DeerFlow cards can render.
//
// Inputs are pinned here so the renderer and the mapper cannot drift:
//   toolCall  = { name: string, args: Record<string, unknown> }
//   toolResult = { content: Array<{ type: "text", text: string }>, isError?: boolean }

import { expect, test } from "bun:test";

const MODULE = "../../host-omp-ui/src/station/domain/tool-artistry.mjs";

async function load() {
	return import(MODULE);
}

function call(name, args, text = "", isError = false) {
	return [
		{ name, args },
		{ content: [{ type: "text", text }], isError },
	];
}

test("read becomes a file preview with path, range and language", async () => {
	const { describeToolCall } = await load();
	const view = describeToolCall(...call("read", { path: "src/a.mjs", offset: 10, limit: 20, description: "Read a" }, "export const a = 1;\n"));
	expect(view.kind).toBe("read");
	expect(view.path).toBe("src/a.mjs");
	// limit counts lines: offset 10 plus 20 lines ends at line 29.
	expect(view.range).toBe("10-29");
	expect(describeToolCall(...call("read", { path: "src/a.mjs" }, "")).range).toBe("1-");
	expect(view.preview).toContain("export const a = 1");
	expect(typeof view.language).toBe("string");
});

test("read range never fabricates a line number from a malformed argument", async () => {
	const { describeToolCall } = await load();
	const path = "src/a.mjs";
	for (const args of [
		{ path, offset: "x", limit: 20 },
		{ path, offset: 10, limit: "x" },
		{ path, offset: -1, limit: 20 },
		{ path, offset: 10, limit: 1.5 },
		{ path, offset: 10, limit: -2 },
	]) {
		expect(describeToolCall(...call("read", args, "")).range).toBe("");
	}
	expect(describeToolCall(...call("read", { path, offset: undefined, limit: undefined }, "")).range).toBe("1-");
	expect(describeToolCall(...call("read", { path, offset: "10", limit: "20" }, "")).range).toBe("10-29");
});

test("write and edit become diff-bearing file changes", async () => {
	const { describeToolCall } = await load();
	const write = describeToolCall(...call("write", { path: "src/b.mjs", content: "export const b = 2;" }, "ok"));
	expect(write.kind).toBe("write");
	expect(write.path).toBe("src/b.mjs");
	expect(write.artifact.path).toBe("src/b.mjs");
	expect(write.diff.added).toBeGreaterThan(0);

	const edit = describeToolCall(
		...call("edit", { path: "src/a.mjs", old_string: "a\nb", new_string: "a\nB\nc" }, "ok"),
	);
	expect(edit.kind).toBe("edit");
	expect(edit.path).toBe("src/a.mjs");
	expect(edit.diff.added).toBe(2);
	expect(edit.diff.removed).toBe(1);
	expect(edit.diff.hunks.length).toBeGreaterThan(0);
	expect(edit.artifact.path).toBe("src/a.mjs");

	const patch = describeToolCall(...call("apply_patch", { path: "src/c.mjs", patch: "*** Begin Patch" }, "ok"));
	expect(["write", "edit"]).toContain(patch.kind);
	expect(patch.path).toBe("src/c.mjs");
});

test("bash strips ANSI, keeps the command, and truncates a long stream", async () => {
	const { describeToolCall } = await load();
	const view = describeToolCall(...call("bash", { command: "echo hi", description: "Say hi" }, "\x1b[32mhi\x1b[0m"));
	expect(view.kind).toBe("bash");
	expect(view.command).toBe("echo hi");
	expect(view.output).toBe("hi");
	expect(view.language).toBe("bash");
	expect(view.isError).toBe(false);

	const long = "x".repeat(20_000);
	const truncated = describeToolCall(...call("bash", { command: "yes" }, long));
	expect(truncated.truncated).toBe(true);
	expect(truncated.output.length).toBeLessThan(20_000);

	const failed = describeToolCall(...call("bash", { command: "false" }, "exit 1", true));
	expect(failed.isError).toBe(true);
});

test("eval carries its language and output", async () => {
	const { describeToolCall } = await load();
	const view = describeToolCall(...call("eval", { language: "python", code: "print(1)" }, "1"));
	expect(view.kind).toBe("eval");
	expect(view.language).toBe("python");
	expect(view.output).toContain("1");
});

test("search tools become one compact search shape", async () => {
	const { describeToolCall } = await load();
	for (const name of ["grep", "glob", "find", "ast_grep"]) {
		const view = describeToolCall(...call(name, { pattern: "foo", path: "src" }, "src/a.mjs:12:foo"));
		expect(view.kind).toBe("search");
		expect(view.pattern).toBe("foo");
		expect(view.path).toBe("src");
		expect(String(view.summary)).toContain("src/a.mjs");
	}
});

test("web tools expose safe links", async () => {
	const { describeToolCall } = await load();
	const search = describeToolCall(
		...call("web_search", { query: "omp" }, '{"results":[{"title":"OMP","url":"https://example.com/omp"}]}'),
	);
	expect(search.kind).toBe("web");
	expect(search.query).toBe("omp");
	expect(search.links.some((link) => String(link).includes("https://example.com/omp"))).toBe(true);

	const fetch = describeToolCall(...call("web_fetch", { url: "https://example.com" }, "# Example"));
	expect(fetch.kind).toBe("web");
	expect(fetch.url).toBe("https://example.com");
});

test("todo, task and ask keep their distinct identities", async () => {
	const { describeToolCall } = await load();
	const todo = describeToolCall(
		...call("todo", { phases: [{ name: "Todos", tasks: [{ content: "map", status: "pending" }] }] }, "ok"),
	);
	expect(todo.kind).toBe("todo");
	expect(String(todo.summary)).toContain("Todos");

	const task = describeToolCall(
		...call("task", { description: "Explore", prompt: "go", subagent_type: "explore" }, "done"),
	);
	expect(task.kind).toBe("task");
	expect(task.agent).toBe("explore");
	expect(task.description).toBe("Explore");
	expect(task.prompt).toBe("go");
	expect(task.status).toBe("completed");
	expect(String(task.result)).toContain("done");

	const ask = describeToolCall(...call("ask", { html: "<form><input name='x'></form>" }, "answered"));
	expect(ask.kind).toBe("ask");
	expect(ask.summary).toBeTruthy();
});

test("an unknown or MCP tool keeps args and result readable and prefers args.description", async () => {
	const { describeToolCall } = await load();
	const view = describeToolCall(
		...call("mcp__demo_echo", { description: "Echo a value", value: "x" }, "x"),
	);
	expect(view.kind).toBe("generic");
	expect(view.name).toBe("mcp__demo_echo");
	expect(view.description).toBe("Echo a value");
	expect(view.argsText).toContain("value");
	expect(view.resultText).toBe("x");
	expect(view.isError).toBe(false);
});

test("a js card renders one child per inner call and strips the REPL echo", async () => {
	const { describeToolCall } = await load();
	const toolResult = {
		content: [
			{
				type: "text",
				text: "> await AsyncFunction('api', 'state', 'inputs', code)(api, state, inputs)\nwrote 1 file",
			},
		],
		details: {
			innerCalls: [
				{ name: "write", args: { path: "src/a.mjs", content: "export const a = 1;" }, resultText: "ok" },
				{ name: "bash", args: { command: "false" }, resultText: "exit 1", isError: true },
			],
		},
	};
	const view = describeToolCall({ name: "js", args: { code: "await api.write(...)" } }, toolResult);
	expect(view.kind).toBe("eval");
	// The echo line already travelled in the arguments; only the output is shown.
	expect(view.output).toBe("wrote 1 file");
	expect(view.children).toHaveLength(2);
	expect(view.children[0].kind).toBe("write");
	expect(view.children[0].path).toBe("src/a.mjs");
	expect(view.children[1].kind).toBe("bash");
	expect(view.children[1].isError).toBe(true);
});

test("a write inside js reaches the artifact drawer exactly like a direct write", async () => {
	const { extractArtifacts } = await load();
	const items = [
		{ toolCall: { name: "read", args: { path: "src/b.mjs" } }, toolResult: { content: [] } },
		{
			toolCall: { name: "js", args: { code: "await api.write('src/a.mjs', ...)" } },
			toolResult: {
				content: [{ type: "text", text: "> await AsyncFunction(\nok" }],
				details: {
					innerCalls: [{ name: "write", args: { path: "src/a.mjs", content: "export const a = 1;" } }],
				},
			},
		},
	];
	const artifacts = extractArtifacts(items);
	const written = artifacts.find((artifact) => artifact.path === "src/a.mjs");
	expect(written).toBeDefined();
	expect(written.kind).toBe("write");
	expect(written.content).toContain("export const a = 1");
	// First call that names a path wins: the earlier read stays first.
	expect(artifacts[0].path).toBe("src/b.mjs");
});

test("a js card without inner calls renders no children", async () => {
	const { describeToolCall } = await load();
	const view = describeToolCall(...call("js", { code: "1 + 1" }, "> await AsyncFunction(\n2"));
	expect(view.children).toEqual([]);
	expect(view.output).toBe("2");
});

test("scope_request reads as a question and shows the answer when it returns", async () => {
	const { describeToolCall } = await load();
	const waiting = describeToolCall(
		...call("scope_request", { target: "/api", message: "字段名是 token 还是 accessToken？", interrupt: true }, ""),
	);
	expect(waiting.kind).toBe("ask");
	expect(waiting.title).toBe("scope_request → /api");
	expect(waiting.summary).toContain("字段名是 token 还是 accessToken？");
	expect(waiting.summary).toContain("interrupt");

	const polite = describeToolCall(...call("scope_request", { target: "/ui", message: "进度？", interrupt: false }, ""));
	expect(polite.summary).toBe("→ /ui: 进度？");

	// The same card carries the reply once the call has returned: one block
	// reads top to bottom as the whole exchange.
	const answered = describeToolCall(
		...call("scope_request", { target: "/api", message: "字段名？" }, "accessToken，见 src/auth.mjs:42"),
	);
	expect(answered.summary).toContain("→ /api: 字段名？");
	expect(answered.summary).toContain("← accessToken，见 src/auth.mjs:42");
});

test("scope_reply reads as an answer", async () => {
	const { describeToolCall } = await load();
	const reply = describeToolCall(...call("scope_reply", {}, "accessToken，见 src/auth.mjs:42"));
	expect(reply.kind).toBe("ask");
	expect(reply.title).toBe("scope_reply");
	expect(reply.summary).toBe("← accessToken，见 src/auth.mjs:42");
});

test("scope_fork lists the batch and scope_join shows the record it brought", async () => {
	const { describeToolCall } = await load();
	const fork = describeToolCall(
		...call(
			"scope_fork",
			{ forks: [{ scopeId: "api", fsm: "S1 audit\nS2 fix" }, { scopeId: "ui", fsm: "polish" }] },
			"Started (2): /api, /ui",
		),
	);
	expect(fork.kind).toBe("task");
	expect(fork.title).toBe("scope_fork (2)");
	expect(fork.agent).toBe("scope_fork");
	expect(fork.prompt).toContain("api — S1 audit");
	expect(fork.prompt).toContain("ui — polish");
	expect(fork.result).toContain("Started (2)");

	const join = describeToolCall(...call("scope_join", {}, "Record from /api: done"));
	expect(join.kind).toBe("task");
	expect(join.title).toBe("scope_join");
	expect(join.result).toContain("Record from /api");

	// A description wins the title, as it does for every other card.
	const described = describeToolCall(...call("scope_fork", { description: "Split the audit", forks: [] }, ""));
	expect(described.title).toBe("Split the audit");
	expect(described.title).not.toBe("scope_fork (0)");
});

test("scope_return tells a rewind from a seal and names the scope", async () => {
	const { describeToolCall } = await load();
	const rewind = describeToolCall(...call("scope_return", { scope: "/api", dafny: "finished the audit" }, "Rewound."));
	expect(rewind.kind).toBe("task");
	expect(rewind.title).toBe("scope_return /api");
	expect(rewind.prompt).toBe("rewind");
	expect(rewind.result).toBe("Rewound.");

	const seal = describeToolCall(
		...call(
			"scope_return",
			{
				dafny: "nothing left",
				signed_sealed_hands_off_nothing_left_on_the_table: "a_ferocious_audacious_master_would_change_nothing",
			},
			"Sealed.",
		),
	);
	expect(seal.title).toBe("scope_return");
	expect(seal.prompt).toBe("seal");
});

test("extractArtifacts deduplicates file changes for the artifact drawer", async () => {
	const { extractArtifacts } = await load();
	const items = [
		{ toolCall: { name: "write", args: { path: "src/a.mjs", content: "one" } }, toolResult: { content: [] } },
		{ toolCall: { name: "write", args: { path: "src/a.mjs", content: "two" } }, toolResult: { content: [] } },
		{ toolCall: { name: "read", args: { path: "src/b.mjs" } }, toolResult: { content: [] } },
	];
	const artifacts = extractArtifacts(items);
	expect(artifacts.filter((artifact) => artifact.path === "src/a.mjs")).toHaveLength(1);
	expect(artifacts.some((artifact) => artifact.path === "src/b.mjs")).toBe(true);
});

test("stripAnsi removes SGR and OSC without touching plain text", async () => {
	const { stripAnsi } = await load();
	expect(stripAnsi("\x1b[31mred\x1b[0m plain")).toBe("red plain");
	expect(stripAnsi("\x1b]0;title\x07hello")).toBe("hello");
	expect(stripAnsi("plain")).toBe("plain");
});

test("computeLineDiff counts added and removed lines", async () => {
	const { computeLineDiff } = await load();
	const diff = computeLineDiff("a\nb\nc", "a\nB\nc\nd");
	expect(diff.added).toBe(2);
	expect(diff.removed).toBe(1);
	expect(diff.hunks.length).toBeGreaterThan(0);
});

// A script's work lives in `details.innerCalls`, not in the outer call. If the
// mapper stopped walking that field, a write performed inside a script would
// disappear from both its card and the artifact drawer, while every direct
// write stayed visible — a silent loss with no error anywhere.
test("js inner calls become their own cards and reach the artifact drawer", async () => {
	const { describeToolCall, extractArtifacts } = await load();
	const toolCall = { name: "js", args: { code: "await api.write('src/c.mjs', inputs.body)" } };
	const toolResult = {
		content: [{ type: "text", text: "> await AsyncFunction('api','state','inputs',code)(api,state,inputs)\nok" }],
		isError: false,
		details: {
			innerCalls: [
				{
					id: "tc1#0",
					name: "write",
					args: { path: "src/c.mjs", content: "export const c = 3;" },
					resultText: "ok",
				},
				{ id: "tc1#1", name: "read", args: { path: "src/d.mjs" }, resultText: "export const d = 4;" },
			],
		},
	};

	const view = describeToolCall(toolCall, toolResult);
	expect(view.kind).toBe("eval");
	// The echoed invocation already travelled in `code`; only output belongs here.
	expect(view.output).toBe("ok");
	expect(view.children.map((child) => child.kind)).toEqual(["write", "read"]);
	expect(view.children[0].artifact.path).toBe("src/c.mjs");

	const artifacts = extractArtifacts([{ toolCall, toolResult }]);
	expect(artifacts.map((artifact) => artifact.path)).toEqual(["src/c.mjs", "src/d.mjs"]);
	expect(artifacts[0].content).toBe("export const c = 3;");
	expect(artifacts[0].kind).toBe("write");
});

// Rebuilding from history must produce the same cards as the live stream: the
// block carries `details` only because the pairing copies it, so this pins the
// handoff between transcript-model and the mapper.
test("js without innerCalls renders one card and no children", async () => {
	const { describeToolCall } = await load();
	const view = describeToolCall(
		{ name: "js", args: { code: "return 1 + inputs.one" } },
		{ content: [{ type: "text", text: "> await AsyncFunction('api','state','inputs',code)(api,state,inputs)\n2" }] },
	);
	expect(view.kind).toBe("eval");
	expect(view.output).toBe("2");
	expect(view.children).toEqual([]);
});

// Once every native tool hides behind `js`, the scope tools are what the model
// calls on most turns. Leaving them to the generic card puts raw JSON in the
// transcript exactly where the user is watching the orchestration happen.
test("the scope control plane gets question, answer and subtask cards", async () => {
	const { describeToolCall } = await load();

	const request = describeToolCall(
		...call("scope_request", { target: "/api", message: "登录字段名？", interrupt: true }, "accessToken"),
	);
	expect(request.kind).toBe("ask");
	expect(request.title).toContain("/api");
	expect(request.summary).toContain("interrupt");
	expect(request.summary).toContain("登录字段名？");
	expect(request.summary).toContain("accessToken");

	const reply = describeToolCall(...call("scope_reply", { text: "accessToken" }, "ok"));
	expect(reply.kind).toBe("ask");
	expect(reply.summary).toContain("accessToken");

	const fork = describeToolCall(
		...call(
			"scope_fork",
			{ forks: [{ scopeId: "api", fsm: "S1 read → S2 write" }, { scopeId: "ui" }] },
			"Started (2): /api, /ui",
		),
	);
	expect(fork.kind).toBe("task");
	expect(fork.agent).toBe("scope_fork");
	expect(fork.prompt.split("\n")).toEqual(["api — S1 read → S2 write", "ui"]);
	expect(fork.result).toContain("/api");

	const join = describeToolCall(...call("scope_join", {}, "History only; do not re-execute it."));
	expect(join.kind).toBe("task");
	expect(join.agent).toBe("scope_join");
	expect(join.prompt).toBe("");
	expect(join.result).toContain("History only");

	const rewind = describeToolCall(...call("scope_return", { dafny: "done" }, "rewound"));
	expect(rewind.kind).toBe("task");
	expect(rewind.prompt).toBe("rewind");
	const seal = describeToolCall(
		...call(
			"scope_return",
			{ dafny: "done", signed_sealed_hands_off_nothing_left_on_the_table: "a_ferocious_audacious_master_would_change_nothing" },
			"sealed",
		),
	);
	expect(seal.prompt).toBe("seal");
});
