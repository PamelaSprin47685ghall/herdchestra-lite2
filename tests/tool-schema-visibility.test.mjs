import { expect, test } from "bun:test";

import { wireTools } from "../src/tools/catalog.mjs";

/**
 * The host mounts an enabled discoverable tool under `xd://` when that
 * transport is active, which removes its schema from the request. Every tool
 * this extension registers is part of the working protocol, so each one must
 * keep its own top-level schema for a model that never calls `read xd://`.
 */
test("every registered tool keeps its schema in the top-level request", () => {
	const tools = new Map();
	wireTools({ registerTool: (tool) => tools.set(tool.name, tool) }, {});

	expect([...tools.keys()].sort()).toEqual([
		"scope_context",
		"scope_fork",
		"scope_join",
		"scope_panhandle",
		"scope_return",
		"todo",
	]);
	for (const [name, tool] of tools) {
		expect(tool.loadMode, `${name} would be mounted under xd://`).toBe("essential");
	}
});
