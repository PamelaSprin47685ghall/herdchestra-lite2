/**
 * Real omp 19.2.0 TUI rendering contract. When the global upstream install is
 * available, the renderer output must be accepted by extensionOutput() and
 * painted without any default custom-message card frame.
 */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createActivityStore, renderActiveToolTray, renderBroadcastMessage, renderChildActivity } from "../host-omp/src/host/activity-render.mjs";

const BASE = "/home/kunweiz/.cache/.bun/install/global/node_modules/@oh-my-pi";
const TUI = `${BASE}/pi-tui`;
const AGENT = `${BASE}/pi-coding-agent`;
const available = existsSync(`${TUI}/package.json`) && existsSync(`${AGENT}/package.json`);
const run = available ? test : test.skip;
const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
const hasBox = (rows) => rows.some((row) => /[╭╮╰╯│]/.test(row));

function frameCustom(tui, node) {
	return tui.jsx("col", { role: "omp.custom", children: [node] });
}

run("19.2.0 renders live child thinking in place with no custom card frame", async () => {
	const tuiModule = await import(TUI);
	const { paintNode } = await import(`${TUI}/src/term/paint.ts`);
	const { loadThemeSync } = await import(`${TUI}/src/theme/loader.ts`);
	const { isUiNode } = tuiModule;
	const { extensionOutput } = await import(`${AGENT}/src/ui/extensions/render-output.tsx`);
	await import(`${AGENT}/src/ui/styles/messages/assistant.ts`);
	await import(`${AGENT}/src/ui/styles/messages/frame.ts`);
	const theme = loadThemeSync("dark");
	const env = { theme: () => theme, clock: () => 0, focus: () => null, reduceMotion: () => true, hyperlinks: () => false };
	const errors = [];
	const full = "我先读取上游源码确认渲染管线";

	const store = createActivityStore([{ kind: "thinking", text: "我" }], true, tuiModule);
	const message = {
		role: "custom",
		customType: "herd.fork-activity",
		content: "Oh My Pie\n我",
		details: { label: "Oh My Pie", body: "我", parts: [{ kind: "thinking", text: "我" }], store },
	};
	const node = renderChildActivity(message, { expanded: false }, theme, tuiModule);
	expect(isUiNode(node)).toBe(true);
	expect(extensionOutput(node, { onError: (error) => errors.push(String(error)) })).toBe(node);
	expect(errors).toHaveLength(0);

	let rows = paintNode(env, frameCustom(tuiModule, node), 80).rows;
	expect(hasBox(rows.map(strip))).toBe(false);
	expect(rows.map(strip).join("\n")).not.toContain("herd.fork-activity");
	expect(rows.map(strip).join("\n")).toContain("我");

	store.update([{ kind: "thinking", text: full }], true);
	rows = paintNode(env, frameCustom(tuiModule, node), 80).rows;
	const painted = rows.map(strip).join("\n");
	expect(painted).toContain(full);
	expect(painted).not.toContain("只显示第一个词");
	expect(rows.join("")).toContain("\x1b[3m");

	const reopened = renderChildActivity(message, { expanded: true }, theme, tuiModule);
	const reopenedRows = paintNode(env, frameCustom(tuiModule, reopened), 80).rows.map(strip).join("\n");
	expect(reopenedRows).toContain(full);
	expect(hasBox(paintNode(env, frameCustom(tuiModule, reopened), 80).rows.map(strip))).toBe(false);

	store.update([{ kind: "thinking", text: full }], false);
	expect(store.snapshot().live).toBe(false);
	expect(store.slots()[0].live()).toBe(false);
});

run("19.2.0 accepts broadcast, tool and widget nodes without errors", async () => {
	const tuiModule = await import(TUI);
	const { paintNode } = await import(`${TUI}/src/term/paint.ts`);
	const { loadThemeSync } = await import(`${TUI}/src/theme/loader.ts`);
	const { isUiNode } = tuiModule;
	const { extensionOutput } = await import(`${AGENT}/src/ui/extensions/render-output.tsx`);
	await import(`${AGENT}/src/ui/styles/messages/assistant.ts`);
	await import(`${AGENT}/src/ui/styles/messages/frame.ts`);
	const theme = loadThemeSync("dark");
	const env = { theme: () => theme, clock: () => 0, focus: () => null, reduceMotion: () => true, hyperlinks: () => false };
	const errors = [];
	const accept = (node) => extensionOutput(node, { onError: (error) => errors.push(String(error)) });

	const broadcast = renderBroadcastMessage({ content: "(broadcast to 2 flows)\n\noperator note" }, tuiModule);
	expect(isUiNode(broadcast)).toBe(true);
	expect(accept(broadcast)).toBe(broadcast);
	const broadcastRows = paintNode(env, broadcast, 80).rows.map(strip).join("\n");
	expect(broadcastRows).toContain("operator note");

	const toolMessage = {
		role: "custom", customType: "herd.fork-activity",
		content: "Oh My Pie\nbash · completed\nok",
		details: {
			label: "Oh My Pie", body: "bash · completed\nok",
			tool: { type: "tool_execution_end", toolName: "bash", args: { command: "echo ok" }, result: { content: [{ type: "text", text: "ok" }] }, isError: false },
		},
	};
	const toolNode = renderChildActivity(toolMessage, { expanded: false }, theme, tuiModule);
	expect(isUiNode(toolNode)).toBe(true);
	expect(accept(toolNode)).toBe(toolNode);
	const toolRows = paintNode(env, frameCustom(tuiModule, toolNode), 80).rows.map(strip);
	expect(hasBox(toolRows)).toBe(false);
	expect(toolRows.join("\n")).toContain("bash");

	const widget = renderActiveToolTray([{ label: "Oh My Pie", toolName: "bash", status: "running", partialText: "step 2/5" }], tuiModule);
	expect(isUiNode(widget)).toBe(true);
	expect(accept(widget)).toBe(widget);
	const widgetRows = paintNode(env, widget, 80).rows.map(strip);
	expect(widgetRows.join("\n")).toContain("bash");
	expect(errors).toHaveLength(0);
});
