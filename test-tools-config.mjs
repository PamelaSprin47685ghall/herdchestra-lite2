#!/usr/bin/env node
/**
 * 验证 scope/regret/defer/pin 工具配置包含 alwaysAvailable 标志
 */

import { readFileSync } from 'fs';

const mainContent = readFileSync('src/main.mjs', 'utf-8');

const checks = [
	{ tool: 'scope', pattern: /name:\s*"scope"[\s\S]*?alwaysAvailable:\s*true/ },
	{ tool: 'regret', pattern: /name:\s*"regret"[\s\S]*?alwaysAvailable:\s*true/ },
	{ tool: 'defer', pattern: /name:\s*"defer"[\s\S]*?alwaysAvailable:\s*true/ },
	{ tool: 'pin', pattern: /name:\s*"pin"[\s\S]*?alwaysAvailable:\s*true/ },
];

let allPassed = true;

for (const { tool, pattern } of checks) {
	const match = pattern.test(mainContent);
	console.log(`✓ ${tool}: alwaysAvailable = ${match ? 'true' : 'MISSING'}`);
	if (!match) allPassed = false;
}

if (allPassed) {
	console.log('\n✓ 所有工具都配置了 alwaysAvailable: true');
	process.exit(0);
} else {
	console.log('\n✗ 部分工具缺少 alwaysAvailable 配置');
	process.exit(1);
}
