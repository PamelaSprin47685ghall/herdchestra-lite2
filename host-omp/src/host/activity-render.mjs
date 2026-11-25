// omp 19.2 custom-message nodes. A valid UiNode takes the borderless custom
// frame; class components fall back to a titled card. Streaming updates ride
// signals so the host never sees a per-token custom message_end.

import { formatToolOutput, formatToolTarget } from "./activity.mjs";
import { batchUpdates, createReactiveSignal, getHostTui } from "./tui-runtime.mjs";

function normalizeParts(parts) {
	if (!Array.isArray(parts)) return [];
	return parts.filter((part) =>
		(part?.kind === "thinking" || part?.kind === "text") && typeof part.text === "string");
}

export function createActivityStore(initialParts = [], initialLive = false, tui = getHostTui()) {
	const slots = createReactiveSignal(tui, []);
	const live = createReactiveSignal(tui, false);
	const store = {
		slots,
		live,
		update(parts, isLive) {
			batchUpdates(tui, () => {
				const list = normalizeParts(parts);
				const streaming = Boolean(isLive);
				const previous = slots.peek();
				const reusable = previous.length === list.length
					&& previous.every((slot, index) => slot.kind === list[index].kind);
				const next = reusable ? previous : list.map((part, index) => {
					const kept = previous[index];
					if (kept?.kind === part.kind) return kept;
					return {
						kind: part.kind,
						text: createReactiveSignal(tui, part.text),
						live: createReactiveSignal(tui, false),
					};
				});
				for (let index = 0; index < list.length; index += 1) {
					const slot = next[index];
					const slotLive = streaming && index === list.length - 1;
					if (slot.text.peek() !== list[index].text) slot.text.set(list[index].text);
					if (slot.live.peek() !== slotLive) slot.live.set(slotLive);
				}
				if (!reusable) slots.set(next);
				if (live.peek() !== streaming) live.set(streaming);
			});
		},
		snapshot() {
			return {
				parts: slots.peek().map((slot) => ({ kind: slot.kind, text: slot.text.peek() })),
				live: live.peek(),
			};
		},
	};
	store.update(initialParts, initialLive);
	return store;
}

function messageText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

export function renderBroadcastMessage(message, tui = getHostTui()) {
	if (typeof tui?.jsx !== "function") return undefined;
	const content = messageText(message?.content);
	if (!content) return undefined;
	return tui.jsx("text", { text: content, wrap: true });
}

function staticParts(details, message, label) {
	if (Array.isArray(details.parts) && details.parts.length > 0) return normalizeParts(details.parts);
	let body = typeof details.body === "string" ? details.body : messageText(message?.content);
	if (label && body.startsWith(`${label}\n`)) body = body.slice(label.length + 1);
	return body ? [{ kind: "text", text: body }] : [];
}

function renderSlot(tui, slot) {
	if (slot.kind === "thinking") {
		return tui.jsx("section", {
			role: () => (slot.live() ? "omp.thinking.live" : "omp.thinking"),
			collapsible: false,
			collapsed: false,
			children: [
				tui.jsx("md", {
					text: () => slot.text(),
					stream: () => (slot.live() ? true : undefined),
				}),
			],
		});
	}
	return tui.jsx("md", {
		text: () => slot.text(),
		stream: () => (slot.live() ? true : undefined),
	});
}

function renderStaticSlot(tui, part) {
	if (part.kind === "thinking") {
		return tui.jsx("section", {
			role: "omp.thinking",
			collapsible: false,
			collapsed: false,
			children: [tui.jsx("md", { text: part.text })],
		});
	}
	return tui.jsx("md", { text: part.text });
}

function activityFrame(tui, label, bodyChildren) {
	const assistant = tui.jsx("col", { role: "omp.assistant", children: bodyChildren });
	const children = label
		? [tui.jsx("text", { spans: [{ t: label, s: "accent" }], wrap: true }), assistant]
		: [assistant];
	return tui.jsx("col", { children });
}

function renderTool(tui, tool, label, expanded) {
	const toolName = tool.toolName || "tool";
	const target = formatToolTarget(toolName, tool.args);
	const output = formatToolOutput(tool.result);
	const hasOutput = output.length > 0;
	return tui.jsx("tool", {
		name: toolName,
		title: toolName,
		target: target || undefined,
		meta: label ? [label] : undefined,
		status: tool.isError ? "error" : "done",
		tone: tool.isError ? "error" : "success",
		frame: "inline",
		collapsible: hasOutput,
		collapsed: !expanded,
		preview: hasOutput ? (expanded ? "children" : "none") : "none",
		children: hasOutput
			? tui.jsx("text", { spans: [{ t: output, s: tool.isError ? "error" : "muted" }], wrap: true })
			: undefined,
	});
}

export function renderChildActivity(message, options = {}, _theme = null, tui = getHostTui()) {
	if (typeof tui?.jsx !== "function") return undefined;
	const details = message?.details ?? {};
	const label = typeof details.label === "string" ? details.label : "";
	const expanded = Boolean(options?.expanded);
	if (details.tool && typeof details.tool === "object") return renderTool(tui, details.tool, label, expanded);
	const store = details.store;
	const body = typeof store?.slots === "function"
		? (typeof tui.For === "function"
			? tui.jsx(tui.For, { each: () => store.slots(), children: (slot) => renderSlot(tui, slot) })
			: () => store.slots().map((slot) => renderSlot(tui, slot)))
		: staticParts(details, message, label).map((part) => renderStaticSlot(tui, part));
	return activityFrame(tui, label, body);
}

export function renderActiveToolTray(entriesAccessor, tui = getHostTui()) {
	if (typeof tui?.jsx !== "function") return undefined;
	const readEntries = typeof entriesAccessor === "function" ? entriesAccessor : () => entriesAccessor ?? [];
	const renderItem = (item) => tui.jsx("tool", {
		name: item.toolName || "tool",
		title: item.toolName || "tool",
		target: item.target || undefined,
		meta: item.label ? [item.label] : undefined,
		note: item.partialText || undefined,
		status: "running",
		tone: "pending",
		frame: "inline",
		collapsed: true,
		preview: "none",
	});
	const children = typeof tui.For === "function"
		? tui.jsx(tui.For, { each: readEntries, children: renderItem })
		: () => readEntries().map(renderItem);
	return tui.jsx("col", { children });
}
