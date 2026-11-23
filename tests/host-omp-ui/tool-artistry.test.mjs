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
	expect(String(view.range)).toContain("10");
	expect(String(view.range)).toContain("20");
	expect(view.preview).toContain("export const a = 1");
	expect(typeof view.language).toBe("string");
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
