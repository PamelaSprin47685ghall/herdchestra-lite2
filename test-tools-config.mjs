#!/usr/bin/env node
/**
 * Verify the registered tool metadata.
 *
 * `alwaysAvailable` is not read by the host and must not come back. The todo
 * override must copy the native strict/exclusive metadata.
 */

import { readFileSync } from "fs";

const mainContent = readFileSync("src/main.mjs", "utf-8");

const checks = [
	{ tool: "scope", pattern: /name:\s*"scope"[\s\S]*?execute:/ },
	{ tool: "regret", pattern: /name:\s*"regret"[\s\S]*?execute:/ },
	{ tool: "defer", pattern: /name:\s*"defer"[\s\S]*?execute:/ },
	{ tool: "pin", pattern: /name:\s*"pin"[\s\S]*?execute:/ },
	{
		tool: "todo",
		pattern:
			/name:\s*"todo"[\s\S]*?concurrency:\s*"exclusive"[\s\S]*?strict:\s*true[\s\S]*?lenientArgValidation:\s*true[\s\S]*?execute:/,
	},
];

let allPassed = true;

for (const { tool, pattern } of checks) {
	const match = pattern.test(mainContent);
	console.log(`${match ? "✓" : "✗"} ${tool}: registered`);
	if (!match) allPassed = false;
}

if (/alwaysAvailable/.test(mainContent)) {
	console.log("✗ alwaysAvailable must not be registered; the host does not read it");
	allPassed = false;
} else {
	console.log("✓ alwaysAvailable is absent");
}

process.exit(allPassed ? 0 : 1);
