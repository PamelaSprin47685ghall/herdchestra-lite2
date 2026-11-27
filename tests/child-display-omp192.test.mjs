import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	CHILD_ACTIVITY_TYPE,
	captureTranscriptSubscriptions,
	childDisplayFor,
	renderChildActivity,
} from "../host-omp/src/host/child-display.mjs";

const BASE = "/home/kunweiz/.cache/.bun/install/global/node_modules/@oh-my-pi";
// The global install may carry only compiled files; these tests drive the host
// source directly, so require every module they import before opting in.
const SOURCES = [
	`${BASE}/pi-tui/src/term/paint.ts`,
	`${BASE}/pi-tui/src/term/backend.ts`,
	`${BASE}/pi-tui/src/theme/loader.ts`,
	`${BASE}/pi-tui/src/term/painters/checklist.ts`,
	`${BASE}/pi-coding-agent/src/ui/extensions/render-output.tsx`,
	`${BASE}/pi-coding-agent/src/ui/styles/messages/assistant.ts`,
	`${BASE}/pi-coding-agent/src/ui/styles/messages/frame.ts`,
	`${BASE}/pi-coding-agent/src/ui/shell/transcript.tsx`,
	`${BASE}/pi-coding-agent/src/ui/transcript/messages/assistant-message.tsx`,
];
const available =
	existsSync(`${BASE}/pi-tui/package.json`) &&
	existsSync(`${BASE}/pi-coding-agent/package.json`) &&
	SOURCES.every((path) => existsSync(path));
const run = available ? test : test.skip;

class FakeSession {
	#listeners = new Set();
	subscribe(listener) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	emit(event) {
		for (const listener of this.#listeners) listener(event);
	}
}
captureTranscriptSubscriptions(FakeSession.prototype);

run("scope header renders cleanly under omp 19.2 pi-tui", async () => {
	const tui = await import(`${BASE}/pi-tui`);
	const { paintNode } = await import(`${BASE}/pi-tui/src/term/paint.ts`);
	const { loadThemeSync } = await import(`${BASE}/pi-tui/src/theme/loader.ts`);
	const { extensionOutput } = await import(`${BASE}/pi-coding-agent/src/ui/extensions/render-output.tsx`);
	await import(`${BASE}/pi-tui/src/term/painters/checklist.ts`);
	await import(`${BASE}/pi-coding-agent/src/ui/styles/messages/assistant.ts`);
	await import(`${BASE}/pi-coding-agent/src/ui/styles/messages/frame.ts`);

	const theme = loadThemeSync("dark");
	const env = { theme: () => theme, clock: () => 0, focus: () => null, reduceMotion: () => true, hyperlinks: () => false };
	const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

	const headerNode = renderChildActivity({ details: { label: "Worker" } }, { expanded: false }, theme, tui);
	const errors = [];
	const output = extensionOutput(headerNode, { onError: (error) => errors.push(String(error)) });
	expect(tui.isUiNode(output)).toBe(true);
	expect(errors).toHaveLength(0);
	expect(paintNode(env, headerNode, 80).rows.map(strip).join("\n")).toContain("Worker");
});

run("a retired todo tool no longer paints a card, and long child thinking streams end-to-end without stopping mid-stream", async () => {
	const tui = await import(`${BASE}/pi-tui`);
	const { TermBackend } = await import(`${BASE}/pi-tui/src/term/backend.ts`);
	const { loadThemeSync } = await import(`${BASE}/pi-tui/src/theme/loader.ts`);
	const { Transcript } = await import(`${BASE}/pi-coding-agent/src/ui/shell/transcript.tsx`);
	const { AssistantMessageBlock } = await import(`${BASE}/pi-coding-agent/src/ui/transcript/messages/assistant-message.tsx`);
	await import(`${BASE}/pi-tui/src/term/painters/checklist.ts`);
	await import(`${BASE}/pi-coding-agent/src/ui/styles/messages/assistant.ts`);
	await import(`${BASE}/pi-coding-agent/src/ui/styles/messages/frame.ts`);

	const theme = loadThemeSync("dark");
	const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
	const historyRows = [];
	let latestViewport = [];

	const transcript = new Transcript();
	const surface = tui.createSurface(() => ({
		main: transcript.nodes,
		dock: [],
		layer: [],
	}));
	const driver = {
		columns: 80,
		rows: 12,
		capabilities: { hyperlinks: false, textSizing: false },
		onInput: () => () => {},
		onResize: () => () => {},
		onCapabilities: () => () => {},
		onReplay: () => () => {},
		present(plan) {
			if (plan.history) {
				if (plan.history.kind === "replay") historyRows.length = 0;
				historyRows.push(...plan.history.rows.map(strip));
			}
			latestViewport = plan.viewport.map(strip);
			return plan.history?.id;
		},
	};
	const backend = new TermBackend({
		surface,
		driver,
		theme: () => theme,
		separator: transcript.separator,
		clock: () => 0,
		frameInterval: 0,
	});
	transcript.attach({
		retired: (node) => backend.retired(node),
		replayHistory: () => {},
		redescribe: () => {},
	});
	backend.start();

	const root = new FakeSession();
	const child = new FakeSession();
	let activeAssistant = null;
	let todoBlock = null;

	root.subscribe((event) => {
		if (event.type === "message_start" && event.message?.customType === CHILD_ACTIVITY_TYPE) {
			const block = transcript.append(() => renderChildActivity(event.message, { expanded: false }, theme, tui));
			transcript.settle(block);
			if (event.message.details?.todo) todoBlock = block;
			return;
		}
		if (event.type === "message_start" && event.message?.role === "assistant") {
			const message = tui.signal(event.message);
			const transient = tui.signal(true);
			const finalized = tui.signal(false);
			const model = {
				message,
				transient,
				finalized,
				hideThinking: () => false,
				expandThinking: () => true,
				proseOnlyThinking: false,
				showImages: () => false,
				renderSvg: () => false,
				renderEmbeds: () => false,
				figureCell: () => ({ width: 8, height: 16 }),
				embedHost: { cwd: () => process.cwd(), capturePage: async () => null },
				showToolResultImages: () => false,
				tableCharts: () => false,
				toolResultMedia: () => new Map(),
				linkTargets: () => new Map(),
				errorExpanded: () => false,
				errorPinned: () => false,
				cacheInvalidation: () => undefined,
				servedModelMismatch: () => undefined,
				turnUsage: () => undefined,
				rewound: () => false,
				thinkingRate: () => 0,
				actions: false,
				textRenderers: () => [],
				thinkingRenderers: () => [],
			};
			const block = transcript.append(() => tui.jsx(AssistantMessageBlock, { model }));
			activeAssistant = { block, message, transient, finalized };
			return;
		}
		if (event.type === "message_update" && event.message?.role === "assistant" && activeAssistant) {
			activeAssistant.message.set(event.message);
			return;
		}
		if (event.type === "message_end" && event.message?.role === "assistant" && activeAssistant) {
			activeAssistant.transient.set(false);
			activeAssistant.message.set(event.message);
			activeAssistant.finalized.set(true);
			transcript.settle(activeAssistant.block);
			activeAssistant = null;
		}
	});

	const display = childDisplayFor(root);
	display.attach("Subscope", child);

	// 1. A synthetic todo event no longer produces a card: `todo` is not a
	// bound capability, so nothing stays pinned at the top of the viewport.
	root.emit({ type: "tool_execution_start", toolCallId: "todo-1", toolName: "todo", args: { op: "init" } });
	root.emit({
		type: "tool_execution_end",
		toolCallId: "todo-1",
		toolName: "todo",
		args: { op: "init" },
		result: {
			content: [{ type: "text", text: "ok" }],
			details: {
				op: "init",
				phases: [{ name: "计划", tasks: [{ content: "根任务一", status: "in_progress" }, { content: "根任务二", status: "pending" }] }],
			},
		},
		isError: false,
	});
	backend.renderNow();
	expect(todoBlock ?? null).toBeNull();

	// 2. Child streams 30 paragraphs of thinking far taller than the 12-row viewport.
	child.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	let accumulated = "";
	for (let i = 1; i <= 30; i += 1) {
		const chunk = (i === 1 ? "" : "\n\n") + `思考段落${i}`;
		accumulated += chunk;
		child.emit({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "thinking", thinking: accumulated }] },
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 0,
				delta: chunk,
				partial: { role: "assistant", content: [{ type: "thinking", thinking: accumulated }] },
			},
		});
		backend.renderNow();
	}

	// Root todo has retired cleanly into scrollback (not pinned at top of viewport).
	expect(todoBlock).toBeNull();
	// A retired `todo` card leaves no history row behind: there is nothing to
	// retire, which is the point of dropping the capability.
	expect(historyRows.join("\n")).not.toContain("根任务一");
	expect(latestViewport.join("\n")).not.toContain("根任务一");

	// Live thinking continues showing the newest tail while settled earlier
	// thinking paragraphs retire smoothly into scrollback — never frozen mid-way.
	expect(activeAssistant).not.toBeNull();
	expect(tui.isSettled(activeAssistant.block.node)).toBe(false);
	expect(latestViewport.join("\n")).toContain("思考段落30");
	expect(historyRows.join("\n")).toContain("思考段落1");

	child.emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: accumulated },
				{ type: "text", text: "子任务完成结论" },
			],
		},
	});
	backend.renderNow();
	expect(latestViewport.join("\n")).toContain("子任务完成结论");

	backend.stop();
	surface.dispose();
});
